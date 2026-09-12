export type SqliteWorkerOperations = Record<string, { input: unknown; output: unknown }>;
export type SqliteWorkerCommand<Operations extends SqliteWorkerOperations> = {
  [Key in keyof Operations]: { type: Key; input: Operations[Key]["input"] };
}[keyof Operations];

export type SqliteWorkerBackend<Operations extends SqliteWorkerOperations> = {
  execute(command: SqliteWorkerCommand<Operations>): Operations[keyof Operations]["output"];
  close(): void | Promise<void>;
};

export type SqliteWorkerStore<Operations extends SqliteWorkerOperations> = {
  execute<Key extends keyof Operations>(
    command: { type: Key; input: Operations[Key]["input"] },
    options?: { signal?: AbortSignal },
  ): Promise<Operations[Key]["output"]>;
  close(): Promise<void>;
};

export type SqliteWorkerRequest = {
  id: number;
  actor: number;
} & (
  | {
      type: "open";
      moduleUrl: string;
      sourceLoaderUrl?: string;
      databasePath: string;
      existingIdentity?: string;
      input: Uint8Array;
    }
  | { type: "execute"; input: Uint8Array }
  | { type: "result-next"; transferId: number }
  | { type: "close" }
);

export type SqliteWorkerReply = {
  id: number;
} & (
  | { ok: true; value: Uint8Array; transfer?: "start" | "frame" }
  | { ok: false; retire?: true; error: { name: string; message: string; code?: string | number } }
);

export const SQLITE_WORKER_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
// Larger complete results use bounded frames; this remains the inline reply budget.
export const SQLITE_WORKER_MAX_RESULT_BYTES = 64 * 1024 * 1024;
export const SQLITE_WORKER_TRANSFER_FRAME_BYTES = 8 * 1024 * 1024;
