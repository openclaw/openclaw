export type SyncProgressState = {
  completed: number;
  total: number;
  label?: string;
  report: (update: { completed: number; total: number; label?: string }) => void;
};

export function bumpSyncProgressTotal(
  progress: SyncProgressState | undefined,
  delta: number,
  label?: string,
) {
  if (!progress) {
    return;
  }
  progress.total += delta;
  progress.report({
    completed: progress.completed,
    total: progress.total,
    label,
  });
}

export function bumpSyncProgressCompleted(
  progress: SyncProgressState | undefined,
  delta = 1,
  label?: string,
) {
  if (!progress) {
    return;
  }
  progress.completed += delta;
  progress.report({
    completed: progress.completed,
    total: progress.total,
    label,
  });
}
