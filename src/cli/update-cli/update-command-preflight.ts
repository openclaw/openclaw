import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { cloneEnvWithPlatformSemantics } from "../../config/env-vars.js";
import { createConfigIO } from "../../config/io.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { isUpdateAdmissionAuthorityEnvKey } from "../../infra/update-admission-contract.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import { redactSupportDiagnosticLine } from "../../logging/diagnostic-support-redaction.js";
import { resolveBundledDirFromPackageRoot } from "../../plugins/bundled-dir.js";
import { resolveCommandProcessSignal, withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { withArtifactPreservingStateReads } from "../../state/artifact-preserving-state-reads.js";
import { parseUpdateTimeoutMs } from "./shared.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

/** Candidate-owned inspection for external supervisors; never admits a mutable update. */
export async function updatePreflightCommand(
  options: {
    sourceRoot?: string;
    timeout?: string;
  } = {},
): Promise<void> {
  const receipt = {
    protocol: 1,
    mode: "preflight",
    coverage: "isolated-core-startup",
  } as const;
  let candidateVersion: string | null = null;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    if (Object.keys(process.env).some(isUpdateAdmissionAuthorityEnvKey)) {
      throw new Error("Candidate preflight requires an authority-free supervisor invocation.");
    }
    const root = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
    if (!root) {
      throw new Error("Candidate package root is unavailable.");
    }
    candidateVersion = await readPackageVersion(root, { maxBytes: 1024 * 1024 });
    if (!candidateVersion) {
      throw new Error("Candidate package version is unavailable.");
    }
    const timeoutMs = parseUpdateTimeoutMs(options.timeout);
    const sourceRoot = options.sourceRoot;
    if (sourceRoot && !path.isAbsolute(sourceRoot)) {
      throw new Error("Candidate preflight requires an absolute source package root.");
    }
    const env = cloneEnvWithPlatformSemantics(process.env);
    env.OPENCLAW_VERSION = candidateVersion;
    env.OPENCLAW_DEV_SOURCE_ROOT = root;
    env.NODE_DISABLE_COMPILE_CACHE = "1";
    delete env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    const verdict = await withOwnedManagedUpdateEnv(env, () =>
      withCommandProcessScope(
        () =>
          withArtifactPreservingStateReads(async () => {
            const snapshot = await createConfigIO({
              env,
              pluginValidation: "core-only",
              observe: false,
              shellEnvFallback: "defer",
              suppressFutureVersionWarning: true,
            }).readConfigFileSnapshot();
            // A parse/include/read failure has no resolved input for Doctor to rehearse.
            // Schema-invalid and legacy inputs remain with the candidate's repair owner.
            if (
              (snapshot.exists && !isRecord(snapshot.parsed)) ||
              (!snapshot.valid && !snapshot.sourceConfigBeforeMigrations)
            ) {
              return {
                status: "blocked" as const,
                phase: "config",
                reason: "config-source-invalid",
              };
            }
            const result = await validateUpdateCandidateCanary({
              root,
              ...(sourceRoot
                ? {
                    sourceBundledPlugins: {
                      packageRoot: sourceRoot,
                      directory: resolveBundledDirFromPackageRoot(sourceRoot),
                    },
                  }
                : {}),
              config: snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig,
              stateDir: resolveStateDir(env),
              env,
              nodeRunner: process.execPath,
              timeoutMs,
              signal: resolveCommandProcessSignal(),
            });
            // Older runtimes and advisory probe timeouts can return ok without readiness.
            const ready =
              result.status === "ok" &&
              result.phase === "readiness" &&
              result.steps.some(
                (step) =>
                  step.name === "candidate-gateway-startup" &&
                  step.exitCode === 0 &&
                  !step.advisory,
              );
            const status = result.status === "error" ? "blocked" : ready ? "ready" : "unverified";
            if (status !== "ready") {
              for (const line of result.logTail.slice(-8)) {
                defaultRuntime.error(
                  redactSupportDiagnosticLine(line, {
                    env,
                    stateDir: resolveStateDir(env),
                  }),
                );
              }
            }
            return {
              status,
              phase: result.phase,
              ...(result.status === "error"
                ? { reason: result.reason }
                : ready
                  ? {}
                  : { reason: "readiness-unverified" }),
            };
          }),
        controller.signal,
      ),
    );
    controller.signal.throwIfAborted();
    // Publish only after snapshot and child cleanup has settled, keeping stdout one document.
    defaultRuntime.writeJson({ ...receipt, candidateVersion, ...verdict });
    process.exitCode = verdict.status === "ready" ? 0 : verdict.status === "blocked" ? 3 : 2;
  } catch (error) {
    defaultRuntime.error(
      redactSupportDiagnosticLine(error instanceof Error ? error.message : String(error), {
        env: process.env,
        stateDir: resolveStateDir(process.env),
      }),
    );
    defaultRuntime.writeJson({
      ...receipt,
      candidateVersion,
      status: "unverified",
      reason: "preflight-execution-failed",
    });
    process.exitCode = 2;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
