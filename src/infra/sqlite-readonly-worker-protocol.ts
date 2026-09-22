import type { SqliteSchemaHeader } from "./sqlite-schema-header.js";

// Keep the one-shot execFile output limit when inspections use IPC.
export const SQLITE_READONLY_WORKER_MAX_BUFFER = 1024 * 1024;

export type SqliteReadOnlyWorkerMode = "sync" | "async" | "schema-header";
export type SqliteReadOnlyWorkerResult =
  | { ok: true; location: string }
  | { ok: true; header: SqliteSchemaHeader }
  | { ok: false; message: string };
