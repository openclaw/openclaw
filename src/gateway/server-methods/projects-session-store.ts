import type { withIncognitoSessionStoreEntries } from "../../config/sessions/session-incognito-binding.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { prepareSessionRowSelection } from "../session-utils-list.js";

export type IncognitoStores = Parameters<Parameters<typeof withIncognitoSessionStoreEntries>[0]>[0];

export function loadProjectSessionStore(
  projection: SessionRowProjection,
  incognitoStores?: IncognitoStores,
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
  for (const source of incognitoStores ?? []) {
    for (const { sessionKey, entry } of source.entries) {
      if (isIncognitoSessionKey(sessionKey) && entry.incognito === true) {
        store[sessionKey] = entry;
      }
    }
  }
  return store;
}
