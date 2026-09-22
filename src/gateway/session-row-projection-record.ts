import type { SessionStoreTarget } from "../config/sessions/targets.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { resolveProjectedAgentRunModel } from "../infra/agent-run-registry.js";
import type { readSessionRowFacts } from "./server-methods/session-placement-read-projection.js";
import type { compareSessionEntryPairs } from "./session-list-order.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import * as rowProjection from "./session-utils-row.js";

export type Row = {
  key: string;
  agentId: string;
  storeTarget: SessionStoreTarget;
  storedEntry?: SessionEntry;
  entry?: SessionEntry;
  materialized?: ReturnType<typeof rowProjection.materializeSessionRow>;
  materializedSequence?: number;
  fallbackModel?: ReturnType<
    typeof rowProjection.readSessionRowInputs
  >["presentation"]["activeModel"];
  facts?: ReturnType<typeof readSessionRowFacts>;
  membership: ReadonlySet<string>;
  parents: Set<string>;
  generation: string | symbol;
};
export type Query = {
  agentId?: string;
  storePath?: string;
  key?: string;
  parentSessionKey?: string;
  sortBy?: Parameters<typeof compareSessionEntryPairs>[2];
};
export type Inputs = Parameters<typeof rowProjection.readSessionRowInputs>[0];
export type SnapshotOptions = Pick<
  Inputs,
  "now" | "includeDerivedTitles" | "includeLastMessage" | "excludedChildKeys"
> & { active?: boolean };
export type Lookup = { agentId: string; key: string; storePath?: string };
type RowTarget = Pick<Row, "agentId" | "key" | "storeTarget">;
export const identity = (row: RowTarget) =>
  `${row.agentId}\0${row.storeTarget.storePath}\0${row.key}`;
export const physical = (storePath: string, key: string) => `physical:${storePath}\0${key}`;
export const logical = (agentId: string, key: string) => `logical:${agentId}\0${key}`;
export const references = (row: RowTarget) => [
  logical(row.agentId, row.key),
  physical(row.storeTarget.storePath, row.key),
];
export function create(target: RowTarget, entry?: SessionEntry): Row {
  return {
    ...target,
    storedEntry: entry,
    parents: new Set(),
    membership: new Set(),
    generation: Symbol("row"),
  };
}
export type MaterializedRow = Row & Required<Pick<Row, "entry" | "materialized">>;
export function ready(row: Row | undefined): row is MaterializedRow {
  return Boolean(row?.entry && row.materialized);
}

export function first(candidates: Row[], storePaths: Iterable<string>) {
  return candidates.length < 2
    ? candidates[0]
    : [...storePaths].flatMap((sourcePath) =>
        candidates.filter((row) => row.storeTarget.storePath === sourcePath),
      )[0];
}

export function present(
  record: MaterializedRow,
  context: SessionListRowContext,
  options: SnapshotOptions = {},
) {
  const now = options.now ?? Date.now();
  const live = resolveProjectedAgentRunModel({
    agentId: record.agentId,
    sessionId: record.entry.sessionId,
    index: context.projectedAgentRuns!,
  });
  const active = options.active ?? (live !== undefined || record.entry.status === "running");
  const row = rowProjection.presentSessionRow(record.materialized, {
    now,
    subagentRuns: context.subagentRuns.atTime(now),
    activeModel: active ? (live ?? undefined) : record.fallbackModel,
    excludedChildKeys: options.excludedChildKeys,
  });
  Object.assign(row, record.facts?.present());
  if (!options.includeDerivedTitles) {
    delete row.derivedTitle;
  }
  if (!options.includeLastMessage) {
    delete row.lastMessagePreview;
  }
  return row;
}
