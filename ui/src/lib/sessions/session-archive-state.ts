import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { SessionPatchResult } from "./patch.ts";
import { mapSessionResultRows } from "./reconcile.ts";
import type { SessionArchiveVisibility } from "./session-capability.ts";
import type { SessionArchiveFields } from "./session-pending-rows.ts";
import type { createSessionRowProvenance } from "./session-row-provenance.ts";

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

type ArchiveMetadata = Pick<
  GatewaySessionRow,
  "archivedAt" | "archivedBy" | "archiveReason" | "updatedAt"
>;
type ConfirmedArchiveState = ArchiveMetadata & {
  sessionId: string;
  archived: boolean;
};

export function createSessionArchiveState(
  publishedRow: (key: string) => GatewaySessionRow | undefined,
  onChange: () => void,
  provenance: Pick<ReturnType<typeof createSessionRowProvenance>, "inheritRow">,
) {
  const confirmed = new Map<string, ConfirmedArchiveState>();
  const record = (
    key: string,
    archived: boolean,
    row: ArchiveMetadata & { sessionId: string },
  ): boolean => {
    const previous = confirmed.get(key);
    const sameIncarnation = previous?.sessionId === row.sessionId ? previous : undefined;
    if (
      sameIncarnation?.updatedAt != null &&
      row.updatedAt != null &&
      row.updatedAt < sameIncarnation.updatedAt
    ) {
      return false;
    }
    const sameArchive = sameIncarnation?.archived ? sameIncarnation : undefined;
    // Keep the restore receipt too: an older rowless acknowledgement must not recreate the archive.
    confirmed.set(key, {
      sessionId: row.sessionId,
      archived,
      updatedAt: row.updatedAt ?? sameIncarnation?.updatedAt,
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
    const current = confirmed.get(row.key);
    if (!current || current.sessionId !== row.sessionId) {
      return row;
    }
    const fields = projectSessionArchiveFields(current.archived);
    if (!current.archived && row.archived === undefined) {
      Reflect.deleteProperty(fields, "archived");
    }
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
      entries.every(
        ([name, value]) =>
          values[name] === value && Object.hasOwn(values, name) === (value !== undefined),
      )
    ) {
      return row;
    }
    const offered = provenance.inheritRow({ ...row, ...fields }, row);
    for (const [name, value] of entries) {
      if (value === undefined) {
        Reflect.deleteProperty(offered, name);
      }
    }
    return offered;
  };
  const observe = (key: string, archived: boolean | null, row?: GatewaySessionRow): void => {
    const normalizedKey = key.trim();
    if (!normalizedKey || archived === null || !row?.sessionId) {
      return;
    }
    if (archived && pending.get(normalizedKey)?.sessionId === row.sessionId) {
      pending.delete(normalizedKey);
    }
    record(normalizedKey, archived, { ...row, sessionId: row.sessionId });
  };
  return {
    clear,
    confirm: (
      key: string,
      archived: boolean,
      row: ArchiveMetadata & { sessionId: string },
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
      return record(normalizedKey, archived, row);
    },
    clearAll: () => {
      confirmed.clear();
      pending.clear();
    },
    observe,
    observeRead(row: GatewaySessionRow) {
      if (confirmed.has(row.key)) {
        observe(row.key, row.archived === true, row);
      }
    },
    applyRow,
    apply: (result: SessionsListResult | null): SessionsListResult | null => {
      if (!result || confirmed.size === 0) {
        return result;
      }
      return mapSessionResultRows(result, applyRow);
    },
    visibility: (key: string): SessionArchiveVisibility | undefined => {
      const normalizedKey = key.trim();
      const pendingArchive = pending.get(normalizedKey);
      const archive = confirmed.get(normalizedKey);
      // Ordinary rows and confirmed restores need no incarnation check. Avoid
      // scanning the published roster for every visible sidebar row.
      if (!pendingArchive && !archive?.archived) {
        return undefined;
      }
      const row = publishedRow(normalizedKey);
      if (pendingArchive && (!row || row.sessionId === pendingArchive.sessionId)) {
        return "pending";
      }
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
