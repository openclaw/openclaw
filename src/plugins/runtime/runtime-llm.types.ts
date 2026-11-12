import type { StopReason } from "../../../packages/llm-core/src/types.js";
import type { ThinkLevel } from "../../auto-reply/thinking.shared.js";
import type { JsonSchemaObject } from "../../shared/json-schema.types.js";

export type LlmCompleteCaller = {
  kind: "plugin" | "context-engine" | "host" | "unknown";
  id?: string;
  name?: string;
};

export type LlmCompleteUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

type LlmCompleteCommonParams = {
  /** Model ref (e.g. "anthropic/claude-sonnet-4-6"); defaults to the target agent's configured model. */
  model?: string;
  /** Advisory output limit; runtime owners without an equivalent control may ignore it. */
  maxTokens?: number;
  /** Advisory sampling hint; runtime owners without an equivalent control may ignore it. */
  temperature?: number;
  /** Requested reasoning effort; the host normalizes it for the selected model. */
  reasoning?: ThinkLevel;
  systemPrompt?: string;
  signal?: AbortSignal;
  /** Human-readable reason for audit/debug output. */
  purpose?: string;
  /** Agent whose model/credentials to use. Session-bound capabilities may disallow overrides. */
  agentId?: string;
};

export type LlmIsolatedAgentRuntimeCompleteParams = LlmCompleteCommonParams & {
  /** Isolated runtimes currently accept one fresh user prompt, not a replayed chat history. */
  messages: [{ role: "user"; content: string }];
  /** Advisory final-output schema; isolated runtimes without native support may ignore it. */
  outputSchema?: JsonSchemaObject;
  execution: {
    /**
     * Fresh completion through the configured agent runtime with no supplied tools.
     * Agents API may retain service-owned helpers; it cannot guarantee zero tools.
     */
    mode: "isolated-agent-runtime";
    /** Exact credential owner. Requires host-granted plugin policy. */
    authProfileId?: string;
    timeoutMs?: number;
  };
};

export type LlmCompleteParams =
  | (LlmCompleteCommonParams & {
      messages: {
        role: "system" | "user" | "assistant";
        content: string;
      }[];
      /** Provider-native constrained-output request. Unsupported transports may ignore it. */
      responseFormat?: Record<string, unknown>;
      /** Fail before dispatch unless the exact selected credential has this host-resolved mode. */
      requiredAuthMode?: "oauth";
      execution?: undefined;
    })
  | LlmIsolatedAgentRuntimeCompleteParams;

export type LlmCompleteErrorCode =
  | "LLM_COMPLETION_NOT_AUTHORIZED"
  | "LLM_ISOLATED_INPUT_REJECTED"
  | "LLM_ISOLATED_UNSUPPORTED"
  | "LLM_RUNTIME_UNAVAILABLE"
  /** The plugin or model runtime is reloading or retired; retry from a fresh plugin operation. */
  | "LLM_RUNTIME_LIFECYCLE"
  | "LLM_COMPLETION_ABORTED"
  | "LLM_COMPLETION_TIMEOUT"
  | "LLM_COMPLETION_OUTPUT_REJECTED"
  | "LLM_COMPLETION_FAILED";

export type LlmCompleteResult = {
  text: string;
  provider: string;
  model: string;
  /** Concrete model identity returned by the provider, when available. */
  responseModel?: string;
  /** Provider terminal reason for direct completions, when available. */
  stopReason?: StopReason;
  agentId: string;
  usage: LlmCompleteUsage;
  execution:
    | {
        mode: "direct-provider";
        owner: { kind: "provider"; id: string };
      }
    | {
        mode: "isolated-agent-runtime";
        owner: { kind: "cli" | "harness"; id: string };
      };
  audit: {
    caller: LlmCompleteCaller;
    purpose?: string;
    sessionKey?: string;
  };
};
