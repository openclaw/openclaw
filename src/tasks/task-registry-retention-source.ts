import { sha256StableValue } from "@openclaw/normalization-core/node-crypto";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskRetentionSource = { task: TaskRecord; version: string };

/** Read and write workers bind the complete source without hashing task payloads on the host. */
export function captureTaskRetentionSource(task: TaskRecord): TaskRetentionSource {
  return { task, version: sha256StableValue(task).digest };
}
