import type { ResolvedProviderAuth } from "../agents/model-auth-runtime-shared.js";
import { getModelProviderRequestTransport } from "../agents/provider-request-config.js";
import type { ModelProviderRequestTransportOverrides } from "../agents/provider-request-config.types.js";
import type { DecisionExecutionContext } from "../decisions/execution-types.js";
import type { DecisionProviderContextV2 } from "../decisions/provider-context.js";
import type { ProviderDecisionOutcomeV2 } from "../decisions/provider-outcomes.js";
import type { ModelRequestHeaders } from "../llm/types.js";
import { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";
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

export type DecisionHttpExecution = DecisionExecutionContext & {
  readonly provider: string;
  readonly baseUrl: string;
  readonly headers?: ModelRequestHeaders | undefined;
  readonly auth: Readonly<Pick<ResolvedProviderAuth, "apiKey" | "mode">>;
  readonly request?: ModelProviderRequestTransportOverrides | undefined;
  readonly endpointPath: string;
  readonly body: string;
  readonly decode: (payload: Record<string, unknown>) => ProviderDecisionOutcomeV2;
};

/** Project the host-prepared context without loading a plugin's host-harness facade. */
export function evaluateDecisionHttp(
  context: DecisionProviderContextV2,
  route: Pick<DecisionHttpExecution, "provider" | "baseUrl" | "endpointPath" | "body" | "decode">,
): Promise<ProviderDecisionOutcomeV2> {
  return executeDecisionHttp({
    ...route,
    auth: context.auth,
    headers: context.model.headers,
    request: getModelProviderRequestTransport(context.model),
    signal: context.signal,
    deadlineMonotonicMs: context.deadlineMonotonicMs,
    isAdmissible: context.isAdmissible,
  });
}

/** Execute one provider-owned JSON Decision request with prepared auth and host admission. */
export async function executeDecisionHttp(
  execution: DecisionHttpExecution,
): Promise<ProviderDecisionOutcomeV2> {
  execution.signal.throwIfAborted();
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
    operation: "Decision request",
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
      throw new Error("Decision request is no longer admitted.");
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
    const url = `${baseUrl.replace(/\/$/, "")}/${execution.endpointPath}`;
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
        body: execution.body,
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
        payload = await readProviderJsonObjectResponse(response, "Decision request", {
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
      return execution.decode(payload);
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
