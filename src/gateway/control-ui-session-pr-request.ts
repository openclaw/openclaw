import { recordSessionPrDiagnostic } from "./control-ui-session-pr-diagnostics.js";
import { gitHubPublicApi } from "./github-public-api.js";

export type SessionPullRequestReadCredential = {
  token: string;
  apiBaseUrl: string;
  assertCurrent: () => void;
};

/** Shared I/O survives one reader's retirement while each reader owns its delivery. */
export function createGitHubReadGroup() {
  const readers = new Set<() => void>();
  const abort = new AbortController();
  const assertCurrent = () => {
    abort.signal.throwIfAborted();
    let failure: unknown = new gitHubPublicApi.ControlUiGitHubError(
      409,
      "GitHub read has no active reader",
    );
    for (const assertReader of readers) {
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
    add(assertReader: () => void, signal?: AbortSignal) {
      const reader = () => {
        signal?.throwIfAborted();
        assertReader();
      };
      reader();
      readers.add(reader);
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
  assertAccess: () => void,
  options: {
    optionalAuth?: boolean;
    signal?: AbortSignal;
    credential?: SessionPullRequestReadCredential;
  } = {},
) {
  const fetchRequest = fetch;
  const credential = options.credential;
  const optionalAuth = !credential && options.optionalAuth !== false;
  const selected = credential
    ? {
        token: credential.token,
        apiBaseUrl: credential.apiBaseUrl,
        cacheScope: `${host}:${credential.apiBaseUrl}:${gitHubPublicApi.githubApiCredentialCacheScope(credential.token)}`,
      }
    : gitHubPublicApi.resolveGitHubApiCredentialScope(undefined, host);
  const assertCurrent = () => {
    assertAccess();
    credential?.assertCurrent();
    if (
      !credential &&
      gitHubPublicApi.resolveGitHubApiCredentialScope(undefined, host).cacheScope !==
        selected.cacheScope
    ) {
      throw new gitHubPublicApi.ControlUiGitHubError(
        409,
        "GitHub identity changed; reopen the session pull request",
      );
    }
  };
  const identity = { assertSelected: assertCurrent, revalidate: async () => assertCurrent() };
  return {
    ...selected,
    host,
    credential,
    assertCurrent,
    async request(
      this: void,
      url: string,
      maxBytes?: number,
      signal?: AbortSignal,
      beforeRedirect?: (url: URL) => Promise<void>,
    ) {
      assertCurrent();
      const sourceSignals = [signal, options.signal].filter((value): value is AbortSignal =>
        Boolean(value),
      );
      const requestSignal =
        sourceSignals.length > 1 ? AbortSignal.any(sourceSignals) : sourceSignals[0];
      const readJson = async (token: string | undefined) => {
        recordSessionPrDiagnostic("github-fetch-started");
        const { value } = await gitHubPublicApi.fetchGitHubJsonPage(url, fetchRequest, token, {
          beforeRedirect,
          identity,
          signal: requestSignal,
          apiBaseUrl: selected.apiBaseUrl,
          maxBytes,
        });
        recordSessionPrDiagnostic("github-fetch-returned");
        recordSessionPrDiagnostic("github-json-returned");
        return value;
      };
      const value = optionalAuth
        ? await gitHubPublicApi.withOptionalGitHubAuth(selected.token, readJson)
        : await readJson(selected.token);
      assertCurrent();
      recordSessionPrDiagnostic("github-request-returned");
      return value;
    },
  };
}
