import { requestResult, transactionComplete } from "../../lib/chat/control-ui-database.runtime.ts";
import * as json from "../../lib/snapshot-json.ts";
import {
  debugSnapshotStore,
  openSessionSnapshotDatabase,
  resetSessionSnapshotDatabase,
  SIDEBAR_SNAPSHOT_STORE_NAME,
} from "./session-snapshot-database.ts";

const sidebarRecordsSchema = json.array(
  json.object(
    {
      savedAt: json.refine(json.number, (value) => value >= 0),
      sessionKey: json.refine(json.text, (value) => value.length > 0),
      projectionVersion: json.number,
      model: json.unknown,
    },
    true,
  ),
);
export type SidebarRecord = json.SnapshotValue<typeof sidebarRecordsSchema>[number];
export const SIDEBAR_SNAPSHOT_PROJECTION_VERSION = 4;
export const sidebarRecordBytes = (record: SidebarRecord) =>
  new TextEncoder().encode(JSON.stringify(record)).byteLength;
const SIDEBAR_SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function accessSidebarSnapshot<Model>(
  key: string,
  validate: (value: unknown) => Model | null,
  isCurrent: () => boolean,
  incoming?: SidebarRecord,
): Promise<Model | null> {
  const database = await openSessionSnapshotDatabase();
  if (!database) {
    return null;
  }
  try {
    if (!isCurrent()) {
      return null;
    }
    const transaction = database.transaction(SIDEBAR_SNAPSHOT_STORE_NAME, "readwrite");
    const store = transaction.objectStore(SIDEBAR_SNAPSHOT_STORE_NAME);
    const records = sidebarRecordsSchema.parse(await requestResult(store.getAll()));
    if (!isCurrent()) {
      await transactionComplete(transaction);
      return null;
    }
    const previous =
      incoming && records.find((record) => record.sessionKey === incoming.sessionKey);
    // Tabs share this transaction: an unchanged projection needs no second write.
    const pendingWrite =
      incoming &&
      previous?.projectionVersion === incoming.projectionVersion &&
      Date.now() - previous.savedAt <= SIDEBAR_SNAPSHOT_MAX_AGE_MS &&
      JSON.stringify(previous.model) === JSON.stringify(incoming.model)
        ? undefined
        : incoming;
    const retained = records.filter((record) => record.sessionKey !== pendingWrite?.sessionKey);
    if (pendingWrite) {
      retained.push(pendingWrite);
      store.put(pendingWrite);
    }
    let bytes = 0;
    let count = 0;
    let result: Model | null = null;
    for (const record of retained.toSorted((a, b) => b.savedAt - a.savedAt)) {
      if (record.projectionVersion !== SIDEBAR_SNAPSHOT_PROJECTION_VERSION) {
        store.delete(record.sessionKey);
        continue;
      }
      // Decode the requested presentation only; envelopes bound the other scopes.
      const admitted = record.sessionKey === key ? validate(record.model) : undefined;
      if (admitted === null) {
        store.delete(record.sessionKey);
        continue;
      }
      bytes += sidebarRecordBytes(record);
      if (
        count++ >= 8 ||
        bytes > 512 * 1024 ||
        Date.now() - record.savedAt > SIDEBAR_SNAPSHOT_MAX_AGE_MS
      ) {
        store.delete(record.sessionKey);
      } else if (record.sessionKey === key) {
        result = admitted ?? null;
      }
    }
    await transactionComplete(transaction);
    return isCurrent() ? result : null;
  } catch (error) {
    debugSnapshotStore("resetting cache after sidebar projection failure", error);
    if (isCurrent()) {
      await resetSessionSnapshotDatabase(database);
    }
    return null;
  } finally {
    database.close();
  }
}
