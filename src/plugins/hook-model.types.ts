import type { PluginHookAgentContext } from "./hook-agent-context.types.js";
import type { AsyncPluginHook } from "./hook-handler.types.js";

/**
 * Final model request. On `runtime: "embedded"`, `payload` is the provider-specific body
 * the transport encodes next. On `runtime: "cli"`, the CLI backend owns its wire request,
 * so `payload` is the text OpenClaw hands it: `{ prompt, prependContext?, appendContext? }`
 * for a turn or a steered input. `messages` is a detached copy of the model-facing
 * history, including host-owned metadata such as `__openclaw.senderIsOwner` and input
 * `provenance`; edits to it do not change the request.
 *
 * `requestKind` names the call: `turn` for an agent turn (including steered CLI input),
 * `compaction` for a summary or server-side compaction request over older history. More
 * kinds may be added; treat unknown kinds like `turn`.
 *
 * This gate changes only the outgoing request. It never rewrites stored history: a value
 * redacted here is still in the transcript and reaches later requests unless they are gated
 * too. To keep a value out of history, redact it when it is written (`tool_result_persist`,
 * `before_message_write`).
 */
export type PluginHookModelRequestKind = "turn" | "compaction";

export type PluginHookBeforeModelRequestEvent = {
  runtime: "embedded" | "cli";
  requestKind: PluginHookModelRequestKind;
  payload: unknown;
  provider: string;
  model: string;
  messages: readonly unknown[];
};

/**
 * Replacement payload. Return nothing to send the current payload unchanged. A CLI
 * replacement must keep the `{ prompt, prependContext?, appendContext? }` string shape.
 */
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
