import type { PluginHookAgentContext } from "./hook-agent-context.types.js";
import type { AsyncPluginHook } from "./hook-handler.types.js";

/**
 * Final embedded provider request. `payload` is provider-specific and is what the
 * transport encodes next. `messages` is a detached copy of the model-facing history,
 * including host-owned metadata such as `__openclaw.senderIsOwner`; edits to it do
 * not change the request.
 */
export type PluginHookBeforeModelRequestEvent = {
  payload: unknown;
  provider: string;
  model: string;
  messages: readonly unknown[];
};

/** Replacement payload. Return nothing to send the current payload unchanged. */
export type PluginHookBeforeModelRequestResult = { payload: unknown };

// Leaf contract: hook-types.ts imports this file, so it must not import hook-types.ts.
export type ModelRequestHooks = {
  before_model_request: AsyncPluginHook<
    PluginHookBeforeModelRequestEvent,
    PluginHookAgentContext,
    PluginHookBeforeModelRequestResult
  >;
};

export const MODEL_HOOK_METADATA = {
  before_model_request: {
    conversationAccess: true,
    promptInjection: true,
    modifyingTimeoutMs: 10_000,
  },
  model_call_started: {},
  model_call_ended: {},
  llm_input: { conversationAccess: true },
  llm_output: { conversationAccess: true },
} as const;
