import {
  mergeCombinedSessionStore,
  prepareCombinedSessionStore,
} from "../../config/sessions/combined-store-gateway.js";
import type { withIncognitoSessionStoreEntries } from "../../config/sessions/session-incognito-binding.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { prepareSessionRowSelection } from "../session-utils-list.js";

export type IncognitoStores = Parameters<Parameters<typeof withIncognitoSessionStoreEntries>[0]>[0];

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
