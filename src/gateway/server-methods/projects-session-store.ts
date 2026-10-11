import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  mergeCombinedSessionStore,
  prepareCombinedSessionStore,
} from "../../config/sessions/combined-store-gateway.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { SessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
import type { withIncognitoSessionStoreEntries } from "../../config/sessions/session-incognito-binding.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { prepareSessionRowSelection } from "../session-utils-list.js";

export type IncognitoStores = Parameters<Parameters<typeof withIncognitoSessionStoreEntries>[0]>[0];

export function readMemoryProjectStores(binding: SessionActorStorageBinding) {
  binding.actor.assertReadable();
  const root = path.resolve(binding.path, "../../../..");
  return memorySessionActorOwners
    .list()
    .filter((owner) => path.resolve(owner.path, "../../../..") === root)
    .map((owner) => ({
      agentId: owner.agentId,
      storePath: owner.path,
      entries: owner
        .listSessions(binding.authority)
        .flatMap(({ target, entry, members }) =>
          entry ? [{ sessionKey: target.sessionKey, entry, members }] : [],
        ),
    }));
}

/** Only changed disclosure authority retires a prepared private project listing. */
export function assertMemoryProjectStoresCurrent(
  binding: SessionActorStorageBinding,
  stores: ReturnType<typeof readMemoryProjectStores>,
): void {
  const current = readMemoryProjectStores(binding);
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
  incognitoStores?: IncognitoStores,
) {
  const { cfg } = projection.state;
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
  const options = { projection: "list" as const, includeIncognito: !incognitoStores };
  const prepared = prepareCombinedSessionStore(cfg, options);
  if (incognitoStores) {
    prepared.targets = { ...prepared.targets, incognitoTargets: incognitoStores };
  }
  if (prepared.targets.incognitoTargets.length > 0) {
    // Incognito rows are absent from resident selection; their native owner retains the snapshot.
    Object.assign(
      store,
      mergeCombinedSessionStore(
        cfg,
        options,
        prepared,
        () => [],
        incognitoStores &&
          ((target) =>
            incognitoStores.find((source) => source.storePath === target.storePath)!.entries),
      ).store,
    );
  }
  return store;
}
