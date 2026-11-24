import type { MessagePort } from "node:worker_threads";

/** Core modules the lean profile runs as logical endpoints of one shared host isolate. */
export type SharedWorkerHostKind =
  | "sqlite-store"
  | "session-transcript"
  | "state-read"
  | "plugin-model-catalog-read";

export type SharedWorkerHostRequest =
  | {
      type: "attach";
      id: number;
      kind: SharedWorkerHostKind;
      port: MessagePort;
      workerData: unknown;
      ready: boolean;
    }
  | { type: "stop"; id: number };

export type SharedWorkerHostReply =
  | { type: "started" | "stopped"; id: number }
  | { type: "failed"; id: number; reason: string };

/** Carrier identity shared by broker routing and physical-memory accounting. */
export const sharedHostSqliteKeys = {
  agent: "sqlite-store:agent",
  "shared-state": "sqlite-store:shared-state",
} as const;
