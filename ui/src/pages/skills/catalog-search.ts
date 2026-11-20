import { createMemo, createSignal } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createPageRequest, type PageReadResult } from "../../lib/page-request.ts";
import { searchClawHub } from "../../lib/skills/clawhub-search.ts";
import type { SkillsState } from "../../lib/skills/index.ts";

export function createSkillCatalogSearch(
  data: SkillsState,
  capture: () => GatewayBrowserClient | null,
) {
  let lastSearchScope:
    | readonly [GatewayBrowserClient | null, boolean, number, "discovery" | "settings"]
    | undefined;
  let lastSearchQuery: string | undefined;
  let clawhubSearchTimer: {
    timeout: ReturnType<typeof setTimeout>;
    resolve: (result: PageReadResult) => void;
  } | null = null;
  const [searchCompletion, setSearchCompletion] = createSignal<Promise<PageReadResult> | null>(
    null,
  );
  const searchRequest = createPageRequest(() => {}, {
    task: ({ client, query }: { client: GatewayBrowserClient; query: string }, { signal }) =>
      searchClawHub(client, query, signal),
    onComplete: (results) => {
      data.clawhubSearchResults = results;
    },
    onError: () => {},
  });
  const readClawHubSearch = createMemo(() => {
    const completion = searchCompletion();
    // First readiness belongs to Loading too, before request admission publishes its receipt.
    return (completion ?? Promise.resolve(null)).then((result) => {
      if (result) {
        throw result.error;
      }
      return true;
    });
  });
  function syncSearch(scope: NonNullable<typeof lastSearchScope>, query: string) {
    const sameScope = lastSearchScope?.every((value, index) => value === scope[index]);
    if (sameScope && lastSearchQuery === query.trim()) return;
    lastSearchScope = scope;
    lastSearchQuery = query.trim();
    clearClawHubSearchTimer();
    if (!scope[1]) return;
    if (sameScope && query.trim()) {
      scheduleSearch(query);
    } else {
      data.clawhubSearchResults = null;
      void setSearchCompletion(performSearch(query));
    }
  }

  function performSearch(query: string): Promise<PageReadResult> {
    searchRequest.reset();
    const client = capture();
    if (!client) return Promise.resolve(null);
    void searchRequest.run({ client, query });
    return searchRequest.read!;
  }

  function scheduleSearch(query: string) {
    data.clawhubSearchResults = null;
    data.clawhubInstallMessage = null;
    clearClawHubSearchTimer();
    searchRequest.reset();
    void setSearchCompletion(
      new Promise<PageReadResult>((resolve) => {
        const timeout = setTimeout(() => {
          clawhubSearchTimer = null;
          void performSearch(query).then(resolve);
        }, 300);
        clawhubSearchTimer = { timeout, resolve };
      }),
    );
  }

  function clearClawHubSearchTimer() {
    if (clawhubSearchTimer) {
      clearTimeout(clawhubSearchTimer.timeout);
      clawhubSearchTimer.resolve(null);
      clawhubSearchTimer = null;
    }
  }

  return {
    read: readClawHubSearch,
    sync: syncSearch,
    retry: scheduleSearch,
    reset() {
      clearClawHubSearchTimer();
      searchRequest.reset();
      setSearchCompletion(null);
    },
    dispose() {
      clearClawHubSearchTimer();
      searchRequest.cancel();
    },
  };
}
