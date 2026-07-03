// Skill serialization helpers compact skill metadata and coordinate sync queue updates.
import { enqueueKeyedTask } from "openclaw/plugin-sdk/keyed-async-queue";

const SKILLS_SYNC_QUEUE = new Map<string, Promise<void>>();

/** Serializes async work by key so repeated skill loads do not race on shared files. */
export async function serializeByKey<T>(key: string, task: () => Promise<T>) {
  return await enqueueKeyedTask({ tails: SKILLS_SYNC_QUEUE, key, task });
}
