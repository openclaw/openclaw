import { resolveStateDir } from "../../config/paths.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { UPDATE_RUN_TEXT_LIMIT } from "../../infra/update-run-limits.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateDisplayProgress } from "./progress.js";
import type { UpdateCommandOptions } from "./shared.js";

/**
 * The canary computes a step's duration and its owner-classified diagnostics for
 * the display path only, so a failed run loses the per-phase breakdown that
 * explains where validation time went. Carry the already-computed summary into
 * the ledger. Values are truncated to the persisted text budget; nothing here
 * performs additional measurement or I/O.
 */
function summarizeCandidateStep(step: UpdateStepResult): string | undefined {
  const diagnostics = step.diagnostics?.filter((entry) => entry.trim());
  const source = diagnostics?.length ? diagnostics.join(" | ") : step.stdoutTail?.trim();
  if (!source) {
    return undefined;
  }
  return source.length > UPDATE_RUN_TEXT_LIMIT ? source.slice(0, UPDATE_RUN_TEXT_LIMIT) : source;
}

export function validateUpdateCandidateWithProgress(
  params: Pick<Parameters<typeof validateUpdateCandidateCanary>[0], "root" | "config"> & {
    env: NodeJS.ProcessEnv;
    assertCurrent: () => void;
  },
  execution: {
    packageUpdateNodeRunner?: string;
    timeoutMs?: number;
    opts: Pick<UpdateCommandOptions, "json">;
    progress: UpdateDisplayProgress;
  },
  run: UpdateCommandOptions["run"],
) {
  return validateUpdateCandidateCanary({
    ...params,
    stateDir: resolveStateDir(params.env),
    nodeRunner: execution.packageUpdateNodeRunner,
    timeoutMs: execution.timeoutMs,
    onProgress: (step) => {
      params.assertCurrent();
      if (run) {
        recordUpdateRunStep(run.runId, step, { env: run.env });
      }
      defaultRuntime[execution.opts.json ? "error" : "log"](
        `${step.step}: ${step.detail ?? step.status}`,
      );
    },
    onStep: (step) => {
      if (run) {
        // Attribution only, and never at the cost of the update: the ledger can
        // refuse a write (step retention limits) and must not fail validation.
        try {
          const endedAtMs = Date.now();
          const detail = summarizeCandidateStep(step);
          recordUpdateRunStep(
            run.runId,
            {
              step: step.name,
              status: "completed",
              startedAtMs: endedAtMs - Math.max(0, step.durationMs),
              endedAtMs,
              exitCode: step.exitCode,
              ...(detail ? { detail } : {}),
            },
            { env: run.env },
          );
        } catch {
          // Display reporting below remains the source of truth for this step.
        }
      }
      execution.progress?.onStepComplete?.({ ...step, index: 0, total: 0 });
    },
  });
}
