import {
  resolveConfiguredGitHubApiBaseUrl,
  resolveConfiguredGitHubHost,
} from "../agents/github-host.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSyncCore,
} from "../plugin-sdk/facade-loader.js";
import {
  assertSecretOwnerAvailable,
  isTrustedSecretSurfaceUnavailableError,
  SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";
import type { ControlUiLinkReaderDocument } from "../shared/control-ui-link-reader.js";

export const CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE =
  "The configured Control UI GitHub credential is unavailable. Check gateway.controlUi.github.token and its host binding, then retry.";

export interface ControlUiGitHubError extends Error {
  readonly statusCode: number;
  readonly upstreamStatus: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
}
type GitHubGraphQLUnavailableError = ControlUiGitHubError;
export type ControlUiGitHubPreviewIdentity = {
  token: string | undefined;
  cacheScope: string;
  /** Host service/env credentials may retry a stale HTTP 401 anonymously. */
  optionalAuth?: true;
  revalidate: () => Promise<void>;
  assertSelected: () => void;
};
type ControlUiGitHubPreviewTarget = {
  owner: string;
  repo: string;
  kind: "issue" | "pull";
  number: number;
};
type GitHubDetailTarget =
  | ControlUiGitHubPreviewTarget
  | { owner: string; repo: string; kind: "commit"; sha: string };

/** Host consumers depend on this public read contract, not the plugin's source graph. */
type GitHubPublicApi = {
  resolveGitHubApiUrls: (apiBaseUrl: string | undefined) => { baseUrl: string; graphqlUrl: string };
  GITHUB_API_ORIGIN: string;
  GITHUB_API_BASE_URL: string;
  GITHUB_GRAPHQL_URL: string;
  GITHUB_REQUEST_TIMEOUT_MS: number;
  ControlUiGitHubError: new (
    statusCode: number,
    message: string,
    options?: { retryAtMs?: number; upstreamStatus?: number; retryable?: boolean },
  ) => ControlUiGitHubError;
  GitHubGraphQLUnavailableError: new (upstreamStatus: number) => GitHubGraphQLUnavailableError;
  formatControlUiGitHubPreviewError: (error: unknown) => {
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  };
  resolveGitHubApiCredentialScope: (
    env?: NodeJS.ProcessEnv,
    host?: string,
  ) => {
    token: string | undefined;
    cacheScope: string;
    apiBaseUrl: string;
  };
  githubApiCredentialCacheScope: (token: string | undefined) => string;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  requiredString: (record: Record<string, unknown>, key: string) => string;
  readOptionalGitHubString: (record: Record<string, unknown>, key: string) => string | undefined;
  optionalNumber: (record: Record<string, unknown>, key: string) => number | undefined;
  fetchGitHubApi: (
    url: string,
    fetchImpl: typeof fetch,
    token?: string,
    beforeRedirect?: (url: URL) => Promise<void>,
    identity?: Pick<ControlUiGitHubPreviewIdentity, "revalidate" | "assertSelected">,
    etag?: string,
    signal?: AbortSignal,
    graphql?: { query: string; variables: Record<string, string> },
    apiBaseUrl?: string,
  ) => Promise<Response>;
  discardResponse: (response: Response) => Promise<void>;
  readBoundedResponse: (response: Response, maxBytes: number) => Promise<Buffer>;
  readGitHubGraphQLResponse: (
    response: Response,
    fetchImpl: typeof fetch,
    token: string,
    maxBytes?: number,
  ) => Promise<unknown>;
  withOptionalGitHubAuth: <T>(
    token: string | undefined,
    request: (token: string | undefined) => Promise<T>,
  ) => Promise<T>;
  readGitHubJsonResponse: (response: Response, maxBytes?: number) => Promise<unknown>;
  fetchGitHubJson: (
    url: string,
    fetchImpl: typeof fetch,
    token?: string,
    maxBytes?: number,
    apiBaseUrl?: string,
  ) => Promise<unknown>;
  parseControlUiGitHubPreviewTarget: (params: unknown) => ControlUiGitHubPreviewTarget | null;
  parseGitHubTarget: (params: unknown) => GitHubDetailTarget | null;
  loadGitHubDetail: (
    target: GitHubDetailTarget,
    identity?: ControlUiGitHubPreviewIdentity,
    fetchImpl?: typeof fetch,
    refresh?: boolean,
  ) => Promise<ControlUiLinkReaderDocument>;
  loadControlUiGitHubPreview: (
    target: ControlUiGitHubPreviewTarget,
    identity?: ControlUiGitHubPreviewIdentity,
    fetchImpl?: typeof fetch,
    refresh?: boolean,
  ) => Promise<unknown>;
};

/** Host credential selection uses canonical config and degradation state. */
export function githubApiToken(
  env: NodeJS.ProcessEnv = process.env,
  config: OpenClawConfig | null = getRuntimeConfigSnapshot(),
  host?: string,
): string | undefined {
  const selectedHost = host ?? resolveConfiguredGitHubHost(config);
  const configured = config?.gateway?.controlUi?.github?.token;
  const credentialHost =
    config?.gateway?.controlUi?.github?.host?.trim().toLowerCase() || "github.com";
  if (configured !== undefined && (host === undefined || credentialHost === selectedHost)) {
    if (credentialHost !== selectedHost) {
      throw new SecretSurfaceUnavailableError({
        ownerKind: "capability",
        ownerId: "control-ui-github",
        state: "unavailable",
        paths: ["gateway.controlUi.github.host"],
        refKeys: [],
        reason: "service credential host does not match gateway.github.host",
      });
    }
    assertSecretOwnerAvailable("capability", "control-ui-github");
    const token = typeof configured === "string" ? configured.trim() : "";
    if (!token) {
      throw new SecretSurfaceUnavailableError({
        ownerKind: "capability",
        ownerId: "control-ui-github",
        state: "unavailable",
        paths: ["gateway.controlUi.github.token"],
        refKeys: [],
        reason: "secret reference was not materialized by the active runtime",
      });
    }
    return token;
  }
  return selectedHost === "github.com"
    ? env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || undefined
    : undefined;
}

export function hasConfiguredGitHubApiCredential(
  env: NodeJS.ProcessEnv,
  config: OpenClawConfig,
): boolean {
  return (
    (config.gateway?.controlUi?.github?.token !== undefined &&
      (config.gateway.controlUi.github.host?.trim().toLowerCase() || "github.com") ===
        resolveConfiguredGitHubHost(config)) ||
    (resolveConfiguredGitHubHost(config) === "github.com" &&
      Boolean(env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()))
  );
}

type GitHubTransportApi = Omit<GitHubPublicApi, "resolveGitHubApiCredentialScope">;

// The existing loader owns library caching and retirement. Host-specific
// callbacks stay here, rather than consulting another loader’s state.
export const gitHubPublicApi = createLazyFacadeObjectValue<GitHubPublicApi>(() => {
  const library = loadBundledPluginPublicSurfaceModuleSyncCore<GitHubTransportApi>({
    dirName: "github",
    artifactBasename: "api.js",
  });
  const resolveScope = (env: NodeJS.ProcessEnv = process.env, host?: string) => {
    const config = getRuntimeConfigSnapshot();
    const configuredHost = resolveConfiguredGitHubHost(config);
    const selectedHost = host ?? configuredHost;
    if (selectedHost !== configuredHost && selectedHost !== "github.com") {
      throw new library.ControlUiGitHubError(
        409,
        "Repository GitHub host changed; restore its configuration and retry",
      );
    }
    const apiBaseUrl =
      selectedHost === configuredHost
        ? resolveConfiguredGitHubApiBaseUrl(config)
        : "https://api.github.com";
    const token = selectedHost === configuredHost ? githubApiToken(env, config) : undefined;
    return {
      token,
      apiBaseUrl,
      cacheScope: `${selectedHost}:${apiBaseUrl}:${library.githubApiCredentialCacheScope(token)}`,
    };
  };
  const resolvePublicScope = () =>
    resolveConfiguredGitHubHost(getRuntimeConfigSnapshot()) === "github.com"
      ? resolveScope()
      : { token: undefined, cacheScope: "public:anonymous" };
  const resolveReadIdentity = (
    identity: ControlUiGitHubPreviewIdentity | undefined,
  ): ControlUiGitHubPreviewIdentity => {
    if (identity) {
      return resolveConfiguredGitHubHost(getRuntimeConfigSnapshot()) === "github.com"
        ? identity
        : { ...identity, token: undefined, cacheScope: "public:anonymous" };
    }
    const selected = resolvePublicScope();
    const assertSelected = () => {
      if (resolvePublicScope().cacheScope !== selected.cacheScope) {
        throw new library.ControlUiGitHubError(409, "GitHub credential changed; retry the request");
      }
    };
    return {
      ...selected,
      optionalAuth: true,
      assertSelected,
      revalidate: async () => assertSelected(),
    };
  };
  return {
    ...library,
    get GITHUB_API_BASE_URL() {
      return resolveConfiguredGitHubApiBaseUrl(getRuntimeConfigSnapshot());
    },
    get GITHUB_GRAPHQL_URL() {
      return library.resolveGitHubApiUrls(getRuntimeConfigSnapshot()?.gateway?.github?.apiBaseUrl)
        .graphqlUrl;
    },
    fetchGitHubApi(...args) {
      args[8] ??= resolveConfiguredGitHubApiBaseUrl(getRuntimeConfigSnapshot());
      return library.fetchGitHubApi(...args);
    },
    fetchGitHubJson(...args) {
      args[4] ??= resolveConfiguredGitHubApiBaseUrl(getRuntimeConfigSnapshot());
      return library.fetchGitHubJson(...args);
    },
    resolveGitHubApiCredentialScope: resolveScope,
    formatControlUiGitHubPreviewError(error) {
      return isTrustedSecretSurfaceUnavailableError(error)
        ? { message: CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE, retryable: false }
        : library.formatControlUiGitHubPreviewError(error);
    },
    loadControlUiGitHubPreview(target, identity, fetchImpl, refresh) {
      return library.loadControlUiGitHubPreview(
        target,
        resolveReadIdentity(identity),
        fetchImpl,
        refresh,
      );
    },
    loadGitHubDetail(target, identity, fetchImpl, refresh) {
      return library.loadGitHubDetail(target, resolveReadIdentity(identity), fetchImpl, refresh);
    },
  };
});
