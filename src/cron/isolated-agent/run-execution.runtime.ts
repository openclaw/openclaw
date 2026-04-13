export { resolveEffectiveModelFallbacks } from "../../agents/agent-scope.js";
export { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
export { resolveFastModeState } from "../../agents/fast-mode.js";
export { resolveNestedAgentLane } from "../../agents/lanes.js";
export { LiveSessionModelSwitchError } from "../../agents/live-model-switch.js";
export { runWithModelFallback } from "../../agents/model-fallback.js";
export { isCliProvider } from "../../agents/model-selection.js";
export { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
export {
  countActiveDescendantRuns,
  listDescendantRunsForRequester,
} from "../../agents/subagent-registry.js";
export { normalizeVerboseLevel } from "../../auto-reply/thinking.js";
export { resolveSessionTranscriptPath } from "../../config/sessions.js";
export { registerAgentRunContext } from "../../infra/agent-events.js";
export { logWarn } from "../../logger.js";

let cronExecutionCliRuntimePromise:
  | Promise<typeof import("./run-execution-cli.runtime.js")>
  | undefined;

async function loadCronExecutionCliRuntime() {
  cronExecutionCliRuntimePromise ??= import("./run-execution-cli.runtime.js");
  return await cronExecutionCliRuntimePromise;
}

export async function getCliSessionId(
  ...args: Parameters<typeof import("../../agents/cli-session.js").getCliSessionId>
): Promise<ReturnType<typeof import("../../agents/cli-session.js").getCliSessionId>> {
  const runtime = await loadCronExecutionCliRuntime();
  return runtime.getCliSessionId(...args);
}

export async function runCliAgent(
  ...args: Parameters<typeof import("../../agents/cli-runner.js").runCliAgent>
): ReturnType<typeof import("../../agents/cli-runner.js").runCliAgent> {
  const runtime = await loadCronExecutionCliRuntime();
  return runtime.runCliAgent(...args);
}
