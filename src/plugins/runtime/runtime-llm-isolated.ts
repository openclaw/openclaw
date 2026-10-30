import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { IsolatedCompletionResult } from "../../agents/isolated-completion.js";
import { buildConfiguredModelCatalog } from "../../agents/model-selection-shared.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveThinkingProfile } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { boundedJsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import {
  createLlmCompleteError as completionError,
  createLlmOperatorAuthorizationError,
  isLlmOperatorAuthorizationError,
  isLlmRuntimeLifecycleFailure,
} from "./runtime-llm-error.js";
import type {
  LlmCompleteErrorCode,
  LlmCompleteParams,
  LlmIsolatedAgentRuntimeCompleteParams,
} from "./types-core.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const ISOLATED_COMPLETION_ERRORS = new Map<unknown, readonly [LlmCompleteErrorCode, string]>([
  [
    "unsupported",
    ["LLM_ISOLATED_UNSUPPORTED", "Configured agent runtime does not support isolated completion."],
  ],
  ["runtime-unavailable", ["LLM_RUNTIME_UNAVAILABLE", "Configured agent runtime is unavailable."]],
  ["input-rejected", ["LLM_ISOLATED_INPUT_REJECTED", "Isolated completion input was rejected."]],
  [
    "output-rejected",
    ["LLM_COMPLETION_OUTPUT_REJECTED", "Isolated completion output was rejected."],
  ],
]);

// Keep native and prompt-fallback schemas within the model-context budget.
const MAX_OUTPUT_SCHEMA_UTF8_BYTES = 1_024;

function selectOutputSchema(
  schema: LlmIsolatedAgentRuntimeCompleteParams["outputSchema"],
): LlmIsolatedAgentRuntimeCompleteParams["outputSchema"] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  return boundedJsonUtf8Bytes(schema, MAX_OUTPUT_SCHEMA_UTF8_BYTES).complete ? schema : undefined;
}

export function isIsolatedAgentRuntimeRequest(
  params: LlmCompleteParams,
): params is LlmIsolatedAgentRuntimeCompleteParams {
  return params.execution?.mode === "isolated-agent-runtime";
}

export function assertSupportedExecutionMode(params: LlmCompleteParams): void {
  const execution = (params as { execution?: unknown }).execution;
  if (execution === undefined) {
    return;
  }
  if (
    !execution ||
    typeof execution !== "object" ||
    Array.isArray(execution) ||
    (execution as { mode?: unknown }).mode !== "isolated-agent-runtime"
  ) {
    throw completionError(
      "LLM_ISOLATED_INPUT_REJECTED",
      'Plugin LLM completion execution.mode must be "isolated-agent-runtime" when execution is provided.',
    );
  }
  if (
    ("requiredAuthMode" in params && params.requiredAuthMode !== undefined) ||
    ("responseFormat" in params && params.responseFormat !== undefined)
  ) {
    throw completionError(
      "LLM_ISOLATED_INPUT_REJECTED",
      "Isolated agent-runtime completion does not support requiredAuthMode or responseFormat; use direct completion for provider controls.",
    );
  }
}

function resolveIsolatedTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return 30_000;
  }
  const timeoutMs = asFiniteNumber(value);
  if (
    timeoutMs === undefined ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw completionError(
      "LLM_ISOLATED_INPUT_REJECTED",
      `Isolated agent-runtime completion timeoutMs must be an integer from 1 through ${MAX_TIMER_DELAY_MS}.`,
    );
  }
  return timeoutMs;
}

export async function runIsolatedAgentRuntimeCompletion(params: {
  request: LlmIsolatedAgentRuntimeCompleteParams;
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  model: string;
  authProfileId?: string;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  assertCurrent?: () => void;
}): Promise<IsolatedCompletionResult> {
  params.assertCurrent?.();
  const request = params.request;
  if (
    request.execution?.mode !== "isolated-agent-runtime" ||
    !Array.isArray(request.messages) ||
    request.messages.length !== 1 ||
    request.messages[0]?.role !== "user" ||
    typeof request.messages[0].content !== "string"
  ) {
    throw completionError(
      "LLM_ISOLATED_INPUT_REJECTED",
      "Isolated agent-runtime completion requires exactly one user message; pass system instructions through systemPrompt.",
    );
  }
  const prompt = request.messages[0].content;
  const outputSchema = selectOutputSchema(params.request.outputSchema);
  const timeoutMs = resolveIsolatedTimeoutMs(params.request.execution.timeoutMs);
  const { cfg, agentId, provider, model } = params;
  const reasoning = params.request.reasoning;
  if (reasoning !== undefined) {
    const catalog = buildConfiguredModelCatalog({ cfg });
    const profile = resolveThinkingProfile({
      provider,
      model,
      agentRuntime: resolveEffectiveAgentRuntime({
        cfg,
        agentId,
        provider,
        modelId: model,
      }),
      ...(catalog.length > 0 ? { catalog } : {}),
    });
    if (!profile.levels.some((level) => level.id === reasoning)) {
      throw completionError(
        "LLM_ISOLATED_INPUT_REJECTED",
        `Thinking level "${reasoning}" is not supported for ${provider}/${model}. Use one of: ${profile.levels.map((level) => level.label).join(", ")}.`,
      );
    }
  }
  if (params.request.signal?.aborted) {
    throw completionError("LLM_COMPLETION_ABORTED", "Plugin LLM completion was aborted.");
  }
  const timeoutError = new Error(`Isolated completion timed out after ${timeoutMs}ms.`);
  try {
    const { runIsolatedCompletion } = await import("../../agents/isolated-completion.js");
    return await runIsolatedCompletion({
      purpose: "plugin-completion",
      config: params.cfg,
      provider: params.provider,
      model: params.model,
      authProfileId: params.authProfileId,
      operatorAuthority: params.operatorAuthority,
      mapOperatorAuthorizationError: createLlmOperatorAuthorizationError,
      assertCurrent: params.assertCurrent,
      agentId: params.agentId,
      systemPrompt: params.request.systemPrompt ?? "",
      prompt,
      timeoutMs,
      timeoutError,
      abortSignal: params.request.signal,
      thinkLevel: params.request.reasoning,
      ...(outputSchema ? { outputSchema } : {}),
      streamParams: {
        maxTokens: asFiniteNumber(params.request.maxTokens),
        temperature: asFiniteNumber(params.request.temperature),
      },
    });
  } catch (error) {
    if (isLlmOperatorAuthorizationError(error)) {
      throw error;
    }
    // Source revocation can win the abort race before the operation rechecks authority.
    try {
      params.operatorAuthority?.assertCurrent();
    } catch (authorizationError) {
      throw createLlmOperatorAuthorizationError(authorizationError);
    }
    if (isLlmRuntimeLifecycleFailure(error)) {
      throw error;
    }
    if (error === timeoutError) {
      throw completionError(
        "LLM_COMPLETION_TIMEOUT",
        `Plugin LLM completion timed out after ${timeoutMs}ms.`,
        error,
      );
    }
    if (params.request.signal?.aborted) {
      throw completionError("LLM_COMPLETION_ABORTED", "Plugin LLM completion was aborted.", error);
    }
    const isolatedError = asOptionalObjectRecord(error);
    const mappedError = ISOLATED_COMPLETION_ERRORS.get(isolatedError?.code);
    if (mappedError) {
      throw completionError(
        mappedError[0],
        typeof isolatedError?.message === "string" ? isolatedError.message : mappedError[1],
        error,
      );
    }
    throw completionError("LLM_COMPLETION_FAILED", "Plugin LLM completion failed.", error);
  }
}
