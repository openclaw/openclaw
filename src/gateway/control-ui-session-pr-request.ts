import { gitHubPublicApi, type ControlUiGitHubPreviewIdentity } from "./github-public-api.js";

/** Shared I/O survives one reader's retirement while each reader owns its delivery. */
export function createGitHubReadGroup() {
  const readers = new Map<() => void, ControlUiGitHubPreviewIdentity | undefined>();
  const abort = new AbortController();
  const assertCurrent = () => {
    abort.signal.throwIfAborted();
    let failure: unknown = new gitHubPublicApi.ControlUiGitHubError(
      409,
      "GitHub read has no active reader",
    );
    for (const assertReader of readers.keys()) {
      try {
        assertReader();
        return;
      } catch (error) {
        failure = error;
      }
    }
    abort.abort(failure);
    throw failure;
  };
  return {
    signal: abort.signal,
    assertCurrent,
    identity() {
      assertCurrent();
      for (const [reader, identity] of readers) {
        try {
          reader();
          return identity;
        } catch {
          // Another admitted reader can retain the shared request.
        }
      }
      return undefined;
    },
    add(assertReader: () => void, signal?: AbortSignal, identity?: ControlUiGitHubPreviewIdentity) {
      const reader = () => {
        signal?.throwIfAborted();
        assertReader();
      };
      reader();
      readers.set(reader, identity);
      const release = () => {
        readers.delete(reader);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        release();
        try {
          assertCurrent();
        } catch {
          // The assertion aborts shared transport when no admitted reader remains.
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      return release;
    },
  };
}

/** Session reads pin the admitted host, endpoint and credential across every auxiliary request. */
export function prepareSessionPullRequestGitHubRead(
  host: string,
  fetchImpl: typeof fetch,
  assertAccess: () => void,
  options: {
    optionalAuth?: boolean;
    signal?: AbortSignal;
    identity?: ControlUiGitHubPreviewIdentity;
  } = {},
) {
  const optionalAuth = !options.identity && options.optionalAuth !== false;
  const scope = options.identity
    ? { ...options.identity, apiBaseUrl: gitHubPublicApi.GITHUB_API_BASE_URL }
    : gitHubPublicApi.resolveGitHubApiCredentialScope(undefined, host);
  const selected = options.identity ? { ...scope, ...options.identity } : scope;
  const assertCurrent = () => {
    assertAccess();
    options.identity?.assertSelected();
    const current = options.identity
      ? { apiBaseUrl: gitHubPublicApi.GITHUB_API_BASE_URL, cacheScope: options.identity.cacheScope }
      : gitHubPublicApi.resolveGitHubApiCredentialScope(undefined, host);
    if (
      current.apiBaseUrl !== scope.apiBaseUrl ||
      (!options.identity && current.cacheScope !== selected.cacheScope)
    ) {
      throw new gitHubPublicApi.ControlUiGitHubError(
        409,
        "GitHub identity changed; reopen the session pull request",
      );
    }
  };
  const identity = {
    assertSelected: assertCurrent,
    revalidate: async () => {
      await options.identity?.revalidate();
      assertCurrent();
    },
  };
  return {
    ...selected,
    repository: options.identity?.repository,
    host,
    assertCurrent,
    async request(
      this: void,
      url: string,
      maxBytes?: number,
      signal?: AbortSignal,
      beforeRedirect?: (url: URL) => Promise<void>,
    ) {
      await identity.revalidate();
      if (options.identity?.repository) {
        const target = options.identity.repository;
        const expected = `${selected.apiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
        if (url !== expected && !url.startsWith(`${expected}/`)) {
          throw new gitHubPublicApi.ControlUiGitHubError(
            404,
            "GitHub repository is outside the session",
          );
        }
      }
      const sourceSignals = [signal, options.signal].filter((value): value is AbortSignal =>
        Boolean(value),
      );
      const requestSignal =
        sourceSignals.length > 1 ? AbortSignal.any(sourceSignals) : sourceSignals[0];
      const readJson = async (token: string | undefined) =>
        gitHubPublicApi.readGitHubJsonResponse(
          await gitHubPublicApi.fetchGitHubApi(
            url,
            fetchImpl,
            token,
            options.identity?.repository
              ? async () => {
                  throw new gitHubPublicApi.ControlUiGitHubError(
                    409,
                    "GitHub repository changed; reopen the session",
                  );
                }
              : beforeRedirect,
            identity,
            undefined,
            requestSignal,
            undefined,
            selected.apiBaseUrl,
          ),
          maxBytes,
        );
      const value = optionalAuth
        ? await gitHubPublicApi.withOptionalGitHubAuth(selected.token, readJson)
        : await readJson(selected.token);
      assertCurrent();
      return value;
    },
  };
}
