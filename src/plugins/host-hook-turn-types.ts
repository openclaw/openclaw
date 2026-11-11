import type { PluginJsonValue } from "./host-hook-json.js";

/** Placement for context injected into the next agent turn. */
type PluginNextTurnInjectionPlacement = "prepend_context" | "append_context";

/** Plugin request to inject text into the next turn for a session. */
export type PluginNextTurnInjection = {
  sessionKey: string;
  /** Selected owner when the session key is unscoped, such as global. */
  agentId?: string;
  text: string;
  idempotencyKey?: string;
  placement?: PluginNextTurnInjectionPlacement;
  ttlMs?: number;
  metadata?: PluginJsonValue;
};

/** Stored next-turn injection after session/plugin metadata is attached. */
export type PluginNextTurnInjectionRecord = Omit<
  PluginNextTurnInjection,
  "sessionKey" | "agentId"
> & {
  id: string;
  pluginId: string;
  pluginName?: string;
  createdAt: number;
  placement: PluginNextTurnInjectionPlacement;
};

/** Result returned after enqueueing a next-turn injection. */
export type PluginNextTurnInjectionEnqueueResult = {
  enqueued: boolean;
  id: string;
  sessionKey: string;
};

/** Event passed to plugins before an agent turn is prepared. */
export type PluginAgentTurnPrepareEvent = {
  prompt: string;
  /**
   * Model-context history: fresh array/envelopes per dispatch, shared frozen transcript payloads.
   * Treat nested content as read-only; strict-mode writes to frozen leaves throw TypeError.
   * Return result fields to contribute context. Array/envelope edits stay local to this dispatch,
   * whose handlers share them in priority order; they never update core history.
   */
  messages: unknown[];
  queuedInjections: PluginNextTurnInjectionRecord[];
};

/** Plugin contribution to prepend or append context for a prepared agent turn. */
export type PluginAgentTurnPrepareResult = {
  prependContext?: string;
  appendContext?: string;
};

/** Event passed to plugins that contribute heartbeat prompt context. */
export type PluginHeartbeatPromptContributionEvent = {
  sessionKey?: string;
  agentId?: string;
  heartbeatName?: string;
};

/** Plugin contribution to heartbeat prompt context. */
export type PluginHeartbeatPromptContributionResult = PluginAgentTurnPrepareResult;
