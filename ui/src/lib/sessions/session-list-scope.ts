import type { SessionListOptions, SessionListScope } from "./session-capability.ts";
import { normalizeAgentId } from "./session-key.ts";
import { buildSessionListParams, DEFAULT_SESSION_LIST_QUERY } from "./session-requests.ts";

export type ManagedSessionListQuery = Readonly<Record<string, unknown>> & {
  readonly limit: number;
};

export function normalizeManagedSessionListQuery(
  options: SessionListOptions,
): ManagedSessionListQuery {
  const { offset: _offset, append: _append, ...queryOptions } = options;
  const limit =
    typeof options.limit === "number" && options.limit > 0
      ? Math.floor(options.limit)
      : DEFAULT_SESSION_LIST_QUERY.limit;
  return Object.freeze({ ...buildSessionListParams({ ...queryOptions, limit }), limit });
}

export function isPrimarySessionListQuery(options: SessionListScope): boolean {
  if (options.includeDerivedTitles === false || options.includeLastMessage === false) {
    return false;
  }
  const query = normalizeManagedSessionListQuery(options);
  return (
    query.archived === undefined &&
    !query.spawnedBy &&
    !query.boardFace &&
    !query.activeMinutes &&
    !query.search &&
    !query.ownerId &&
    query.involvingMe !== true &&
    query.includeGlobal === true &&
    query.includeUnknown === true &&
    query.configuredAgentsOnly === true
  );
}

export function sessionListAgentMatches(
  queryAgentId: string | undefined,
  agentId: string | null | undefined,
): boolean {
  return (
    !agentId?.trim() ||
    !queryAgentId ||
    normalizeAgentId(queryAgentId) === normalizeAgentId(agentId)
  );
}
