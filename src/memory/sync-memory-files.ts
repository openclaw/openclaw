import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildFileEntry, listMemoryFiles, type MemoryFileEntry } from "./internal.js";
import { indexFileEntryIfChanged } from "./sync-index.js";
import { deleteStaleIndexedPaths } from "./sync-stale.js";

const log = createSubsystemLogger("memory");

type ProgressState = {
  completed: number;
  total: number;
  label?: string;
  report: (update: { completed: number; total: number; label?: string }) => void;
};

export async function syncMemoryFiles(params: {
  workspaceDir: string;
  extraPaths?: string[];
  db: DatabaseSync;
  needsFullReindex: boolean;
  progress?: ProgressState;
  batchEnabled: boolean;
  concurrency: number;
  runWithConcurrency: <T>(tasks: Array<() => Promise<T>>, concurrency: number) => Promise<T[]>;
  indexFile: (entry: MemoryFileEntry) => Promise<void>;
  vectorTable: string;
  ftsTable: string;
  ftsEnabled: boolean;
  ftsAvailable: boolean;
  model: string;
}) {
  const files = await listMemoryFiles(params.workspaceDir, params.extraPaths);
  const fileEntries = await Promise.all(
    files.map(async (file) => buildFileEntry(file, params.workspaceDir)),
  );

  log.debug("memory sync: indexing memory files", {
    files: fileEntries.length,
    needsFullReindex: params.needsFullReindex,
    batch: params.batchEnabled,
    concurrency: params.concurrency,
  });

  const activePaths = new Set(fileEntries.map((entry) => entry.path));
  if (params.progress) {
    params.progress.total += fileEntries.length;
    params.progress.report({
      completed: params.progress.completed,
      total: params.progress.total,
      label: params.batchEnabled ? "Indexing memory files (batch)..." : "Indexing memory files…",
    });
  }

  const tasks = fileEntries.map((entry) => async () => {
    await indexFileEntryIfChanged({
      db: params.db,
      source: "memory",
      needsFullReindex: params.needsFullReindex,
      entry,
      indexFile: params.indexFile,
      progress: params.progress,
    });
  });

  await params.runWithConcurrency(tasks, params.concurrency);
  deleteStaleIndexedPaths({
    db: params.db,
    source: "memory",
    activePaths,
    vectorTable: params.vectorTable,
    ftsTable: params.ftsTable,
    ftsEnabled: params.ftsEnabled,
    ftsAvailable: params.ftsAvailable,
    model: params.model,
  });
}
