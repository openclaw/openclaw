import type { DatabaseSync } from "node:sqlite";

type SyncProgress = {
  completed: number;
  total: number;
  report: (update: { completed: number; total: number; label?: string }) => void;
};

function tickProgress(progress: SyncProgress | undefined): void {
  if (!progress) {
    return;
  }
  progress.completed += 1;
  progress.report({
    completed: progress.completed,
    total: progress.total,
  });
}

export async function indexFileEntryIfChanged<
  TEntry extends { path: string; hash: string },
>(params: {
  db: DatabaseSync;
  source: string;
  needsFullReindex: boolean;
  entry: TEntry;
  indexFile: (entry: TEntry) => Promise<void>;
  progress?: SyncProgress;
}): Promise<void> {
  const record = params.db
    .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
    .get(params.entry.path, params.source) as { hash: string } | undefined;
  if (!params.needsFullReindex && record?.hash === params.entry.hash) {
    tickProgress(params.progress);
    return;
  }
  await params.indexFile(params.entry);
  tickProgress(params.progress);
}
