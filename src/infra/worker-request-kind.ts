import { basename } from "node:path";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";

const standaloneKinds = {
  "catalog-page.worker.js": "catalog",
  "code-mode.worker.js": "codeMode",
  "compaction-planning.worker.js": "compaction",
  "disk-budget.worker.js": "diskBudget",
  "document-extractor.worker.js": "document",
  "manager-index.worker.js": "memoryIndex",
  "manager-search.worker.js": "memorySearch",
  "memory-index.worker.js": "memoryIndex",
  "memory-search.worker.js": "memorySearch",
  "run.worker.js": "teamReports",
  "session-history.worker.js": "sessionHistory",
} as const;

export type WorkerRequestKind =
  | keyof typeof runtimeProcessEntrypoints
  | (typeof standaloneKinds)[keyof typeof standaloneKinds]
  | "sqlite_read"
  | "sqlite_writer"
  | "extension";

const kinds = new Map<string, WorkerRequestKind>([
  ...Object.entries(runtimeProcessEntrypoints).map(
    ([kind, entry]): [string, keyof typeof runtimeProcessEntrypoints] => [
      basename(entry.distWorkerPath),
      // SAFETY: Object.entries enumerates this closed, locally defined entrypoint manifest.
      kind as keyof typeof runtimeProcessEntrypoints,
    ],
  ),
  ...Object.entries(standaloneKinds),
]);

/** SDK callers may supply their own workers; never publish arbitrary paths as labels. */
export function workerRequestKind(url: URL): WorkerRequestKind {
  return kinds.get(basename(url.pathname).replace(/\.(?:ts|mjs)$/, ".js")) ?? "extension";
}
