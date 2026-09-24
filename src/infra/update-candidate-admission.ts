import fs from "node:fs/promises";
import path from "node:path";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../config/paths.js";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import {
  redactSupportDiagnosticLine,
  redactSupportString,
} from "../logging/diagnostic-support-redaction.js";
import { tryReadJson } from "./json-files.js";
import { withTempWorkspace } from "./private-temp-workspace.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import {
  isUpdateAdmissionAuthorityEnvKey,
  parseUpdateAdmissionContext,
  type UpdateAdmissionContext,
} from "./update-admission-contract.js";
import { launchCanary, terminateCanary, waitBounded } from "./update-candidate-canary-process.js";
import { UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";
import {
  parseUpdateAdmissionVerdict,
  UPDATE_ADMISSION_PROTOCOL,
  type UpdateAdmissionVerdict,
} from "./update-run-schema.js";

const candidateRuntimeEnvKeys = new Set([
  "NODE_COMPILE_CACHE",
  "NODE_DISABLE_COMPILE_CACHE",
  "OPENCLAW_DEV_SOURCE_ROOT",
  "OPENCLAW_VERSION",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_NO_RESPAWN",
]);

export type UpdateCandidateAdmissionResult = {
  owner: "candidate" | "installed";
  verdict?: UpdateAdmissionVerdict;
  warning?: {
    code: "update-admission-unsupported-target" | "update-admission-fallback";
    message: string;
  };
  fallbackReason?: string;
};

/** Inspect the passive declaration before running any candidate lifecycle scripts. */
async function readUpdateAdmissionProtocol(candidateRoot: string): Promise<1 | undefined> {
  const manifest = await tryReadJson<unknown>(path.join(candidateRoot, "package.json"), {
    maxBytes: 1024 * 1024,
  });
  return isRecord(manifest) &&
    isRecord(manifest.openclaw) &&
    manifest.openclaw.updateAdmissionProtocol === UPDATE_ADMISSION_PROTOCOL
    ? UPDATE_ADMISSION_PROTOCOL
    : undefined;
}

/** Ask the staged package to inspect the live installation without a grant or lease. */
export async function runUpdateCandidateAdmission(params: {
  candidateRoot: string;
  context: UpdateAdmissionContext;
  nodeRunner?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  admission?: "auto" | "installed";
}): Promise<UpdateCandidateAdmissionResult> {
  const sourceEnv = params.env ?? process.env;
  if (params.admission === "installed") {
    return { owner: "installed", fallbackReason: "forced-installed" };
  }
  if ((await readUpdateAdmissionProtocol(params.candidateRoot)) === undefined) {
    return {
      owner: "installed",
      fallbackReason: "unsupported-target",
      warning: {
        code: "update-admission-unsupported-target",
        message:
          "This target does not support candidate-owned admission; the installed updater will check admission.",
      },
    };
  }
  const redaction = { env: sourceEnv, stateDir: resolveStateDir(sourceEnv) };
  const fallback = (reason: string, diagnostic?: string): UpdateCandidateAdmissionResult => ({
    owner: "installed",
    fallbackReason: reason,
    warning: {
      code: "update-admission-fallback",
      message: `Candidate admission did not return a valid verdict (${reason}); the installed updater will check admission.${diagnostic ? ` ${redactSupportDiagnosticLine(diagnostic, redaction)}` : ""}`,
    },
  });
  try {
    const context = parseUpdateAdmissionContext(params.context);
    if (!context) {
      return fallback("invalid-context");
    }
    const entry = await resolveGatewayInstallEntrypoint(params.candidateRoot);
    if (!entry) {
      return fallback("missing-entrypoint");
    }
    return await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-update-admission-" },
      async ({ dir }): Promise<UpdateCandidateAdmissionResult> => {
        const contextPath = path.join(dir, "context.json");
        // Locators describe the staged target; download credentials stay with its supervisor.
        const locator = (value: string) =>
          value.includes("://") ? redactSupportString(value, redaction) : value;
        const privateContext = {
          ...context,
          target: {
            ...context.target,
            spec: locator(context.target.spec),
            ...(context.target.tag ? { tag: locator(context.target.tag) } : {}),
          },
        };
        await fs.writeFile(contextPath, JSON.stringify(privateContext), {
          mode: 0o600,
          flag: "wx",
        });
        const env: NodeJS.ProcessEnv = { ...sourceEnv };
        // Preserve live profile selectors, but never inherit an updater continuation.
        for (const key of Object.keys(env)) {
          const normalized = key.toUpperCase();
          if (isUpdateAdmissionAuthorityEnvKey(key) || candidateRuntimeEnvKeys.has(normalized)) {
            delete env[key];
          }
        }
        // Node sees the cache policy before loading any candidate code.
        env.NODE_DISABLE_COMPILE_CACHE = "1";
        env.OPENCLAW_DEV_SOURCE_ROOT = params.candidateRoot;
        if (context.target.version !== null) {
          env.OPENCLAW_VERSION = context.target.version;
        }
        env.OPENCLAW_NO_RESPAWN = "1";
        const budget = resolveTimerTimeoutMs(
          params.timeoutMs ?? context.request.timeoutMs,
          120_000,
        );
        const deadline = Date.now() + budget;
        const cleanupBudget = Math.min(2_000, Math.floor(budget / 10));
        const running = launchCanary({
          entry,
          args: ["update", "admit", "--context", contextPath],
          root: params.candidateRoot,
          env,
          nodeRunner: params.nodeRunner,
          stateDir: redaction.stateDir,
          capture: () => {},
        });
        let outcome: Awaited<ReturnType<typeof waitBounded<number | null>>>;
        try {
          outcome = await waitBounded(running.result, budget - cleanupBudget);
        } finally {
          await terminateCanary(running.child, running.closed, deadline);
        }
        const diagnostic = running.firstStderrLine();
        if (outcome.status !== "completed") {
          return fallback("timeout", diagnostic);
        }
        if (outcome.value !== 0 && outcome.value !== 3) {
          return fallback(outcome.value === null ? "crash" : `exit-${outcome.value}`, diagnostic);
        }
        if (running.outputExceeded()) {
          return fallback("output-limit", diagnostic);
        }
        let value: unknown;
        try {
          value = JSON.parse(running.stdout());
        } catch {
          return fallback("malformed-json", diagnostic);
        }
        if (isRecord(value) && value.protocol !== UPDATE_ADMISSION_PROTOCOL) {
          return fallback("protocol-mismatch", diagnostic);
        }
        const verdict = parseUpdateAdmissionVerdict(value);
        if (!verdict || outcome.value !== (verdict.verdict === "admit" ? 0 : 3)) {
          return fallback("invalid-verdict", diagnostic);
        }
        const safe = (diagnosticText: string) =>
          redactSupportString(diagnosticText, redaction, {
            maxLength: UPDATE_RUN_TEXT_LIMIT - 3,
            truncationSuffix: "...",
          });
        return {
          owner: "candidate",
          verdict: {
            ...verdict,
            reasons: verdict.reasons.map((reason) => {
              const redacted: UpdateAdmissionVerdict["reasons"][number] = {
                code: reason.code,
                message: safe(reason.message),
              };
              if (reason.nextAction) {
                redacted.nextAction = safe(reason.nextAction);
              }
              return redacted;
            }),
            warnings: verdict.warnings.map((warning) => ({
              code: warning.code,
              message: safe(warning.message),
            })),
            facts: {
              ...verdict.facts,
              ...(verdict.facts.nodeEngines !== undefined
                ? { nodeEngines: safe(verdict.facts.nodeEngines) }
                : {}),
              checks: verdict.facts.checks.map((check) => {
                const redacted: UpdateAdmissionVerdict["facts"]["checks"][number] = {
                  name: check.name,
                  status: check.status,
                };
                if (check.detail) {
                  redacted.detail = safe(check.detail);
                }
                return redacted;
              }),
            },
          },
        };
      },
    );
  } catch (error) {
    return fallback("internal-error", error instanceof Error ? error.message : String(error));
  }
}
