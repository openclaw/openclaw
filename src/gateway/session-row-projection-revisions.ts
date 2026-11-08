import { isDeepStrictEqual } from "node:util";
import { recordSessionRowSelectionReset } from "../infra/gateway-work-metrics.js";
import { isIncognitoSessionKey, normalizeAgentId } from "../routing/session-key.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { notifyListeners } from "../shared/listeners.js";
import type { readResidentSessionRow } from "./session-row-projection-materialize.js";
import {
  identity,
  selectionRow,
  ready,
  publishTranscriptFields,
  type Row,
  type SelectionChange,
} from "./session-row-projection-record.js";

type FactsChange = { kind: "reset" } | { kind: "row"; key: string };

/** Sharing fences every publication; selection holds only unchanged metadata. */
export function createSessionRowProjectionRevisions(
  rows: ReadonlyMap<string, Row>,
  byKey: ReadonlyMap<string, ReadonlySet<string>>,
) {
  let sharing: object | undefined;
  let selection: object | undefined;
  let taskPublication: object | undefined;
  let changeScope: string | undefined;
  const selectionListeners = new Set<(change: SelectionChange) => void>();
  const factsListeners = new Set<(change: FactsChange) => void>();
  const publishFacts = (row?: Pick<Row, "key">) => {
    const change: FactsChange = row ? { kind: "row", key: row.key } : { kind: "reset" };
    notifyListeners(factsListeners, change, () =>
      notifyListeners(factsListeners, { kind: "reset" }),
    );
  };
  const invalidate = (metadataChanged = false) => {
    sharing = undefined;
    if (metadataChanged) {
      selection = undefined;
    }
  };
  const publishSelection = (row?: Row, removed = false) => {
    if (!row || removed) {
      taskPublication = undefined;
    }
    if (!row) {
      invalidate(true);
      recordSessionRowSelectionReset();
    }
    const change: SelectionChange = row
      ? {
          kind: "row",
          id: identity(row),
          key: row.key,
          agentId: row.agentId,
          row: removed ? undefined : selectionRow(row),
          ...(changeScope === undefined ? {} : { scope: changeScope }),
        }
      : { kind: "reset" };
    // Failed derived updates retire orders without interrupting accepted row maintenance.
    notifyListeners(selectionListeners, change, () =>
      notifyListeners(selectionListeners, { kind: "reset" }),
    );
  };
  return {
    withChangeScope<T>(scope: string | undefined, publish: () => T): T {
      const previous = changeScope;
      changeScope = scope;
      try {
        return publish();
      } finally {
        changeScope = previous;
      }
    },
    onSelectionChange(this: void, listener: (change: SelectionChange) => void) {
      selectionListeners.add(listener);
    },
    onFactsChange(this: void, listener: (change: FactsChange) => void) {
      factsListeners.add(listener);
    },
    publishFacts,
    publishRuntimeChange(change: SessionRowChange) {
      // Unprepared metadata can change lineage before row replacement catches up.
      if (change.factsInvalidated || ("all" in change && change.scope === "config")) {
        taskPublication = undefined;
      }
      if ("all" in change) {
        if (change.scope === "agent-runs" && change.runtimeSession) {
          const { sessionId, agentId } = change.runtimeSession;
          const owner = agentId ? normalizeAgentId(agentId) : undefined;
          for (const id of byKey.get(`id:${sessionId}`) ?? []) {
            const row = rows.get(id);
            if (row && (!owner || row.agentId === owner)) {
              publishFacts(row);
            }
          }
        } else {
          publishFacts();
        }
        return;
      }
      publishFacts({ key: change.sessionKey });
      // Runtime owners can select other logical keys through the same backing session ID.
      for (const id of byKey.get(`key:${change.sessionKey}`) ?? []) {
        const row = rows.get(id);
        for (const aliasId of row?.entry ? (byKey.get(`id:${row.entry.sessionId}`) ?? []) : []) {
          const alias = rows.get(aliasId);
          if (alias) {
            publishFacts(alias);
          }
        }
      }
    },
    publishSelection,
    publishTranscript(
      row: Row,
      fields: Parameters<typeof publishTranscriptFields>[1],
      cfg: Parameters<typeof publishTranscriptFields>[2],
      context: Parameters<typeof publishTranscriptFields>[3],
    ) {
      const current = rows.get(identity(row));
      // Preview publication changes this live row without replacing selection inputs.
      if (ready(current) && publishTranscriptFields(current, fields, cfg, context)) {
        publishFacts(current);
      }
    },
    dispose() {
      publishSelection();
      publishFacts();
      selectionListeners.clear();
      factsListeners.clear();
    },
    sharing: () => (sharing ??= {}),
    selection: () => (selection ??= {}),
    taskPublication: () => (taskPublication ??= {}),
    invalidate,
    materialized(
      row: Row,
      prepared: ReturnType<typeof readResidentSessionRow> &
        Pick<Row, "materializedSequence" | "profileRevision" | "subagentRevision">,
    ) {
      const boardChanged = row.hasBoard !== prepared.hasBoard;
      const sharingChanged = row.membership !== prepared.membership;
      const changed =
        boardChanged ||
        sharingChanged ||
        row.materialized !== prepared.materialized ||
        row.facts !== prepared.facts ||
        row.fallbackModel !== prepared.fallbackModel;
      Object.assign(row, prepared);
      if (!changed) {
        return;
      }
      if (boardChanged || sharingChanged) {
        invalidate(boardChanged);
      }
      publishFacts(row);
      if (boardChanged && !isIncognitoSessionKey(row.key)) {
        publishSelection(row);
      }
    },
    replace(previous: Row | undefined, row: Row) {
      if (
        !previous ||
        !row.sharingEntry ||
        previous.generation !== row.generation ||
        previous.entry?.sessionId !== row.entry?.sessionId ||
        previous.entry?.lifecycleRevision !== row.entry?.lifecycleRevision ||
        !isDeepStrictEqual(previous.parents, row.parents)
      ) {
        taskPublication = undefined;
      }
      const changed =
        !previous ||
        previous.generation !== row.generation ||
        previous.hasBoard !== row.hasBoard ||
        previous.entry !== row.entry;
      invalidate(changed);
      publishFacts(row);
      if (changed) {
        publishSelection(row);
      }
    },
  };
}
