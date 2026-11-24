import type { SkillsSearchParams } from "@openclaw/gateway-protocol";
import { sleepWithAbort } from "@openclaw/retry";
import { createMemo, createSignal } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createPageRequest, type PageReadResult } from "../../lib/page-request.ts";
import { searchClawHub } from "../../lib/skills/clawhub-search.ts";
import type { SkillsState } from "../../lib/skills/index.ts";

/** Retire debounce, transport, and cursor together when the discovery selection changes. */
export function createSkillsDiscoveryRequest(data: SkillsState) {
  const [nextCursor, setNextCursor] = createSignal<string | null>(null);
  const [searchCompletion, setSearchCompletion] = createSignal<Promise<PageReadResult> | null>(
    null,
  );
  const searchRequest = createPageRequest(() => {}, {
    task: async (
      {
        client,
        params,
        debounce,
      }: { client: GatewayBrowserClient; params: SkillsSearchParams; debounce: boolean },
      { signal },
    ) => {
      if (debounce) {
        await sleepWithAbort(300, signal);
      }
      return { page: await searchClawHub(client, params, signal), cursor: params.cursor };
    },
    onComplete: ({ page, cursor }) => {
      data.clawhubSearchResults = cursor
        ? [...(data.clawhubSearchResults ?? []), ...page.results]
        : page.results;
      setNextCursor(page.nextCursor ?? null);
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
  function reset() {
    searchRequest.reset();
    setSearchCompletion(null);
    setNextCursor(null);
  }
  return {
    reset,
    read: readClawHubSearch,
    nextCursor,
    run(client: GatewayBrowserClient, params: SkillsSearchParams, debounce: boolean) {
      if (params.cursor && searchRequest.pending) {
        return;
      }
      if (!params.cursor) {
        data.clawhubSearchResults = null;
        setNextCursor(null);
      }
      void searchRequest.run({ client, params, debounce });
      void setSearchCompletion(searchRequest.read);
    },
  };
}
