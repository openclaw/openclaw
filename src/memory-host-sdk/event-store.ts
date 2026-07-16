import { createHash } from "node:crypto";
import path from "node:path";
import { createPluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
import type { MemoryHostEventRecord } from "./events.js";

const MEMORY_HOST_EVENTS_PLUGIN_ID = "memory-core";
const MEMORY_HOST_EVENTS_NAMESPACE = "memory-host.events";
const MAX_MEMORY_HOST_EVENTS = 50_000;
const WORKSPACE_HASH_BYTES = 24;

export type StoredMemoryHostEvent = {
  kind: "event";
  workspaceKey: string;
  event: MemoryHostEventRecord;
  recordedAt: number;
  sequence: number;
};

type StoredMemoryHostCursor = {
  kind: "cursor";
  workspaceKey: string;
  lastSequence: number;
};

type StoredMemoryHostEntry = StoredMemoryHostEvent | StoredMemoryHostCursor;

export type PersistedMemoryHostEvent = {
  key: string;
  value: StoredMemoryHostEvent;
  createdAt: number;
};

export function normalizeMemoryHostWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function memoryHostWorkspacePrefix(workspaceDir: string): string {
  return createHash("sha256")
    .update(normalizeMemoryHostWorkspaceKey(workspaceDir))
    .digest("hex")
    .slice(0, WORKSPACE_HASH_BYTES);
}

function openMemoryHostEventStore(env?: NodeJS.ProcessEnv) {
  return createPluginStateSyncKeyedStore<StoredMemoryHostEntry>(MEMORY_HOST_EVENTS_PLUGIN_ID, {
    namespace: MEMORY_HOST_EVENTS_NAMESPACE,
    maxEntries: MAX_MEMORY_HOST_EVENTS,
    ...(env ? { env } : {}),
  });
}

function cursorKey(workspaceDir: string): string {
  return `${memoryHostWorkspacePrefix(workspaceDir)}:cursor`;
}

function allocateEventSequence(params: {
  workspaceDir: string;
  workspaceKey: string;
  store: ReturnType<typeof openMemoryHostEventStore>;
}): number {
  const key = cursorKey(params.workspaceDir);
  const cursor = params.store.lookup(key);
  const existingMax =
    cursor?.kind === "cursor"
      ? cursor.lastSequence
      : params.store.entries().reduce((max, entry) => {
          return entry.value.kind === "event" && entry.value.workspaceKey === params.workspaceKey
            ? Math.max(max, entry.value.sequence)
            : max;
        }, 0);
  let allocated = 0;
  params.store.update?.(key, (current) => {
    const lastSequence =
      current?.kind === "cursor" ? Math.max(current.lastSequence, existingMax) : existingMax;
    allocated = lastSequence + 1;
    return {
      kind: "cursor",
      workspaceKey: params.workspaceKey,
      lastSequence: allocated,
    };
  });
  if (allocated === 0) {
    throw new Error("Memory host event store cannot allocate a workspace sequence");
  }
  return allocated;
}

export function registerMemoryHostEvent(params: {
  workspaceDir: string;
  event: MemoryHostEventRecord;
  env?: NodeJS.ProcessEnv;
}): void {
  const recordedAt = Date.now();
  const workspaceKey = normalizeMemoryHostWorkspaceKey(params.workspaceDir);
  const store = openMemoryHostEventStore(params.env);
  const sequence = allocateEventSequence({
    workspaceDir: params.workspaceDir,
    workspaceKey,
    store,
  });
  store.register(
    `${memoryHostWorkspacePrefix(params.workspaceDir)}:event:${sequence.toString().padStart(16, "0")}`,
    {
      kind: "event",
      workspaceKey,
      event: params.event,
      recordedAt,
      sequence,
    },
  );
}

export function listStoredMemoryHostEvents(params: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
}): PersistedMemoryHostEvent[] {
  const workspaceKey = normalizeMemoryHostWorkspaceKey(params.workspaceDir);
  return openMemoryHostEventStore(params.env)
    .entries()
    .filter(
      (entry): entry is typeof entry & { value: StoredMemoryHostEvent } =>
        entry.value.kind === "event" && entry.value.workspaceKey === workspaceKey,
    )
    .toSorted((left, right) => {
      if (left.value.sequence !== right.value.sequence) {
        return left.value.sequence - right.value.sequence;
      }
      return left.key.localeCompare(right.key);
    });
}
