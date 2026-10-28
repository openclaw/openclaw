/** Lazy runtime facade for isolated cron agent execution dependencies. */
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { createLazyRuntimeMethodBinder } from "../../shared/lazy-runtime.js";
export { resolveSubagentModelFallbacksOverride } from "../../agents/agent-scope.js";
export { resolveEffectiveModelFallbacks } from "../../agents/model-selection-config.js";
export { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
export { resolveFastModeState } from "../../agents/fast-mode.js";
export { resolveCronAgentLane } from "../../agents/lanes.js";
export { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
export { isCliProvider } from "../../agents/model-selection-cli.js";
export { normalizeVerboseLevel } from "../../auto-reply/thinking.shared.js";
export { registerAgentRunContext } from "../../infra/agent-run-registry.js";
export { logWarn } from "../../logger.js";

const cronExecutionCliRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/cli-runner.runtime.js"),
);
const cli = createLazyRuntimeMethodBinder(cronExecutionCliRuntimeLoader.load);

/** Lazily resolves complete CLI bindings so cron continuations preserve reuse metadata. */
export const getCliSessionBinding = cli((runtime) => runtime.getCliSessionBinding);

/** Lazily runs the CLI-backed agent path used by isolated cron execution. */
export const runCliAgent = cli((runtime) => runtime.runCliAgent);
