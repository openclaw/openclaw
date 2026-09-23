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
  "The configured Control UI GitHub credential is unavailable. Resolve gateway.controlUi.github.token and retry.";

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
  GITHUB_API_ORIGIN: string;
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
  resolveGitHubApiCredentialScope: (env?: NodeJS.ProcessEnv) => {
    token: string | undefined;
    cacheScope: string;
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
): string | undefined {
  const configured = config?.gateway?.controlUi?.github?.token;
  if (configured !== undefined) {
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
  return env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || undefined;
}

export function hasConfiguredGitHubApiCredential(
  env: NodeJS.ProcessEnv,
  config: OpenClawConfig,
): boolean {
  return (
    config.gateway?.controlUi?.github?.token !== undefined ||
    Boolean(env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim())
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
  const resolveScope = (env: NodeJS.ProcessEnv = process.env) => {
    const token = githubApiToken(env);
    return { token, cacheScope: library.githubApiCredentialCacheScope(token) };
  };
  const resolveReadIdentity = (
    identity: ControlUiGitHubPreviewIdentity | undefined,
  ): ControlUiGitHubPreviewIdentity => {
    if (identity) {
      return identity;
    }
    const selected = resolveScope();
    const assertSelected = () => {
      if (resolveScope().cacheScope !== selected.cacheScope) {
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
