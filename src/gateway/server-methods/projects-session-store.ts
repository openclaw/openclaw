import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { getSessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageAuthority } from "../../config/sessions/session-actor-storage-contract.js";
import { sessionCreatorProfileId } from "../../config/sessions/session-entry-provenance.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { resolveStateDir } from "../../config/state-dir.js";
import type { SelectionRow } from "../session-row-projection-record.js";
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

const projectSessionStores = new WeakMap<
  SessionRowProjection,
  { revision: object; snapshot: ReturnType<typeof createProjectSessionStore> }
>();

export function loadProjectSessionStore(
  projection: SessionRowProjection,
  memoryStores: MemoryProjectStores,
) {
  // Private actors have a request-scoped disclosure lifetime, outside the durable revision.
  if (memoryStores.some((source) => source.entries.length > 0)) {
    return createProjectSessionStore(projection, memoryStores);
  }
  const { revision } = projection.state;
  let cached = projectSessionStores.get(projection);
  if (cached?.revision !== revision) {
    cached = { revision, snapshot: createProjectSessionStore(projection, memoryStores) };
    projectSessionStores.set(projection, cached);
  }
  return cached.snapshot;
}

function createProjectSessionStore(
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
  const privateKeys = new Set<string>();
  for (const source of memoryStores) {
    for (const { sessionKey, entry } of source.entries) {
      store[sessionKey] = entry;
      privateKeys.add(sessionKey);
    }
  }
  return Object.freeze({
    store: Object.freeze(store),
    readMembership(key: string) {
      const target = targets.get(key);
      return (
        target &&
        projection.readMembership({
          key: target.key,
          agentId: target.agentId,
          storePath: target.storeTarget.storePath,
        })
      );
    },
    assertCurrent(keys: Iterable<string>) {
      for (const key of keys) {
        // The memory snapshot retains its own final disclosure guard.
        if (privateKeys.has(key)) {
          continue;
        }
        const target = targets.get(key);
        assertProjectEntryCurrent(projection, target, store[key]);
      }
    },
  });
}

function assertProjectEntryCurrent(
  projection: SessionRowProjection,
  target: SelectionRow | undefined,
  entry: SessionEntry | undefined,
) {
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
  if (!current || fields.some((field) => !isDeepStrictEqual(entry?.[field], current[field]))) {
    throw new Error("Project access changed while preparing the listing. Retry the request.");
  }
}

/** Merge private snapshots with the projection's already ordered, profile-scoped candidates. */
export async function loadProjectRecentCandidates(
  projection: SessionRowProjection,
  memoryStores: MemoryProjectStores,
  profileIds: ReadonlySet<string>,
) {
  const durable = await projection.projectRecentCandidates(profileIds);
  const privateEntries = new Map<string, { key: string; entry: SessionEntry; agentId: string }>();
  for (const source of memoryStores) {
    for (const { sessionKey, entry } of source.entries) {
      privateEntries.set(sessionKey, { key: sessionKey, entry, agentId: source.agentId });
    }
  }
  const privateCandidates = [...privateEntries.values()]
    .filter(({ entry }) => {
      const profileId = sessionCreatorProfileId(entry.createdActor);
      return profileId !== undefined && profileIds.has(profileId);
    })
    .toSorted(
      (left, right) =>
        (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0) ||
        left.key.localeCompare(right.key),
    );
  const selected = new Map<string, SelectionRow>();
  return {
    candidates: (function* () {
      const iterator = durable[Symbol.iterator]();
      let next = iterator.next();
      let privateOffset = 0;
      while (!next.done || privateOffset < privateCandidates.length) {
        if (!next.done && privateEntries.has(next.value.key)) {
          next = iterator.next();
          continue;
        }
        const memory = privateCandidates[privateOffset];
        const row = next.done ? undefined : next.value;
        const compare =
          row && memory
            ? (memory.entry.updatedAt ?? 0) - (row.entry.updatedAt ?? 0) ||
              row.key.localeCompare(memory.key)
            : 0;
        // Memory keys are disjoint from durable admission; stable ties append after durable rows.
        if (row && (!memory || compare <= 0)) {
          selected.set(row.key, row);
          yield row;
          next = iterator.next();
        } else if (memory) {
          yield memory;
          privateOffset++;
        }
      }
    })(),
    assertCurrent(keys: Iterable<string>) {
      for (const key of keys) {
        if (!privateEntries.has(key)) {
          const target = selected.get(key);
          assertProjectEntryCurrent(projection, target, target?.entry);
        }
      }
    },
  };
}
