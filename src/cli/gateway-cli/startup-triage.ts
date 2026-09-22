import { formatErrorMessage } from "../../infra/errors.js";
import type { RuntimeEnv } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";

export async function triageGatewayStartupFailure(
  runtime: RuntimeEnv,
  error: unknown,
  signal?: AbortSignal,
) {
  let triage: typeof import("../../commands/triage-failure.js");
  try {
    triage = await import("../../commands/triage-failure.js");
  } catch (importError) {
    // An in-place update can remove the old recovery chunk before a restart fails.
    runtime.error(
      `Automatic triage could not load: ${formatErrorMessage(importError)}. Run ${formatCliCommand("openclaw triage")} manually.`,
    );
    return;
  }
  await triage.triageAfterFailure(
    runtime,
    {
      kind: "gateway-startup",
      phase: "startup",
      error: formatErrorMessage(error),
      gateway: "verify-running",
    },
    signal,
  );
}
