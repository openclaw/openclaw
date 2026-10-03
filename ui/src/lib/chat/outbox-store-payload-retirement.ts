import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { removeOutboxPayloads } from "./outbox-payload-store.runtime.ts";
import type { StoredComposerState } from "./outbox-store-codec.ts";
import type { ComposerStorageTarget } from "./outbox-store-scope.ts";

// Cleanup follows a verified metadata commit, never a credential-filtered view.
export function retireRemovedOutboxPayloads(
  storage: Storage,
  target: ComposerStorageTarget,
  previous: string | null,
  current: StoredComposerState | null,
): void {
  if (!previous) {
    return;
  }
  try {
    // An unclassified, deferred, or undeletable source can still own these bytes.
    // Keep bounded orphans rather than introduce a second garbage-collection store.
    if (
      [target.legacyKey, target.previousKey, target.blobKey].some(
        (key) => storage.getItem(key) !== null,
      )
    ) {
      return;
    }
    const references = (value: unknown) => {
      if (value === null) {
        return [];
      }
      if (
        !isRecord(value) ||
        value.version !== 4 ||
        value.gatewayOwner !== target.gatewayOwner ||
        !isRecord(value.sessions) ||
        !isRecord(value.recovery)
      ) {
        throw new Error("Unreadable outbox retention source");
      }
      const rows = [
        ...Object.values(value.sessions),
        ...Object.values(value.recovery).map((entry) => {
          if (!isRecord(entry)) {
            throw new Error("Unreadable recovery source");
          }
          return entry.session;
        }),
      ];
      return rows.flatMap((row) => {
        if (!isRecord(row) || (row.queue !== undefined && !Array.isArray(row.queue))) {
          throw new Error("Unreadable outbox row");
        }
        return (row.queue ?? []).flatMap((item: unknown) => {
          if (!isRecord(item)) {
            throw new Error("Unreadable outbox item");
          }
          const ref = item.attachmentPayload;
          if (ref === undefined) {
            return [];
          }
          if (
            !isRecord(ref) ||
            typeof ref.key !== "string" ||
            typeof ref.recoveryScope !== "string" ||
            typeof ref.tabId !== "string"
          ) {
            throw new Error("Unreadable outbox payload reference");
          }
          return [{ key: ref.key, recoveryScope: ref.recoveryScope, tabId: ref.tabId }];
        });
      });
    };
    const remaining = new Set(references(current).map((ref) => ref.key));
    // Explicit recovery commits the destination before retiring the source. Both
    // unscoped and account buckets can still own bytes after a partial transfer.
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key &&
        key !== target.key &&
        (key === target.unscopedKey || key.startsWith(target.unscopedKey + ":account:"))
      ) {
        const raw = storage.getItem(key);
        if (raw) {
          for (const ref of references(JSON.parse(raw))) {
            remaining.add(ref.key);
          }
        }
      }
    }
    const removed = references(JSON.parse(previous)).filter((ref) => !remaining.has(ref.key));
    if (removed.length) {
      void removeOutboxPayloads(removed);
    }
  } catch {
    // Missing/unreadable storage cannot authorize deletion; the Blob budget bounds retention.
  }
}
