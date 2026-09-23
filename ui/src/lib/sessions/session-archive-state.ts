import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { SessionPatchResult } from "./patch.ts";
import { projectSessionResultRows } from "./reconcile.ts";
import type { SessionArchiveVisibility } from "./session-capability.ts";
import type { SessionArchiveFields } from "./session-pending-rows.ts";
import {
  mergeSessionFieldObservations,
  type FieldObservation,
  type createSessionRowProvenance,
} from "./session-row-provenance.ts";

export const projectSessionArchiveFields = (
  archived: boolean,
  entry?: SessionPatchResult["entry"],
): SessionArchiveFields =>
  archived
    ? {
        archived: true,
        pinned: false,
        pinnedAt: undefined,
        ...(entry
          ? {
              archivedAt: entry.archivedAt,
              archivedBy: entry.archivedBy,
              archiveReason: entry.archiveReason,
            }
          : {}),
      }
    : { archived: false, archivedAt: undefined, archivedBy: undefined, archiveReason: undefined };

type ArchiveMetadata = Pick<GatewaySessionRow, "archivedAt" | "archivedBy" | "archiveReason">;
type ConfirmedArchiveState = ArchiveMetadata & {
  sessionId: string;
  archived: boolean;
  observation: FieldObservation;
};

export function createSessionArchiveState(
  publishedRow: (key: string) => GatewaySessionRow | undefined,
  onChange: () => void,
  provenance: Pick<
    ReturnType<typeof createSessionRowProvenance>,
    "fieldObservation" | "observeFields" | "inheritRow" | "mergeRow"
  >,
) {
  const confirmed = new Map<string, ConfirmedArchiveState>();
  const record = (
    key: string,
    archived: boolean,
    row: ArchiveMetadata & { sessionId: string },
    observation: FieldObservation,
  ): boolean => {
    const previous = confirmed.get(key);
    if (
      previous &&
      previous.sessionId !== row.sessionId &&
      observation.source.revision <= previous.observation.source.revision
    ) {
      return false;
    }
    const sameIncarnation = previous?.sessionId === row.sessionId ? previous : undefined;
    const merged = mergeSessionFieldObservations(sameIncarnation?.observation, observation);
    if (sameIncarnation && !merged.useOffered) {
      if (merged.observation === sameIncarnation.observation) {
        return false;
      }
      confirmed.set(key, { ...sameIncarnation, observation: merged.observation });
      return true;
    }
    const sameArchive = sameIncarnation?.archived ? sameIncarnation : undefined;
    // Keep the restore receipt too: an older rowless acknowledgement must not recreate the archive.
    confirmed.set(key, {
      sessionId: row.sessionId,
      archived,
      observation: merged.observation,
      ...(archived
        ? {
            archivedAt: row.archivedAt ?? sameArchive?.archivedAt,
            archivedBy: row.archivedBy ?? sameArchive?.archivedBy,
            archiveReason: row.archiveReason ?? sameArchive?.archiveReason,
          }
        : {}),
    });
    return true;
  };
  const pending = new Map<string, { sessionId: string | undefined; token: symbol }>();
  const clear = (key: string) => {
    confirmed.delete(key.trim());
    pending.delete(key.trim());
  };
  const applyRow = (row: GatewaySessionRow): GatewaySessionRow => {
    const archive = confirmed.get(row.key);
    if (!archive || !row.sessionId) {
      return row;
    }
    // Only a newly admitted incarnation can replace the held receipt.
    record(
      row.key,
      row.archived === true,
      { ...row, sessionId: row.sessionId },
      provenance.fieldObservation(row, "archived"),
    );
    const current = confirmed.get(row.key);
    if (!current || current.sessionId !== row.sessionId) {
      return row;
    }
    const fields = projectSessionArchiveFields(current.archived);
    if (current.archived) {
      if (current.archivedAt !== undefined) {
        fields.archivedAt = current.archivedAt;
      }
      if (current.archivedBy !== undefined) {
        fields.archivedBy = current.archivedBy;
      }
      if (current.archiveReason !== undefined) {
        fields.archiveReason = current.archiveReason;
      }
    }
    const entries = Object.entries(fields);
    const values: Record<string, unknown> = row;
    if (
      entries.every(([name, value]) => {
        const observed = provenance.fieldObservation(row, name);
        return (
          values[name] === value &&
          Object.hasOwn(values, name) === (value !== undefined) &&
          mergeSessionFieldObservations(observed, current.observation).observation === observed
        );
      })
    ) {
      // Preserve unrelated writer normalization through the existing self-merge owner.
      return provenance.mergeRow(row, row);
    }
    const offered = provenance.inheritRow({ ...row, ...fields }, row);
    for (const [name, value] of entries) {
      if (value === undefined) {
        Reflect.deleteProperty(offered, name);
      }
    }
    provenance.observeFields(offered, Object.keys(fields), current.observation);
    return provenance.mergeRow(row, offered);
  };
  return {
    clear,
    confirm: (
      key: string,
      archived: boolean,
      row: ArchiveMetadata & { sessionId: string },
      observation: FieldObservation,
    ): boolean => {
      const normalizedKey = key.trim();
      const previous = confirmed.get(normalizedKey);
      const current = publishedRow(normalizedKey);
      if (
        (current?.sessionId && current.sessionId !== row.sessionId) ||
        (previous && previous.sessionId !== row.sessionId && current?.sessionId !== row.sessionId)
      ) {
        return false;
      }
      // Acknowledgements certify this incarnation; pending tokens keep their own lifetime.
      return record(normalizedKey, archived, row, observation);
    },
    clearAll: () => {
      confirmed.clear();
      pending.clear();
    },
    observe: (key: string, archived: boolean | null, row?: GatewaySessionRow): void => {
      const normalizedKey = key.trim();
      if (!normalizedKey || archived === null || !row?.sessionId) {
        return;
      }
      if (archived && pending.get(normalizedKey)?.sessionId === row.sessionId) {
        pending.delete(normalizedKey);
      }
      record(
        normalizedKey,
        archived,
        { ...row, sessionId: row.sessionId },
        provenance.fieldObservation(row, "archived"),
      );
    },
    applyRow,
    apply: (result: SessionsListResult | null): SessionsListResult | null => {
      if (!result || confirmed.size === 0) {
        return result;
      }
      const sessions = result.sessions.map(applyRow);
      return projectSessionResultRows(result, sessions);
    },
    visibility: (key: string): SessionArchiveVisibility | undefined => {
      const normalizedKey = key.trim();
      const pendingArchive = pending.get(normalizedKey);
      const row = publishedRow(normalizedKey);
      if (pendingArchive && (!row || row.sessionId === pendingArchive.sessionId)) {
        return "pending";
      }
      const archive = confirmed.get(normalizedKey);
      if (!archive?.archived) {
        return undefined;
      }
      // Share the archive confirmation with event-driven actions, but never
      // hide a same-key replacement whose durable identity does not match.
      return row && archive.sessionId !== row.sessionId ? undefined : "archived";
    },
    beginPending: (key: string, sessionId: string | undefined): (() => void) | null => {
      const normalizedKey = key.trim();
      const current = pending.get(normalizedKey);
      if (!normalizedKey || (current && current.sessionId === sessionId)) {
        return null;
      }
      const token = Symbol("session-archive");
      pending.set(normalizedKey, { sessionId, token });
      onChange();
      return () => {
        // A reconnect or same-key replacement can begin a newer archive.
        if (pending.get(normalizedKey)?.token !== token) {
          return;
        }
        pending.delete(normalizedKey);
        onChange();
      };
    },
  };
}
