// Diagnostic flag/event helpers for plugins that want narrow runtime gating.

export { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
export type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
  DiagnosticModelCallContent,
} from "../infra/diagnostic-events.js";
export type { DiagnosticModelContentCapturePolicy } from "../infra/diagnostic-llm-content.js";
export {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  hasPendingInternalDiagnosticEvent,
  isInternalDiagnosticEventMetadata,
  isDiagnosticsEnabled,
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
export { resolveDiagnosticModelContentCapturePolicy } from "../infra/diagnostic-llm-content.js";
export type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
export type {
  AISafetyEventEmitResult,
  AISafetyEventInput,
  AISafetyEventType,
} from "../plugins/safety-event-emission.js";
export type {
  AISafetyEventMetadata,
  DiagnosticAISafetyEventPayload,
  DiagnosticEvalResultEvent,
  DiagnosticExternalContentConsumedEvent,
  DiagnosticMemoryContextSelectionEvent,
  DiagnosticPromptInjectionSignalEvent,
  DiagnosticToolPolicyDecisionEvent,
  DiagnosticUserFeedbackReceivedEvent,
} from "../infra/diagnostic-events.js";
export {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
  formatDiagnosticTraceparent,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  parseDiagnosticTraceparent,
} from "../infra/diagnostic-trace-context.js";
