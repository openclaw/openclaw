// Skill serialization helpers compact skill metadata and coordinate sync queue updates.
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";

const skillsSyncQueue = new KeyedAsyncQueue();

/** Serializes async work by key so repeated skill loads do not race on shared files. */
export async function serializeByKey<T>(key: string, task: () => Promise<T>) {
  return await skillsSyncQueue.enqueue(key, task);
}
