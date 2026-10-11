import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { getSessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
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
  const authority = {
    assertCurrent() {
      assertCurrent();
      binding?.authority.assertCurrent();
    },
    authorize: binding?.authority.authorize ?? (() => {}),
  };
  return memorySessionActorOwners
    .list()
    .filter((owner) => path.resolve(owner.path, "../../../..") === root)
    .map((owner) => ({
      agentId: owner.agentId,
      storePath: owner.path,
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
  assertCurrent: () => void,
): void {
  const current = readMemoryProjectStores(assertCurrent);
  for (const store of stores) {
    const entries = current.find((candidate) => candidate.storePath === store.storePath);
    for (const selected of store.entries) {
      const latest = entries?.entries.find(
        (candidate) => candidate.sessionKey === selected.sessionKey,
      );
      const fields = ["sessionId", "lifecycleRevision", "createdActor", "visibility"] as const;
      if (
        !latest ||
        fields.some((field) => !isDeepStrictEqual(selected.entry[field], latest.entry[field])) ||
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
  // Stable locale-equal recency ties retain physical-store and SQLite binary key order.
  const entries = selection.entries
    .map(([key, entry]) => ({
      key,
      entry,
      keyBytes: Buffer.from(key),
      order: paths.get(selection.getTarget(key)!.storeTarget.storePath)!,
    }))
    .toSorted(
      (left, right) => left.order - right.order || Buffer.compare(left.keyBytes, right.keyBytes),
    );
  const store = Object.fromEntries(entries.map(({ key, entry }) => [key, entry]));
  for (const source of memoryStores) {
    for (const { sessionKey, entry } of source.entries) {
      store[sessionKey] = entry;
    }
  }
  return store;
}
