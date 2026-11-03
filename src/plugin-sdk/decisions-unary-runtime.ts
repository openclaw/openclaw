import type { DecisionExecutionContext } from "../decisions/execution-types.js";
import type { ProviderDecisionOutcomeV2 } from "../decisions/provider-outcomes.js";
import { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";
import {
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "./fetch-runtime.js";
import {
  fetchWithProviderHttpGuard,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
} from "./provider-http.js";
import { parseRetryAfterHeaderSeconds } from "./retry-runtime.js";

/** Host-prepared unary transport; never resolves credentials or changes provider protocols. */
export type DecisionJsonExecution = DecisionExecutionContext & {
  body: string;
  apiKey: string;
  successStatus?: number;
  prepareTransport: () => ReturnType<typeof resolveProviderHttpRequestConfig> & {
    url: string;
    reflectsCredential: (value: string) => boolean;
  };
  decode: (payload: Record<string, unknown>) => ProviderDecisionOutcomeV2;
};

export async function executeDecisionJsonRequest(
  execution: DecisionJsonExecution,
): Promise<ProviderDecisionOutcomeV2> {
  execution.signal.throwIfAborted();
  if (!execution.apiKey) {
    return { status: "unavailable", reason: "credentials-unavailable" };
  }
  const timeoutMs = execution.deadlineMonotonicMs - performance.now();
  if (timeoutMs <= 0) {
    return { status: "unavailable", reason: "transport" };
  }
  const { signal: timeoutSignal, cleanup } = buildTimeoutAbortSignal({
    signal: execution.signal,
    timeoutMs,
    operation: "Native decision",
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
    if (!admitted || performance.now() >= execution.deadlineMonotonicMs) {
      throw new Error("Native decision is no longer admitted.");
    }
  };
  try {
    const { url, headers, dispatcherPolicy, allowPrivateNetwork, reflectsCredential } =
      execution.prepareTransport();
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
      if (
        !response.ok ||
        (execution.successStatus !== undefined && response.status !== execution.successStatus)
      ) {
        await response.body?.cancel();
        const seconds = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
        return {
          status: "unavailable",
          reason:
            response.status === 401 || response.status === 403
              ? "authentication"
              : response.status === 429
                ? "rate-limited"
                : [400, 413, 422].includes(response.status)
                  ? "unsupported-input"
                  : "transport",
          ...(response.status === 429 && seconds !== undefined
            ? { retryAfterMs: seconds * 1000 }
            : {}),
        };
      }
      let payload: Record<string, unknown>;
      try {
        payload = await readProviderJsonObjectResponse(response, "Native decision", {
          maxBytes: 1_048_576,
          signal,
          requestHeaders: headers,
        });
      } catch {
        signal.throwIfAborted();
        return { status: "unavailable", reason: "invalid-response" };
      }
      assertActive();
      const serialized = JSON.stringify(payload);
      if (serialized.includes(execution.apiKey) || reflectsCredential(serialized)) {
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
