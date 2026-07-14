// AI safety/quality event type contracts for the diagnostic taxonomy.
// Re-exported from diagnostic-events.ts as part of DiagnosticEventPayload.

import type { DiagnosticTraceContext } from "./diagnostic-trace-context.js";

/** Schema version for AI safety/quality event payloads. Bump on breaking changes. */
export const AI_SAFETY_EVENT_SCHEMA_VERSION = 1;

type DiagnosticAISafetyBaseFields = {
  ts: number;
  seq: number;
  trace?: DiagnosticTraceContext;
};

/** Emitted when a prompt injection signal is detected in model input or tool output. */
export type DiagnosticPromptInjectionSignalEvent = DiagnosticAISafetyBaseFields & {
  type: "ai_safety.prompt_injection.signal";
  sessionId: string;
  agentId?: string;
  severity: "info" | "warn" | "error" | "critical";
  category: "direct" | "indirect" | "jailbreak" | "role_override" | "unknown";
  actionTaken: "blocked" | "flagged" | "allowed" | "redacted";
  sourceType: "user_input" | "tool_output" | "model_response" | "memory" | "external_content";
  channel?: string;
  /**
   * Privacy: sha256 hash of the triggering content snippet. Raw content is never included
   * in event payloads — only the hash, for correlation without content exposure.
   */
  snippetHash?: string;
};

/** Emitted when a tool policy decision is made (allow/block/approve). */
export type DiagnosticToolPolicyDecisionEvent = DiagnosticAISafetyBaseFields & {
  type: "ai_safety.tool_policy.decision";
  sessionId: string;
  agentId?: string;
  toolName: string;
  decision: "allowed" | "blocked" | "approval_required" | "approved" | "denied";
  policySource: "static_config" | "plugin" | "user_approval" | "hook";
  severity: "info" | "warn" | "error";
  channel?: string;
  reason?: string;
};

/** Emitted when external content is fetched and consumed by an agent. */
export type DiagnosticExternalContentConsumedEvent = DiagnosticAISafetyBaseFields & {
  type: "ai_safety.external_content.consumed";
  sessionId: string;
  agentId?: string;
  sourceType: "web_fetch" | "file" | "mcp_tool" | "api" | "unknown";
  trusted: boolean;
  /**
   * Privacy: sha256 hash of the fetched URL. The raw URL is never included in event
   * payloads — only the hash, for correlation without exposing potentially sensitive URLs.
   */
  urlHash?: string;
  byteSize?: number;
  channel?: string;
};

/** Emitted when structured user feedback is captured (thumbs up/down, rating, correction). */
export type DiagnosticUserFeedbackReceivedEvent = DiagnosticAISafetyBaseFields & {
  type: "ai_safety.user_feedback.received";
  sessionId: string;
  agentId?: string;
  label: "positive" | "negative" | "correction" | "flag" | "other";
  /** Normalized feedback score in the range 0.0–1.0. */
  score?: number;
  channel?: string;
};

/** Emitted when memory or context selection decisions are made. */
export type DiagnosticMemoryContextSelectionEvent = DiagnosticAISafetyBaseFields & {
  type: "ai_safety.memory_context.selected";
  sessionId: string;
  agentId?: string;
  memoryType: "short_term" | "long_term" | "project" | "workspace" | "external";
  itemCount: number;
  totalTokens?: number;
  channel?: string;
};

/** Emitted when an eval or quality check produces a result. */
export type DiagnosticEvalResultEvent = DiagnosticAISafetyBaseFields & {
  type: "ai_safety.eval.result";
  sessionId: string;
  agentId?: string;
  evalName: string;
  /** Normalized eval score in the range 0.0–1.0. */
  score: number;
  passed: boolean;
  severity: "info" | "warn" | "error" | "critical";
  channel?: string;
};

/** Union of all AI safety/quality event types. */
export type DiagnosticAISafetyEventPayload =
  | DiagnosticPromptInjectionSignalEvent
  | DiagnosticToolPolicyDecisionEvent
  | DiagnosticExternalContentConsumedEvent
  | DiagnosticUserFeedbackReceivedEvent
  | DiagnosticMemoryContextSelectionEvent
  | DiagnosticEvalResultEvent;
