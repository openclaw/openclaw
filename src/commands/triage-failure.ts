import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { runUpdateFailureTriage } from "../infra/update-triage.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TriageFailureContext } from "./triage-prompt.js";

/** Startup failures collect diagnostics; only an operator can start a repair agent. */
export async function triageAfterFailure(
  runtime: RuntimeEnv,
  failure: TriageFailureContext,
  signal?: AbortSignal,
): Promise<void> {
  await runUpdateFailureTriage({
    mode: "non-interactive",
    runtime: {
      log: (...args) => runtime.error(...args),
      error: (...args) => runtime.error(...args),
    },
    failure: { error: `${failure.phase}: ${failure.error}` },
    target: { root: failure.installationRoot, env: { ...process.env } },
    resolveRoot: async () => (await resolveOpenClawPackageRoot({ argv1: process.argv[1] })) ?? "",
    signal,
  });
}
