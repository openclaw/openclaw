export const multiNamespaceEntrypoint = {
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "multi-namespace.worker.test-support",
  distWorkerPath: "infra/database-engine/multi-namespace.worker.test-support.js",
} as const;

export type NamespaceCommand =
  | { op: "write"; id: string; text: string; hold?: boolean }
  | { op: "search"; text: string; withoutSearchPath?: boolean }
  | { op: "reopen"; namespace?: string }
  | { op: "close" };
export type NamespaceIdentity = {
  namespace: string;
  storeId: string;
  pid: number;
  database: string;
};
