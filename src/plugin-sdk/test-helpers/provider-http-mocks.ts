import { afterEach, vi, type Mock } from "vitest";
import type {
  assertOkOrThrowHttpError,
  assertOkOrThrowProviderError,
  fetchWithTimeout,
  pollProviderOperationJson,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "../provider-http.js";

type ResolveProviderHttpRequestConfigParams = Parameters<
  typeof resolveProviderHttpRequestConfig
>[0];
type PollProviderOperationJsonParams = Parameters<typeof pollProviderOperationJson>[0];
type SanitizeConfiguredModelProviderRequestParams = Parameters<
  typeof sanitizeConfiguredModelProviderRequest
>[0];

type ResolveProviderHttpRequestConfigResult = {
  baseUrl: string;
  allowPrivateNetwork: boolean;
  headers: Headers;
  dispatcherPolicy: undefined;
};

type PostJsonRequestMock = Mock<
  (params: Parameters<typeof postJsonRequest>[0]) => Promise<unknown>
>;
type FetchWithTimeoutMock = Mock<
  (
    url: Parameters<typeof fetchWithTimeout>[0],
    init: Parameters<typeof fetchWithTimeout>[1],
    timeoutMs: Parameters<typeof fetchWithTimeout>[2],
    fetchFn?: Parameters<typeof fetchWithTimeout>[3],
  ) => Promise<unknown>
>;
type PollProviderOperationJsonMock = Mock<
  (params: PollProviderOperationJsonParams) => Promise<unknown>
>;

interface ProviderHttpMocks {
  resolveApiKeyForProviderMock: Mock<() => Promise<{ apiKey: string }>>;
  postJsonRequestMock: PostJsonRequestMock;
  fetchWithTimeoutMock: FetchWithTimeoutMock;
  pollProviderOperationJsonMock: PollProviderOperationJsonMock;
  assertOkOrThrowHttpErrorMock: Mock<typeof assertOkOrThrowHttpError>;
  assertOkOrThrowProviderErrorMock: Mock<typeof assertOkOrThrowProviderError>;
  sanitizeConfiguredModelProviderRequestMock: Mock<
    (
      request: SanitizeConfiguredModelProviderRequestParams,
    ) => SanitizeConfiguredModelProviderRequestParams
  >;
  resolveProviderHttpRequestConfigMock: Mock<
    (params: ResolveProviderHttpRequestConfigParams) => ResolveProviderHttpRequestConfigResult
  >;
}

const providerHttpMocks = vi.hoisted(() => ({
  resolveApiKeyForProviderMock: vi.fn(async () => ({ apiKey: "provider-key" })),
  postJsonRequestMock: vi.fn<(params: Parameters<typeof postJsonRequest>[0]) => Promise<unknown>>(),
  fetchWithTimeoutMock:
    vi.fn<
      (
        url: Parameters<typeof fetchWithTimeout>[0],
        init: Parameters<typeof fetchWithTimeout>[1],
        timeoutMs: Parameters<typeof fetchWithTimeout>[2],
        fetchFn?: Parameters<typeof fetchWithTimeout>[3],
      ) => Promise<unknown>
    >(),
  pollProviderOperationJsonMock:
    vi.fn<(params: PollProviderOperationJsonParams) => Promise<unknown>>(),
  assertOkOrThrowHttpErrorMock: vi.fn<typeof assertOkOrThrowHttpError>(
    async (_response: Response, _label: string) => {},
  ),
  assertOkOrThrowProviderErrorMock: vi.fn<typeof assertOkOrThrowProviderError>(
    async (_response: Response, _label: string) => {},
  ),
  sanitizeConfiguredModelProviderRequestMock: vi.fn(
    (request: SanitizeConfiguredModelProviderRequestParams) => request,
  ),
  resolveProviderHttpRequestConfigMock: vi.fn((params: ResolveProviderHttpRequestConfigParams) => ({
    baseUrl: params.baseUrl ?? params.defaultBaseUrl,
    allowPrivateNetwork: params.allowPrivateNetwork === true,
    headers: new Headers(params.defaultHeaders),
    dispatcherPolicy: undefined,
  })),
}));

providerHttpMocks.pollProviderOperationJsonMock.mockImplementation(
  async (params: PollProviderOperationJsonParams) => {
    for (let attempt = 0; attempt < params.maxAttempts; attempt += 1) {
      const response = (await providerHttpMocks.fetchWithTimeoutMock(
        params.url,
        {
          method: "GET",
          headers: params.headers,
        },
        params.defaultTimeoutMs,
        params.fetchFn,
      )) as Response;
      await providerHttpMocks.assertOkOrThrowHttpErrorMock(response, params.requestFailedMessage);
      const payload = await response.json();
      if (params.isComplete(payload)) {
        return payload;
      }
      const failureMessage = params.getFailureMessage?.(payload);
      if (failureMessage) {
        throw new Error(failureMessage);
      }
    }
    throw new Error(params.timeoutMessage);
  },
);

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: providerHttpMocks.resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", () => ({
  assertOkOrThrowHttpError: providerHttpMocks.assertOkOrThrowHttpErrorMock,
  assertOkOrThrowProviderError: providerHttpMocks.assertOkOrThrowProviderErrorMock,
  createProviderOperationDeadline: ({
    label,
    timeoutMs,
  }: {
    label: string;
    timeoutMs?: number;
  }) => ({
    label,
    timeoutMs,
  }),
  fetchWithTimeout: providerHttpMocks.fetchWithTimeoutMock,
  pollProviderOperationJson: providerHttpMocks.pollProviderOperationJsonMock,
  postJsonRequest: providerHttpMocks.postJsonRequestMock,
  resolveProviderOperationTimeoutMs: ({ defaultTimeoutMs }: { defaultTimeoutMs: number }) =>
    defaultTimeoutMs,
  resolveProviderHttpRequestConfig: providerHttpMocks.resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequest:
    providerHttpMocks.sanitizeConfiguredModelProviderRequestMock,
  waitProviderOperationPollInterval: async () => {},
}));

export function getProviderHttpMocks(): ProviderHttpMocks {
  return providerHttpMocks;
}

export function installProviderHttpMockCleanup(): void {
  afterEach(() => {
    providerHttpMocks.resolveApiKeyForProviderMock.mockClear();
    providerHttpMocks.postJsonRequestMock.mockReset();
    providerHttpMocks.fetchWithTimeoutMock.mockReset();
    providerHttpMocks.pollProviderOperationJsonMock.mockClear();
    providerHttpMocks.assertOkOrThrowHttpErrorMock.mockClear();
    providerHttpMocks.assertOkOrThrowProviderErrorMock.mockClear();
    providerHttpMocks.sanitizeConfiguredModelProviderRequestMock.mockClear();
    providerHttpMocks.resolveProviderHttpRequestConfigMock.mockClear();
  });
}
