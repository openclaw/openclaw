import type { ResolvedProviderAuth } from "../agents/model-auth-runtime-shared.js";
import { getModelProviderRequestTransport } from "../agents/provider-request-config.js";
import type { ModelProviderRequestTransportOverrides } from "../agents/provider-request-config.types.js";
import type { DecisionExecutionContext } from "../decisions/execution-types.js";
import type { DecisionProviderContextV2 } from "../decisions/provider-context.js";
import type {
  ProviderDecisionOutcomeV2,
  ProviderFailureReason,
} from "../decisions/provider-outcomes.js";
import type { ModelRequestHeaders } from "../llm/types.js";
import { buildTimeoutAbortSignal } from "../utils/fetch-timeout.js";
import {
  responseWithRelease,
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "./fetch-runtime.js";
import {
  createProviderCredentialMatcher,
  fetchWithProviderHttpGuard,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfigWithOriginTrust,
  resolveProviderTransportSsrFPolicy,
} from "./provider-http.js";
import { parseRetryAfterHeaderSeconds } from "./retry-runtime.js";

export type DecisionHttpUnavailable = Extract<ProviderDecisionOutcomeV2, { status: "unavailable" }>;

/** Provider-owned facts for one Decision HTTP request. */
export type DecisionHttpRoute<T> = {
  readonly provider: string;
  /** API prefix; `endpointPath` is appended to it. */
  readonly baseUrl: string;
  readonly endpointPath: string;
  /** Serialized JSON request. Omit for a GET request. */
  readonly body?: string;
  /** Auth headers for the active credential. Defaults to `Authorization: Bearer <key>`. */
  readonly authHeaders?: (apiKey: string) => ModelRequestHeaders;
  /** Non-secret headers that describe this body; they win, and `null` removes one. */
  readonly requestHeaders?: ModelRequestHeaders;
  /** Decodes the bounded JSON response. A throw means an invalid response. */
  readonly decode: (payload: unknown) => T | DecisionHttpUnavailable;
  /** Documented provider statuses that differ from the shared mapping. */
  readonly statusReason?: (status: number) => ProviderFailureReason | undefined;
  readonly maxResponseBytes?: number;
};

export type DecisionHttpExecution<T> = DecisionExecutionContext &
  DecisionHttpRoute<T> & {
    readonly auth: Readonly<Pick<ResolvedProviderAuth, "apiKey" | "mode">>;
    readonly headers?: ModelRequestHeaders | undefined;
    readonly request?: ModelProviderRequestTransportOverrides | undefined;
  };

/** Project the host-prepared context without loading a plugin's host-harness facade. */
export function evaluateDecisionHttp<T = ProviderDecisionOutcomeV2>(
  context: DecisionProviderContextV2,
  route: DecisionHttpRoute<T>,
): Promise<T | DecisionHttpUnavailable> {
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

function unavailable(reason: ProviderFailureReason): DecisionHttpUnavailable {
  return { status: "unavailable", reason };
}

function failureForStatus(
  response: Response,
  statusReason: DecisionHttpRoute<unknown>["statusReason"],
) {
  const { status } = response;
  const reason =
    statusReason?.(status) ??
    (status === 401 || status === 403
      ? "authentication"
      : status === 429
        ? "rate-limited"
        : status === 400 || status === 413 || status === 422
          ? "unsupported-input"
          : "transport");
  if (reason !== "rate-limited") {
    return unavailable(reason);
  }
  const header = response.headers.get("retry-after-ms")?.trim();
  const milliseconds = header ? Number(header) : Number.NaN;
  const seconds = parseRetryAfterHeaderSeconds(response.headers.get("retry-after"));
  const retryAfterMs =
    Number.isFinite(milliseconds) && milliseconds >= 0
      ? milliseconds
      : seconds === undefined
        ? undefined
        : seconds * 1000;
  return { ...unavailable(reason), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

/**
 * Execute one provider-owned JSON Decision request with prepared auth.
 * Admission is checked once when the request starts; a request that passed may finish.
 */
export async function executeDecisionHttp<T = ProviderDecisionOutcomeV2>(
  execution: DecisionHttpExecution<T>,
): Promise<T | DecisionHttpUnavailable> {
  execution.signal.throwIfAborted();
  const { auth, request: preparedRequest } = execution;
  if (auth.mode !== "api-key" || !auth.apiKey) {
    return unavailable("credentials-unavailable");
  }
  const timeoutMs = execution.deadlineMonotonicMs - performance.now();
  // A thrown caller authority assertion is terminal and passes through.
  if (timeoutMs <= 0 || !execution.isAdmissible()) {
    return unavailable("transport");
  }
  const { signal: timeoutSignal, cleanup } = buildTimeoutAbortSignal({
    signal: execution.signal,
    timeoutMs,
    operation: `${execution.provider} decision`,
  });
  const signal = timeoutSignal ?? execution.signal;
  try {
    const base = new URL(execution.baseUrl);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      return unavailable("transport");
    }
    const {
      baseUrl,
      headers,
      dispatcherPolicy,
      allowPrivateNetwork,
      trustConfiguredBaseUrlOrigin,
    } = resolveProviderHttpRequestConfigWithOriginTrust({
      baseUrl: execution.baseUrl,
      defaultBaseUrl: execution.baseUrl,
      defaultHeaders: {
        // Prepared auth overrides already own the header; never restore a removed credential.
        ...(!preparedRequest?.auth || preparedRequest.auth.mode === "provider-default"
          ? (execution.authHeaders?.(auth.apiKey) ?? { Authorization: `Bearer ${auth.apiKey}` })
          : {}),
        ...(execution.body === undefined ? {} : { "Content-Type": "application/json" }),
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
    const perRequest = Object.entries(execution.requestHeaders ?? {});
    for (const [name, value] of perRequest) {
      if (value === null) {
        headers.delete(name);
      } else {
        headers.set(name, value);
      }
    }
    // Per-request values describe the body; the credential matcher must never collect them.
    const credentialHeaders = new Headers(headers);
    for (const [name] of perRequest) {
      credentialHeaders.delete(name);
    }
    // Append to the configured prefix; an absolute path would escape it.
    const url = `${baseUrl.replace(/\/+$/u, "")}/${execution.endpointPath}`;
    const request = {
      url,
      signal,
      maxRedirects: 0,
      dispatcherPolicy,
      policy: resolveProviderTransportSsrFPolicy({
        baseUrl,
        url,
        allowPrivateNetwork,
        trustConfiguredBaseUrlOrigin,
      }),
      auditContext: `${execution.provider}-decisions`,
      init: {
        method: execution.body === undefined ? "GET" : "POST",
        headers,
        ...(execution.body === undefined ? {} : { body: execution.body }),
      },
    };
    const guarded = await fetchWithProviderHttpGuard(
      !dispatcherPolicy && shouldUseEnvHttpProxyForUrl(url)
        ? withTrustedEnvProxyGuardedFetchMode(request)
        : request,
    );
    // Cancelling a captured (teed) body waits for its capture branch; release ends both.
    let releasing: Promise<void> | undefined;
    const release = () => (releasing ??= guarded.release());
    const response = responseWithRelease(guarded.response, release);
    try {
      if (!response.ok) {
        // Error bodies can reflect credentials or state; never read them.
        await response.body?.cancel();
        return failureForStatus(response, execution.statusReason);
      }
      let payload: unknown;
      try {
        payload = await readProviderJsonResponse<unknown>(response, "Decision request", {
          maxBytes: execution.maxResponseBytes ?? 1_048_576,
          signal,
          requestHeaders: headers,
        });
      } catch {
        signal.throwIfAborted();
        return unavailable("invalid-response");
      }
      // Vendor-controlled names/model strings must not reflect the active credential.
      const serialized = JSON.stringify(payload);
      if (
        serialized.includes(auth.apiKey) ||
        createProviderCredentialMatcher({
          headers: credentialHeaders,
          request: preparedRequest,
          configuredHeaderNames: Object.keys(execution.headers ?? {}),
          defaultAuthHeader: "Authorization",
          defaultAuthPrefix: "Bearer ",
        })(serialized)
      ) {
        return unavailable("invalid-response");
      }
      try {
        return execution.decode(payload);
      } catch {
        return unavailable("invalid-response");
      }
    } finally {
      await release();
    }
  } catch {
    execution.signal.throwIfAborted();
    return unavailable("transport");
  } finally {
    cleanup();
  }
}
