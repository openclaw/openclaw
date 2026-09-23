/**
 * Shared HTTP fetch mock helpers for provider contract tests.
 */
import { afterEach, vi, type Mock } from "vitest";
import type {
  fetchWithTimeoutGuarded,
  postMultipartRequest,
  resolveProviderHttpRequestConfig,
  resolveProviderRequestHeaders,
  sanitizeConfiguredModelProviderRequest,
} from "../provider-http.js";

type ResolveProviderHttpRequestConfigParams = Parameters<
  typeof resolveProviderHttpRequestConfig
>[0];
type FetchWithTimeoutGuardedParams = Parameters<typeof fetchWithTimeoutGuarded>;
type ResolveProviderRequestHeadersParams = Parameters<typeof resolveProviderRequestHeaders>[0];
type PostMultipartRequestParams = Parameters<typeof postMultipartRequest>[0];
type SanitizeConfiguredModelProviderRequestParams = Parameters<
  typeof sanitizeConfiguredModelProviderRequest
>[0];

type ResolveProviderHttpRequestConfigResult = {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  headers: Headers;
  dispatcherPolicy: ReturnType<typeof resolveProviderHttpRequestConfig>["dispatcherPolicy"];
};

type AnyMock = Mock<(...args: unknown[]) => unknown>;

interface ProviderHttpMocks {
  resolveApiKeyForProviderMock: Mock<() => Promise<{ apiKey: string }>>;
  executeProviderOperationWithRetryMock: AnyMock;
  postJsonRequestMock: AnyMock;
  postMultipartRequestMock: AnyMock;
  fetchWithTimeoutMock: AnyMock;
  fetchWithTimeoutGuardedMock: AnyMock;
  pollProviderOperationJsonMock: AnyMock;
  assertOkOrThrowHttpErrorMock: Mock<(response: Response, label: string) => Promise<void>>;
  assertOkOrThrowProviderErrorMock: Mock<(response: Response, label: string) => Promise<void>>;
  readProviderJsonResponseMock: Mock<
    <T>(response: Response, label: string, opts?: { maxBytes?: number }) => Promise<T>
  >;
  sanitizeConfiguredModelProviderRequestMock: Mock<
    (
      request: SanitizeConfiguredModelProviderRequestParams,
    ) => SanitizeConfiguredModelProviderRequestParams
  >;
  resolveProviderHttpRequestConfigMock: Mock<
    (params: ResolveProviderHttpRequestConfigParams) => ResolveProviderHttpRequestConfigResult
  >;
  resolveProviderRequestHeadersMock: Mock<
    (params: ResolveProviderRequestHeadersParams) => Record<string, string> | undefined
  >;
}

const providerHttpMocks = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
  executeProviderOperationWithRetryMock: vi.fn(),
  postJsonRequestMock: vi.fn(),
  postMultipartRequestMock: vi.fn(),
  fetchWithTimeoutMock: vi.fn(),
  fetchWithTimeoutGuardedMock: vi.fn(),
  fetchProviderOperationResponseMock: vi.fn(),
  fetchProviderDownloadResponseMock: vi.fn(),
  pollProviderOperationJsonMock: vi.fn(),
  assertOkOrThrowHttpErrorMock: vi.fn(async (_response: Response, _label: string) => {}),
  assertOkOrThrowProviderErrorMock: vi.fn(async (_response: Response, _label: string) => {}),
  readProviderJsonResponseMock:
    vi.fn<<T>(response: Response, label: string, opts?: { maxBytes?: number }) => Promise<T>>(),
  sanitizeConfiguredModelProviderRequestMock: vi.fn(
    (request: SanitizeConfiguredModelProviderRequestParams) => request,
  ),
  resolveProviderHttpRequestConfigMock: vi.fn((params: ResolveProviderHttpRequestConfigParams) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork:
      (params.allowPrivateNetwork ?? params.request?.allowPrivateNetwork) === true,
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
  resolveProviderRequestHeadersMock: vi.fn((params: ResolveProviderRequestHeadersParams) => {
    if (params.provider === "google") {
      return {
        ...params.defaultHeaders,
        "x-goog-api-client": "openclaw/test",
        ...params.callerHeaders,
      };
    }
    return params.callerHeaders ?? params.defaultHeaders;
  }),
}));

const providerHttpMockKeys = vi.hoisted(() => ({
  sanitizeConfiguredModelProviderRequest: "sanitizeConfiguredModelProviderRequest",
}));

providerHttpMocks.fetchWithTimeoutGuardedMock.mockImplementation(
  async (...args: FetchWithTimeoutGuardedParams) => {
    const [url, init, timeoutMs, fetchFn] = args;
    const response = await providerHttpMocks.fetchWithTimeoutMock(
      url,
      init ?? {},
      timeoutMs ?? 60_000,
      fetchFn,
    );
    return {
      response,
      finalUrl: url,
      release: async () => {},
    };
  },
);

providerHttpMocks.postMultipartRequestMock.mockImplementation(
  async (params: PostMultipartRequestParams) => {
    const response = await providerHttpMocks.fetchWithTimeoutMock(
      params.url,
      {
        method: "POST",
        headers: params.headers,
        body: params.body,
      },
      params.timeoutMs ?? 60_000,
      params.fetchFn,
    );
    return {
      response,
      release: async () => {},
    };
  },
);

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: providerHttpMocks.resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importActual) => {
  const actual = await importActual<typeof import("openclaw/plugin-sdk/provider-http")>();
  const timeoutTransport = await vi.importActual<typeof import("../../utils/fetch-timeout.js")>(
    "../../utils/fetch-timeout.js",
  );
  const guardedTransport = await vi.importActual<typeof import("../../infra/net/fetch-guard.js")>(
    "../../infra/net/fetch-guard.js",
  );
  const { resolveTransientProviderRetryOptions } =
    await import("../../provider-runtime/operation-retry.js");
  // Earlier SDK imports can retain the actual transport namespace; bind it at each call
  // so both those imports and tests that restore spies use the fixture transport.
  const installTransportMocks = () => {
    vi.spyOn(timeoutTransport, "fetchWithTimeout").mockImplementation((...args) =>
      providerHttpMocks.fetchWithTimeoutMock(...args),
    );
    vi.spyOn(guardedTransport, "fetchWithSsrFGuard").mockImplementation(async (params) => ({
      response: await providerHttpMocks.fetchWithTimeoutMock(
        params.url,
        params.init ?? {},
        params.timeoutMs,
        params.fetchImpl,
      ),
      finalUrl: params.url,
      release: async () => {},
    }));
  };
  providerHttpMocks.readProviderJsonResponseMock.mockImplementation(
    actual.readProviderJsonResponse,
  );
  providerHttpMocks.pollProviderOperationJsonMock.mockImplementation((params) => {
    installTransportMocks();
    return actual.pollProviderOperationJson(params);
  });
  providerHttpMocks.fetchProviderOperationResponseMock.mockImplementation((params) => {
    installTransportMocks();
    return actual.fetchProviderOperationResponse(params);
  });
  providerHttpMocks.fetchProviderDownloadResponseMock.mockImplementation((params) => {
    installTransportMocks();
    return actual.fetchProviderDownloadResponse(params);
  });
  providerHttpMocks.executeProviderOperationWithRetryMock.mockImplementation(
    (params: Parameters<typeof actual.executeProviderOperationWithRetry>[0]) => {
      const retry = resolveTransientProviderRetryOptions(
        actual.providerOperationRetryConfig(params.stage, params.retry),
      );
      return actual.executeProviderOperationWithRetry({
        ...params,
        ...(retry ? { retry: { ...retry, sleep: retry.sleep ?? (async () => {}) } } : {}),
      });
    },
  );
  return {
    ...actual,
    assertOkOrThrowHttpError: providerHttpMocks.assertOkOrThrowHttpErrorMock,
    assertOkOrThrowProviderError: providerHttpMocks.assertOkOrThrowProviderErrorMock,
    executeProviderOperationWithRetry: providerHttpMocks.executeProviderOperationWithRetryMock,
    fetchProviderDownloadResponse: providerHttpMocks.fetchProviderDownloadResponseMock,
    fetchProviderOperationResponse: providerHttpMocks.fetchProviderOperationResponseMock,
    fetchWithTimeout: providerHttpMocks.fetchWithTimeoutMock,
    fetchWithTimeoutGuarded: providerHttpMocks.fetchWithTimeoutGuardedMock,
    pollProviderOperationJson: providerHttpMocks.pollProviderOperationJsonMock,
    postJsonRequest: providerHttpMocks.postJsonRequestMock,
    postMultipartRequest: providerHttpMocks.postMultipartRequestMock,
    readProviderJsonResponse: providerHttpMocks.readProviderJsonResponseMock,
    resolveProviderHttpRequestConfig: providerHttpMocks.resolveProviderHttpRequestConfigMock,
    resolveProviderRequestHeaders: providerHttpMocks.resolveProviderRequestHeadersMock,
    [providerHttpMockKeys.sanitizeConfiguredModelProviderRequest]:
      providerHttpMocks.sanitizeConfiguredModelProviderRequestMock,
  };
});

export function getProviderHttpMocks(): ProviderHttpMocks {
  return providerHttpMocks;
}

export function installProviderHttpMockCleanup(): void {
  afterEach(() => {
    providerHttpMocks.resolveApiKeyForProviderMock.mockClear();
    providerHttpMocks.executeProviderOperationWithRetryMock.mockClear();
    providerHttpMocks.postJsonRequestMock.mockReset();
    providerHttpMocks.postMultipartRequestMock.mockClear();
    providerHttpMocks.fetchWithTimeoutMock.mockReset();
    providerHttpMocks.fetchWithTimeoutGuardedMock.mockClear();
    providerHttpMocks.fetchProviderOperationResponseMock.mockClear();
    providerHttpMocks.fetchProviderDownloadResponseMock.mockClear();
    providerHttpMocks.pollProviderOperationJsonMock.mockClear();
    providerHttpMocks.assertOkOrThrowHttpErrorMock.mockClear();
    providerHttpMocks.assertOkOrThrowProviderErrorMock.mockClear();
    providerHttpMocks.readProviderJsonResponseMock.mockClear();
    providerHttpMocks.sanitizeConfiguredModelProviderRequestMock.mockClear();
    providerHttpMocks.resolveProviderHttpRequestConfigMock.mockClear();
    providerHttpMocks.resolveProviderRequestHeadersMock.mockClear();
  });
}
