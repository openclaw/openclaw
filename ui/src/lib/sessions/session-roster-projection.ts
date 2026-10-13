import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { mapSessionResultRows } from "./reconcile.ts";
import type { createSessionRowProvenance } from "./session-row-provenance.ts";

type HeldSessionRows = {
  state: { resultCached?: boolean };
  primaryRows: ReadonlyMap<string, GatewaySessionRow>;
  observedRows: ReadonlyMap<string, readonly GatewaySessionRow[]>;
};

export function createSessionRosterProjection(
  provenance: ReturnType<typeof createSessionRowProvenance>,
  captureHeldRows: (sessionIds?: ReadonlySet<string | undefined>) => HeldSessionRows,
) {
  const { identity, inheritRow, mergeRow, rowRevision } = provenance;
  const indexRows = (
    rows: readonly GatewaySessionRow[],
    agentId?: string | null,
    sessionIds?: ReadonlySet<string | undefined>,
  ) => {
    const indexed = new Map<string, GatewaySessionRow>();
    for (const row of rows) {
      if (sessionIds && !sessionIds.has(row.sessionId)) {
        continue;
      }
      const key = identity(row, agentId);
      if (key) {
        indexed.set(key, row);
      }
    }
    return indexed;
  };
  const merge = (
    result: SessionsListResult | null,
    rows: readonly GatewaySessionRow[],
    agentId?: string | null,
    sourceAgentId?: string | null,
  ) => {
    if (!result || rows.length === 0) {
      return result;
    }
    const offered = indexRows(rows, sourceAgentId);
    return mapSessionResultRows(result, (current) => {
      const key = identity(current, agentId);
      const row = key && offered.get(key);
      if (!row) {
        return current;
      }
      return mergeRow(current, row, agentId);
    });
  };
  const prepareProjection = (requestedRows?: readonly GatewaySessionRow[]) => {
    // Identity includes the verbatim session ID; other IDs cannot donate facts.
    // Event planning still captures every held identity once when no rows are supplied.
    const sessionIds =
      requestedRows &&
      new Set(requestedRows.flatMap((row) => (row.sessionId?.trim() ? [row.sessionId] : [])));
    const { state, primaryRows, observedRows } = captureHeldRows(sessionIds);
    const projectFields = (row: GatewaySessionRow, agentId?: string | null) => {
      const key = identity(row, agentId);
      if (!key) {
        return row;
      }
      let current = row;
      const primary = primaryRows.get(key);
      if (primary && (!state.resultCached || rowRevision(primary) > 0)) {
        current = mergeRow(primary, current, agentId);
      }
      for (const offered of observedRows.get(key) ?? []) {
        current = mergeRow(current, offered, agentId);
      }
      // Field freshness cannot change the caller's tree key.
      return current.key === row.key ? current : inheritRow({ ...current, key: row.key }, current);
    };
    return {
      projectFields,
      projectRows: (rows: readonly GatewaySessionRow[]): GatewaySessionRow[] =>
        rows.map((row) => projectFields(row)),
    };
  };
  const projectFields = (row: GatewaySessionRow, agentId?: string | null) =>
    prepareProjection([row]).projectFields(row, agentId);
  const heldRowsFor = (row: GatewaySessionRow, agentId?: string | null) => {
    const key = identity(row, agentId);
    if (!key) {
      return [];
    }
    const { primaryRows, observedRows } = captureHeldRows();
    const primary = primaryRows.get(key);
    return [...(primary ? [primary] : []), ...(observedRows.get(key) ?? [])];
  };
  const currentRow = (row: GatewaySessionRow, agentId?: string | null) => {
    const held = heldRowsFor(row, agentId)[0];
    return held ? projectFields(held, agentId) : undefined;
  };
  return {
    indexRows,
    merge,
    prepareProjection,
    projectFields,
    currentRow,
  };
}
