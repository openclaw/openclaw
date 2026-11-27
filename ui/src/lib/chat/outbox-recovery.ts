import { getSafeSessionStorage } from "../../local-storage.ts";
import { outboxPayloadCanRecover } from "./outbox-payload-store.runtime.ts";
import type { ComposerStorageTarget } from "./outbox-store-scope.ts";
import {
  hasStoredComposerDraftInput,
  readStoredOutboxStore,
  storageTargetForGateway,
  storageTargetForComposer,
  type ChatComposerScope,
  type StoredComposerRecovery,
  type StoredComposerState,
} from "./outbox-store.ts";

export type ChatOutboxRecoveryEntry = StoredComposerRecovery & {
  id: string;
  owner: { gatewayOwner: string; recoveryScope?: string };
};
// An existing recovery row owns an interrupted transfer, not a second live queue.
// Its key carries the account claim; the row retains the complete original input.
export const TRANSFER_PREFIX = "transfer:";
export function readTransfer(id: string): { account: string; sourceId: string } | undefined {
  if (!id.startsWith(TRANSFER_PREFIX)) {
    return undefined;
  }
  const value: unknown = JSON.parse(id.slice(TRANSFER_PREFIX.length));
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    !value[0] ||
    typeof value[1] !== "string" ||
    !value[1]
  ) {
    throw new Error("Invalid outbox recovery transfer");
  }
  return { account: value[0], sourceId: value[1] };
}

export function sameRecovery(
  left: StoredComposerRecovery | undefined,
  right: StoredComposerRecovery | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// A retired source claim may already live only in an account recovery bucket.
// Discovery must not offer identical resurrected bytes to another account.
export function transferClaims(
  storage: Storage,
  target: ComposerStorageTarget,
  legacy: StoredComposerState,
) {
  const stores = [legacy];
  const prefix = target.unscopedKey + ":account:";
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) {
      stores.push(
        readStoredOutboxStore(storage, {
          ...target,
          key,
          recoveryScope: decodeURIComponent(key.slice(prefix.length)),
        }),
      );
    }
  }
  return stores.flatMap((store) =>
    Object.entries(store.recovery).flatMap(([id, entry]) => {
      const transfer = readTransfer(id);
      return transfer ? [{ ...transfer, entry }] : [];
    }),
  );
}

export function readChatOutboxRecovery(state: ChatComposerScope): {
  entries: ChatOutboxRecoveryEntry[];
  blocked: boolean;
} {
  const storage = getSafeSessionStorage();
  if (!storage) {
    throw new Error("Browser storage is unavailable");
  }
  const target = storageTargetForComposer(state);
  const store = readStoredOutboxStore(storage, target);
  // Legacy tab metadata has no account claim. Keep it in its original bucket
  // until an explicit review transfers a row; no login adopts or drains it.
  const legacy = target.recoveryScope
    ? readStoredOutboxStore(storage, storageTargetForGateway(state.settings?.gatewayUrl))
    : null;
  const recovery: Record<string, StoredComposerRecovery> = {};
  const add = (id: string, entry: StoredComposerRecovery, isLegacy = false) => {
    const account = readTransfer(id)?.account;
    if (account && account !== target.recoveryScope) {
      return;
    }
    const key = isLegacy && !account ? "legacy-recovery:" + id : id;
    if (recovery[key] && !sameRecovery(recovery[key], entry)) {
      throw new Error("Conflicting outbox recovery transfer");
    }
    recovery[key] = entry;
  };
  for (const [id, entry] of Object.entries(store.recovery)) {
    add(id, entry);
  }
  if (legacy) {
    const claims = transferClaims(
      storage,
      storageTargetForGateway(state.settings?.gatewayUrl),
      legacy,
    );
    const claimed = (id: string, entry: StoredComposerRecovery) =>
      claims.some((claim) => claim.sourceId === id && sameRecovery(claim.entry, entry));
    for (const [key, session] of Object.entries(legacy.sessions)) {
      const id = "legacy-session:" + key;
      const entry: StoredComposerRecovery = { sourceVersion: 4, sourceScopeKey: key, session };
      if (!claimed(id, entry)) {
        recovery[id] = entry;
      }
    }
    for (const [key, entry] of Object.entries(legacy.recovery)) {
      if (!claimed("legacy-recovery:" + key, entry)) {
        add(key, entry, true);
      }
    }
  }
  return {
    entries: Object.entries(recovery)
      // Clear fences are deliberately retained by storage to reject stale writers.
      // They are not input to recover, even when a legacy account has no destination.
      .filter(
        ([, entry]) =>
          (hasStoredComposerDraftInput(entry.session) || Boolean(entry.session.queue?.length)) &&
          (entry.session.queue ?? []).every((item) => outboxPayloadCanRecover(state, item)),
      )
      .map(([id, entry]) =>
        Object.assign({}, entry, {
          id,
          owner: { gatewayOwner: target.gatewayOwner, recoveryScope: target.recoveryScope },
        }),
      ),
    blocked: store.recoveryBlocked === true || legacy?.recoveryBlocked === true,
  };
}
