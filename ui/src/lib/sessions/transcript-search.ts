import type { SessionsSearchResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionListOptions } from "./session-capability.ts";
import { buildSessionListParams } from "./session-requests.ts";

type VisibleSessionTranscriptSearchResult = SessionsSearchResult & {
  sessions: GatewaySessionRow[];
};

export async function searchVisibleSessionTranscripts(params: {
  client: GatewayBrowserClient;
  query: string;
  listOptions: SessionListOptions;
  isCurrent?: () => boolean;
}): Promise<VisibleSessionTranscriptSearchResult> {
  if (params.isCurrent && !params.isCurrent()) {
    return { results: [], sessions: [] };
  }
  // Roster pagination and row enrichment never restrict the searchable corpus.
  // The Gateway applies membership and sharing before its bounded FTS result.
  const {
    limit: _limit,
    offset: _offset,
    includeDerivedTitles: _titles,
    includeLastMessage: _preview,
    ownerFirst: _ownerFirst,
    ...scope
  } = buildSessionListParams(params.listOptions);
  return params.client.request<VisibleSessionTranscriptSearchResult>("sessions.search", {
    query: params.query,
    limit: 25,
    scope,
  });
}
