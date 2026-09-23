import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { SessionCapability } from "./index.ts";
import { fetchPagedSessionRows } from "./paged-session-rows.ts";

// Matches the Gateway default and covers the default 50-child Swarm roster.
// Custom larger groups keep paging through the bounded retry loop below.
const CHILD_SESSION_LIST_PAGE_SIZE = 100;

export function childSessionListQuery(parentKey: string, pageSize = CHILD_SESSION_LIST_PAGE_SIZE) {
  return {
    spawnedBy: parentKey,
    limit: pageSize,
    includeGlobal: false,
    includeUnknown: false,
    configuredAgentsOnly: true,
  };
}

export async function fetchChildSessionRows(params: {
  sessions: Pick<SessionCapability, "refreshList" | "listSnapshot">;
  parentKey: string;
  isCurrent: () => boolean;
  pageSize?: number;
  initialResult?: SessionsListResult;
}): Promise<GatewaySessionRow[] | null> {
  const pageSize = params.pageSize ?? CHILD_SESSION_LIST_PAGE_SIZE;
  const query = childSessionListQuery(params.parentKey, pageSize);
  const readResult = () => {
    const snapshot = params.sessions.listSnapshot(query);
    if (snapshot.error) {
      throw new Error(snapshot.error);
    }
    return snapshot.result;
  };
  if (params.initialResult) {
    // Observation callbacks run before their first read settles. Join that
    // owner before appending; a concurrent append does not queue another page.
    await params.sessions.refreshList(query);
  }
  return fetchPagedSessionRows({
    list: async (offset) => {
      await params.sessions.refreshList({
        ...query,
        ...(offset > 0 ? { offset, append: true } : {}),
      });
      return readResult();
    },
    initialResult: params.initialResult ? readResult() : undefined,
    resultKind: "window",
    isCurrent: params.isCurrent,
    missingResultError: "child session list returned no result",
    incompletePaginationError: "The child session list kept changing. Try again.",
  });
}
