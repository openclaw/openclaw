import type { ResolvedProviderAuth } from "../agents/model-auth-runtime-shared.js";
import type { ModelProviderRequestTransportOverrides } from "../agents/provider-request-config.types.js";
import type { DecisionExecutionContext, DecisionReasoning } from "../decisions/execution-types.js";
import {
  decodeOpenAIDecisionResult,
  encodeOpenAIDecisionRequest,
  supportsOpenAIDecisionBatch,
} from "../decisions/openai-codec.js";
import type { DecisionProviderV2 } from "../decisions/provider-types.js";
import type { DecisionBatchV2, ProviderDecisionOutcomeV2 } from "../decisions/types-v2.js";
import type { ModelRequestHeaders } from "../llm/types.js";
import { getModelProviderRequestTransport } from "./agent-harness-runtime.js";
import { buildTimeoutAbortSignal } from "./extension-shared.js";
import {
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "./fetch-runtime.js";
import {
  createProviderCredentialMatcher,
  fetchWithProviderHttpGuard,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
} from "./provider-http.js";
import { parseRetryAfterHeaderSeconds } from "./retry-runtime.js";

export { supportsOpenAIDecisionBatch } from "../decisions/openai-codec.js";

type Context = Parameters<DecisionProviderV2["evaluate"]>[1];

/** Retain the supported prepared-context entry point as a projection into explicit execution. */
export async function evaluateOpenAICompatibleDecision(
  batch: DecisionBatchV2,
  context: Context,
  route: { provider: string; baseUrl: string; modelId?: string },
): Promise<ProviderDecisionOutcomeV2> {
  return executeOpenAIDecision(batch, {
    provider: route.provider,
    modelId: route.modelId ?? context.model.id,
    baseUrl: route.baseUrl,
    headers: context.model.headers,
    auth: context.auth,
    request: getModelProviderRequestTransport(context.model),
    signal: context.signal,
    deadlineMonotonicMs: context.deadlineMonotonicMs,
    isAdmissible: context.isAdmissible,
    reasoning: context.reasoning,
  });
}

export type OpenAIDecisionExecution = DecisionExecutionContext & {
  readonly provider: string;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly headers?: ModelRequestHeaders | undefined;
  readonly auth: Readonly<Pick<ResolvedProviderAuth, "apiKey" | "mode">>;
  readonly request?: ModelProviderRequestTransportOverrides | undefined;
  readonly reasoning?: DecisionReasoning | undefined;
};

/** Execute typed Decisions with host-prepared auth and a provider-owned effective API prefix.
 * Never selects credentials, collects conversation history, or falls back to chat. */
export async function executeOpenAIDecision(
  batch: DecisionBatchV2,
  execution: OpenAIDecisionExecution,
): Promise<ProviderDecisionOutcomeV2> {
  execution.signal.throwIfAborted();
  if (!supportsOpenAIDecisionBatch(batch, execution.reasoning)) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const auth = execution.auth;
  if (auth.mode !== "api-key" || !auth.apiKey) {
    return { status: "unavailable", reason: "credentials-unavailable" };
  }
  const timeoutMs = execution.deadlineMonotonicMs - performance.now();
  if (timeoutMs <= 0) {
    return { status: "unavailable", reason: "transport" };
  }
  const { signal: timeoutSignal, cleanup } = buildTimeoutAbortSignal({
    signal: execution.signal,
    timeoutMs,
    operation: "OpenAI decision",
  });
  const signal = timeoutSignal ?? execution.signal;
  let admissionError: { error: unknown } | undefined;
  const assertActive = () => {
    signal.throwIfAborted();
    let admitted: boolean;
    try {
      admitted = execution.isAdmissible();
    } catch (error) {
      admissionError = { error };
      throw error;
    }
    if (performance.now() >= execution.deadlineMonotonicMs || !admitted) {
      throw new Error("OpenAI decision is no longer admitted.");
    }
  };
  try {
    const preparedRequest = execution.request;
    const { baseUrl, headers, dispatcherPolicy, allowPrivateNetwork } =
      resolveProviderHttpRequestConfig({
        baseUrl: execution.baseUrl,
        defaultBaseUrl: execution.baseUrl,
        defaultHeaders: {
          // Prepared auth overrides already own the header; never restore a removed bearer.
          ...(!preparedRequest?.auth || preparedRequest.auth.mode === "provider-default"
            ? { Authorization: `Bearer ${auth.apiKey}` }
            : {}),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        headers: execution.headers,
        request: preparedRequest
          ? {
              proxy: preparedRequest.proxy,
              tls: preparedRequest.tls,
              allowPrivateNetwork: preparedRequest.allowPrivateNetwork,
            }
          : undefined,
        provider: execution.provider,
        capability: "other",
        transport: "http",
      });
    const url = `${baseUrl.replace(/\/$/, "")}/decisions`;
    const request = {
      url,
      signal,
      beforeRequest: assertActive,
      maxRedirects: 0,
      dispatcherPolicy,
      policy: { allowPrivateNetwork },
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(encodeOpenAIDecisionRequest(batch, execution.modelId)),
      },
    };
    const { response, release } = await fetchWithProviderHttpGuard(
      !dispatcherPolicy && shouldUseEnvHttpProxyForUrl(url)
        ? withTrustedEnvProxyGuardedFetchMode(request)
        : request,
    );
    try {
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) {
          return { status: "unavailable", reason: "authentication" };
        }
        if (response.status === 429) {
          const seconds = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
          return {
            status: "unavailable",
            reason: "rate-limited",
            ...(seconds === undefined ? {} : { retryAfterMs: seconds * 1000 }),
          };
        }
        return {
          status: "unavailable",
          reason: [400, 413, 422].includes(response.status) ? "unsupported-input" : "transport",
        };
      }
      let payload: Record<string, unknown>;
      try {
        payload = await readProviderJsonObjectResponse(response, "OpenAI decision", {
          maxBytes: 1_048_576,
          signal,
          requestHeaders: headers,
        });
      } catch {
        signal.throwIfAborted();
        return { status: "unavailable", reason: "invalid-response" };
      }
      assertActive();
      // Vendor-controlled names/model strings must not reflect the active credential.
      const serialized = JSON.stringify(payload);
      if (
        serialized.includes(auth.apiKey) ||
        createProviderCredentialMatcher({
          headers,
          request: preparedRequest,
          configuredHeaderNames: Object.keys(execution.headers ?? {}),
          defaultAuthHeader: "Authorization",
          defaultAuthPrefix: "Bearer ",
        })(serialized)
      ) {
        return { status: "unavailable", reason: "invalid-response" };
      }
      return decodeOpenAIDecisionResult(batch, payload);
    } finally {
      await release();
    }
  } catch {
    execution.signal.throwIfAborted();
    if (admissionError) {
      throw admissionError.error;
    }
    return { status: "unavailable", reason: "transport" };
  } finally {
    cleanup();
  }
}
