import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { cloneEnvWithPlatformSemantics } from "../../config/env-vars.js";
import { createConfigIO } from "../../config/io.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { isUpdateAdmissionAuthorityEnvKey } from "../../infra/update-admission-contract.js";
import { checkUpdateCandidate } from "../../infra/update-candidate-check.js";
import { redactSupportDiagnosticLine } from "../../logging/diagnostic-support-redaction.js";
import { resolveCommandProcessSignal, withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { withArtifactPreservingStateReads } from "../../state/artifact-preserving-state-reads.js";
import { parseUpdateTimeoutMs } from "./shared.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

/**
 * Candidate-owned inspection for external supervisors; never admits a mutable update.
 * It proves the readable config and the candidate's recovery runtime. Doctor and
 * Gateway startup are proven after activation, where the supervisor owns rollback.
 */
export async function updatePreflightCommand(
  options: {
    sourceRoot?: string;
    timeout?: string;
  } = {},
): Promise<void> {
  const receipt = {
    protocol: 1,
    mode: "preflight",
    coverage: "candidate-runtime",
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
    // Protocol-1 supervisors still pass --source-root; the runtime check needs no serving plugins.
    if (options.sourceRoot && !path.isAbsolute(options.sourceRoot)) {
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
            // A parse/include/read failure leaves no input for the candidate's Doctor.
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
            const result = await checkUpdateCandidate({
              root,
              env,
              stateDir: resolveStateDir(env),
              nodeRunner: process.execPath,
              timeoutMs,
              signal: resolveCommandProcessSignal(),
              requireRuntime: true,
            });
            if (result.status !== "ok") {
              for (const step of result.steps) {
                defaultRuntime.error(
                  redactSupportDiagnosticLine(step.stderrTail ?? "Update checks failed.", {
                    env,
                    stateDir: resolveStateDir(env),
                  }),
                );
              }
              return {
                status: "blocked" as const,
                phase: "runtime",
                reason: "runtime-check-failed",
              };
            }
            return { status: "ready" as const, phase: "runtime" };
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
