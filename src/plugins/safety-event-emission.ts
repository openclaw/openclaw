// Typed wrapper for plugin-emitted AI safety taxonomy events.
//
// Non-bundled plugins may only emit event types declared in their manifest
// `safetyEventTypes` field. Stream-name scoping enforcement mirrors
// agent-event-emission.ts; trust gating mirrors the bundled/external split
// established there and in security-events.ts.

import {
  emitTrustedAISafetyDiagnosticEvent,
  type DiagnosticEvalResultEvent,
  type DiagnosticExternalContentConsumedEvent,
  type DiagnosticMemoryContextSelectionEvent,
  type DiagnosticPromptInjectionSignalEvent,
  type DiagnosticToolPolicyDecisionEvent,
  type DiagnosticUserFeedbackReceivedEvent,
} from "../infra/diagnostic-events.js";

/** All AI safety event type discriminants from the taxonomy. */
export type AISafetyEventType =
  | "ai_safety.prompt_injection.signal"
  | "ai_safety.tool_policy.decision"
  | "ai_safety.external_content.consumed"
  | "ai_safety.user_feedback.received"
  | "ai_safety.memory_context.selected"
  | "ai_safety.eval.result";

/**
 * Union of all plugin-emittable AI safety event payloads. Each member maps
 * directly to the corresponding Diagnostic* type added in #107158, minus the
 * host-owned `seq` and `ts` fields which are stamped at emit time.
 */
export type AISafetyEventInput =
  | Omit<DiagnosticPromptInjectionSignalEvent, "seq" | "ts">
  | Omit<DiagnosticToolPolicyDecisionEvent, "seq" | "ts">
  | Omit<DiagnosticExternalContentConsumedEvent, "seq" | "ts">
  | Omit<DiagnosticUserFeedbackReceivedEvent, "seq" | "ts">
  | Omit<DiagnosticMemoryContextSelectionEvent, "seq" | "ts">
  | Omit<DiagnosticEvalResultEvent, "seq" | "ts">;

/** Result returned from `emitPluginSafetyEvent`. */
export type AISafetyEventEmitResult = { ok: true } | { ok: false; reason: string };

const AI_SAFETY_TYPE_PREFIX = "ai_safety.";

const VALID_AI_SAFETY_EVENT_TYPES = new Set<AISafetyEventType>([
  "ai_safety.prompt_injection.signal",
  "ai_safety.tool_policy.decision",
  "ai_safety.external_content.consumed",
  "ai_safety.user_feedback.received",
  "ai_safety.memory_context.selected",
  "ai_safety.eval.result",
]);

/**
 * Emit an AI safety taxonomy event on behalf of a plugin.
 *
 * Trust model:
 * - `trusted: true`  — bundled/core-owned plugins; any declared event type is
 *   accepted and forwarded as a trusted diagnostic event.
 * - `trusted: false` — externally-installed plugins; the event type must be
 *   listed in `declaredSafetyEventTypes` (from the plugin's manifest
 *   `safetyEventTypes` field) or the call is rejected.
 *
 * Validation:
 * - `event.type` must start with `"ai_safety."` and be one of the six
 *   canonical taxonomy types.
 * - External plugins that try to emit an undeclared type receive
 *   `{ ok: false, reason: "..." }` — the event is dropped, not swallowed
 *   silently.
 */
export function emitPluginSafetyEvent(params: {
  pluginId: string;
  event: AISafetyEventInput;
  trusted: boolean;
  /** Declared `safetyEventTypes` from the plugin manifest. Required when `trusted` is false. */
  declaredSafetyEventTypes?: readonly string[];
}): AISafetyEventEmitResult {
  const { pluginId, event, trusted, declaredSafetyEventTypes } = params;

  // Structural guard: must start with "ai_safety."
  if (!event.type.startsWith(AI_SAFETY_TYPE_PREFIX)) {
    return {
      ok: false,
      reason: `event type "${event.type}" is not a valid AI safety event type (must start with "${AI_SAFETY_TYPE_PREFIX}")`,
    };
  }

  // Must be one of the canonical taxonomy types.
  if (!VALID_AI_SAFETY_EVENT_TYPES.has(event.type as AISafetyEventType)) {
    return {
      ok: false,
      reason: `event type "${event.type}" is not a recognized AI safety taxonomy type`,
    };
  }

  // External plugins must declare the event type in their manifest.
  if (!trusted) {
    const declared = declaredSafetyEventTypes ?? [];
    if (!declared.includes(event.type)) {
      return {
        ok: false,
        reason: `plugin "${pluginId}" is not permitted to emit "${event.type}" — add it to safetyEventTypes in the plugin manifest`,
      };
    }
  }

  emitTrustedAISafetyDiagnosticEvent(event, { pluginId, trusted });

  return { ok: true };
}
