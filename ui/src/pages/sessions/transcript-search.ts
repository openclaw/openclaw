import type { SessionListOptions } from "../../lib/sessions/session-capability.ts";
import { searchVisibleSessionTranscripts } from "../../lib/sessions/transcript-search.ts";
import type { SessionsPageRequestScope } from "./request-scope.ts";

export type TranscriptSearchResult = Awaited<ReturnType<typeof searchVisibleSessionTranscripts>>;
export type TranscriptSearchState = {
  transcriptSearchQuery: string;
  transcriptSearch: Promise<TranscriptSearchResult | null> | null;
};

export function createTranscriptSearch(host: {
  state: TranscriptSearchState;
  captureScope: () => SessionsPageRequestScope | null;
  isCurrent: (scope: SessionsPageRequestScope) => boolean;
  listOptions: (scope: SessionsPageRequestScope) => SessionListOptions;
}) {
  const { state } = host;
  function reset(query = state.transcriptSearchQuery) {
    state.transcriptSearchQuery = query;
    state.transcriptSearch = null;
  }
  async function run() {
    const query = state.transcriptSearchQuery.trim();
    if (!query) {
      reset("");
      return;
    }
    const scope = host.captureScope();
    if (!scope) {
      return;
    }
    state.transcriptSearchQuery = query;
    // Replacing or clearing the receipt retires its results without cancelling the transport.
    const isCurrent = () => state.transcriptSearch === result && host.isCurrent(scope);
    const result: Promise<TranscriptSearchResult | null> = searchVisibleSessionTranscripts({
      client: scope.client,
      query,
      listOptions: host.listOptions(scope),
    })
      .catch((error: unknown) => {
        if (isCurrent()) {
          throw error;
        }
        return null;
      })
      .then((value) => (isCurrent() ? value : null));
    state.transcriptSearch = result;
    // Rendering owns errors; command callers still await the admitted request.
    await result.catch(() => undefined);
  }
  return {
    reset,
    run,
    update(this: void, query: string) {
      if (query !== state.transcriptSearchQuery) {
        reset(query);
      }
    },
  };
}
