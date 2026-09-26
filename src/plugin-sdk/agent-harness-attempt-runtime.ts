/** Production-private attempt lifecycle mechanics for official harness plugins. */
export { buildCurrentInboundPrompt } from "../agents/embedded-agent-runner/run/runtime-context-prompt.js";
export {
  createAgentHarnessAttemptDeadlineController,
  type AgentHarnessAttemptTimeout,
} from "../agents/harness/attempt-deadlines.js";
export {
  createAgentHarnessAttemptCancellation,
  type AgentHarnessAttemptCancellationState,
} from "../agents/harness/attempt-cancellation.js";
export {
  emitAgentHarnessAttemptEvent,
  createAgentHarnessAttemptLifecycle,
} from "../agents/harness/attempt-events.js";
export { selectSupportedReasoningEffort } from "../agents/harness/reasoning-effort.js";

export {
  createAgentHarnessAssistantMessage,
  createAgentHarnessToolCallMessage,
  createAgentHarnessToolResultMessage,
  type AgentHarnessAssistantMessageOptions,
  type AgentHarnessMessageAttribution,
} from "../agents/harness/projection-messages.js";
export {
  NativeToolOutputAccumulator,
  formatNativeToolOutput,
  formatNativeToolSummary,
  MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM,
  TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS,
  truncateNativeToolTranscriptText,
} from "../agents/harness/projection-tool-output.js";
export { AgentHarnessProjectionSettlement } from "../agents/harness/projection-settlement.js";
export { makeZeroUsageSnapshot } from "../agents/usage.js";
export { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
