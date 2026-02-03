
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildFileEntry, listMemoryFiles, type MemoryFileEntry } from "./internal.js";
import type { MemoryStore } from "./storage/types.js";

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
  store: MemoryStore;
  needsFullReindex: boolean;
  progress?: ProgressState;
  batchEnabled: boolean;
  concurrency: number;
  runWithConcurrency: <T>(tasks: Array<() => Promise<T>>, concurrency: number) => Promise<T[]>;
  indexFile: (entry: MemoryFileEntry) => Promise<void>;
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
    const hash = await params.store.getFileHash(entry.path, "memory");
    if (!params.needsFullReindex && hash === entry.hash) {
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
      return;
    }
    await params.indexFile(entry);
    if (params.progress) {
      params.progress.completed += 1;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
      });
    }
  });

  await params.runWithConcurrency(tasks, params.concurrency);

  const stalePaths = await params.store.listFilePaths("memory");
  for (const path of stalePaths) {
    if (activePaths.has(path)) {
      continue;
    }
    await params.store.removeFile(path, "memory");
  }
}
