import type { AsyncPluginHook } from "./hook-handler.types.js";

/** Explicit Stop contract: a user or operator stopped agent runs on purpose. */
export type PluginHookRunStoppedEvent = {
  /**
   * Who asked to stop: `channel` for a chat message such as `/stop`, `client` for a Gateway
   * client such as the Control UI, a native app, or `chat.abort`.
   */
  source: "channel" | "client";
  /** Agent sessions this Stop covers. A channel Stop can cover more than one conversation. */
  sessions: Array<{ agentId: string; sessionKey: string }>;
  /** Runs this Stop cancels. Empty when the Stop dropped only queued work. */
  runIds: string[];
};

/** Set only when the Stop covers exactly one session; `event.sessions` always lists them all. */
type PluginHookRunStoppedContext = {
  agentId?: string;
  sessionKey?: string;
};

export type PluginHookRunStoppedHandler = AsyncPluginHook<
  PluginHookRunStoppedEvent,
  PluginHookRunStoppedContext
>;
