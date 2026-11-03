import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSyncCore,
} from "../plugin-sdk/facade-loader.js";

export interface ControlUiGitHubError extends Error {
  readonly statusCode: number;
  readonly upstreamStatus: number;
  readonly retryable: boolean;
  readonly retryAtMs: number | undefined;
  readonly retryAfterMs: number | undefined;
}
type NativeGitHubAccountTransport = {
  GITHUB_API_ORIGIN: string;
  GITHUB_REQUEST_TIMEOUT_MS: number;
  ControlUiGitHubError: new (
    statusCode: number,
    message: string,
    options?: { retryAtMs?: number; upstreamStatus?: number; retryable?: boolean },
  ) => ControlUiGitHubError;
  githubApiCredentialCacheScope: (token: string | undefined) => string;
  readBoundedResponse: (response: Response, maxBytes: number) => Promise<Buffer>;
  discardResponse: (response: Response) => Promise<void>;
  readGitHubJsonResponse: (response: Response, maxBytes?: number) => Promise<unknown>;
  withOptionalGitHubAuth: <T>(
    token: string | undefined,
    request: (token: string | undefined) => Promise<T>,
  ) => Promise<T>;
  fetchGitHubApi: (
    url: string,
    fetchImpl: typeof fetch,
    token?: string,
    beforeRedirect?: (url: URL) => Promise<void>,
    identity?: {
      revalidate: () => Promise<void>;
      assertSelected: () => void;
      signal?: AbortSignal;
    },
    etag?: string,
    signal?: AbortSignal,
    graphql?: undefined,
    apiBaseUrl?: string,
  ) => Promise<Response>;
  fetchGitHubJsonPage: (
    url: string,
    fetchImpl: typeof fetch,
    token?: string,
    options?: {
      maxBytes?: number;
      apiBaseUrl?: string;
      beforeRedirect?: (url: URL) => Promise<void>;
      identity?: {
        revalidate: () => Promise<void>;
        assertSelected: () => void;
        signal?: AbortSignal;
      };
      signal?: AbortSignal;
    },
  ) => Promise<{ value: unknown; link: string | null }>;
};

// Native sign-in remains available independently of optional repository services.
// The public reader loader owns the HTTP kernel, error identity, and quota cooldowns.
export const gitHubAccountApi = createLazyFacadeObjectValue<NativeGitHubAccountTransport>(() =>
  loadBundledPluginPublicSurfaceModuleSyncCore<NativeGitHubAccountTransport>({
    dirName: "github",
    artifactBasename: "api.js",
  }),
);
