import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { getSessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageAuthority } from "../../config/sessions/session-actor-storage-contract.js";
import { resolveStateDir } from "../../config/state-dir.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { prepareSessionRowSelection } from "../session-utils-list.js";

export type MemoryProjectStores = ReturnType<typeof readMemoryProjectStores>;

export function readMemoryProjectStores(assertCurrent: () => void) {
  assertCurrent();
  const binding = getSessionActorStorageBinding({});
  binding?.actor.assertReadable();
  const root = binding
    ? path.resolve(binding.path, "../../../..")
    : path.resolve(resolveStateDir());
  const authority: SessionActorStorageAuthority = {
    assertCurrent() {
      assertCurrent();
      binding?.actor.assertReadable();
      binding?.authority.assertCurrent();
    },
    authorize: (...args) => binding?.authority.authorize(...args),
  };
  return memorySessionActorOwners
    .list()
    .filter((owner) => path.resolve(owner.path, "../../../..") === root)
    .map((owner) => ({
      agentId: owner.agentId,
      storePath: owner.path,
      read: (sessionKey: string) => owner.readSession(sessionKey, authority),
      entries: owner
        .listSessions(authority)
        .flatMap(({ target, entry, members }) =>
          entry ? [{ sessionKey: target.sessionKey, entry, members }] : [],
        ),
    }));
}

/** Only changed disclosure authority retires a prepared private project listing. */
export function assertMemoryProjectStoresCurrent(
  stores: MemoryProjectStores,
  keys: ReadonlySet<string>,
  assertCurrent: () => void,
): void {
  assertCurrent();
  for (const store of stores) {
    for (const selected of store.entries) {
      if (!keys.has(selected.sessionKey)) {
        continue;
      }
      const latest = store.read(selected.sessionKey);
      const fields = ["sessionId", "lifecycleRevision", "createdActor", "visibility"] as const;
      if (
        !latest ||
        fields.some((field) => !isDeepStrictEqual(selected.entry[field], latest.entry?.[field])) ||
        !isDeepStrictEqual(selected.members, latest.members)
      ) {
        throw new Error("Project access changed while preparing the listing. Retry the request.");
      }
    }
  }
}

export function loadProjectSessionStore(
  projection: SessionRowProjection,
  memoryStores: MemoryProjectStores,
) {
  const selection = prepareSessionRowSelection(
    projection,
    {},
    { metadataPrepared: true, ordered: true },
  );
  const paths = projection.state.scope({}).paths;
  const selectedEntries = selection.entries("all");
  const targets = new Map(selectedEntries.map(([key]) => [key, selection.getTarget(key)!]));
  // Stable locale-equal recency ties retain physical-store and SQLite binary key order.
  const entries = selectedEntries
    .map(([key, entry]) => ({
      key,
      entry,
      keyBytes: Buffer.from(key),
      order: paths.get(targets.get(key)!.storeTarget.storePath)!,
    }))
    .toSorted(
      (left, right) => left.order - right.order || Buffer.compare(left.keyBytes, right.keyBytes),
    );
  const store = Object.fromEntries(entries.map(({ key, entry }) => [key, entry]));
  const privateAgents = new Map<string, string>();
  for (const source of memoryStores) {
    for (const { sessionKey, entry } of source.entries) {
      store[sessionKey] = entry;
      privateAgents.set(sessionKey, source.agentId);
    }
  }
  return {
    store,
    agentId: (key: string) => privateAgents.get(key) ?? targets.get(key)?.agentId,
    assertCurrent(keys: Iterable<string>) {
      for (const key of keys) {
        // The memory snapshot retains its own final disclosure guard.
        if (privateAgents.has(key)) {
          continue;
        }
        const target = targets.get(key);
        const query = target && {
          agentId: target.agentId,
          storePath: target.storeTarget.storePath,
          key: target.key,
        };
        const current =
          query && projection.capture(query)?.generation === target?.generation
            ? projection.readCapabilityEntry(query)?.entry
            : undefined;
        const fields = [
          "sessionId",
          "lifecycleRevision",
          "createdActor",
          "visibility",
          "incognito",
        ] as const;
        if (
          !current ||
          fields.some((field) => !isDeepStrictEqual(store[key]?.[field], current[field]))
        ) {
          throw new Error("Project access changed while preparing the listing. Retry the request.");
        }
      }
    },
  };
}
