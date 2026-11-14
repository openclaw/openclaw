import type { ImageContent } from "../llm/types.js";

export type PluginHookBeforeModelResolveAttachment = {
  kind: "image" | "video" | "audio" | "document" | "other";
  mimeType?: string;
};

export type PluginHookBeforeModelResolveEvent = {
  /** User prompt for this run. No session messages are available yet in this phase. */
  prompt: string;
  /** Attachment metadata for file-aware model routing. */
  attachments?: PluginHookBeforeModelResolveAttachment[];
};

export type PluginHookBeforeModelResolveResult = {
  /** Override the model for this agent run. E.g. "llama3.3:8b" */
  modelOverride?: string;
  /** Override the provider for this agent run. E.g. "local-provider" */
  providerOverride?: string;
  /** Replace this run's fallback chain. An empty list disables model fallback. */
  fallbacksOverride?: string[];
};

/**
 * Host-owned session continuity for this turn, as decided by the runtime's session owner.
 * Reports facts only; it carries no transcript content and grants nothing.
 */
export type PluginHookPromptContinuity = {
  /** `invalidated`: a stored native session binding was discarded for this turn. */
  state: "fresh" | "resumed" | "invalidated";
  /** Runtime reason for `invalidated`, e.g. `prompt-tools`, `auth-profile`, `missing-transcript`. */
  invalidatedReason?: string;
  /** Prior conversation the host placed in this request: content, an omission notice, or nothing. */
  history: "included" | "withheld" | "none";
};

export type PluginHookBeforePromptBuildEvent = {
  prompt: string;
  /** Current request before projection. Empty means no textual request; omission is legacy. */
  currentUserMessage?: string;
  /** Stable native admission identity across rebuilds; differs between admitted requests. */
  currentUserMessageId?: string;
  /**
   * Model-context history: fresh array/envelopes per dispatch, shared frozen transcript payloads.
   * Treat nested content as read-only; strict-mode writes to frozen leaves throw TypeError.
   * Return result fields to contribute context. Array/envelope edits stay local to this dispatch,
   * whose handlers share them in priority order; they never update core history.
   */
  messages: unknown[];
  /** Authorized phase only, on runtimes that report it. Omitted means unknown. */
  continuity?: PluginHookPromptContinuity;
};

export type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  /**
   * Narrows the tools submitted to the model for this turn.
   * An empty array disables optional tools; omitted leaves the existing tool policy unchanged.
   */
  toolsAllow?: string[];
  /**
   * Prepended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  prependSystemContext?: string;
  /**
   * Appended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  appendSystemContext?: string;
};

/** Event payload for the before_agent_run gate hook. */
export type PluginHookBeforeAgentRunEvent = {
  /** The user's message that triggered this run. */
  prompt: string;
  /** Prepared current-turn images, including prompt-local references. Absent on older hosts. */
  images?: ImageContent[];
  /** Loaded session history before the current prompt is submitted. */
  messages: unknown[];
  /** Active system prompt prepared for this run. */
  systemPrompt?: string;
  /** Account identity when available. */
  accountId?: string;
  /** Channel the message came from. */
  channelId?: string;
  /** Sender identity when available. */
  senderId?: string;
  /** Trusted sender identity bit when available. */
  senderIsOwner?: boolean;
};
