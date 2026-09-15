import fs from "node:fs";
import type { FSWatcher } from "chokidar";

type FileStabilitySnapshot = {
  size: number;
  mtimeMs: number;
};

const RAW_SKILL_FILE_POLL_INTERVAL_MS = 100;

function readFileStabilitySnapshot(filePath: string): FileStabilitySnapshot | undefined {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

async function waitForStableSkillFile(
  filePath: string,
  stabilityMs: number,
  watcher: FSWatcher,
  readRevision: () => number,
): Promise<void> {
  if (watcher.closed || stabilityMs <= 0) {
    return;
  }
  let previousRevision = readRevision();
  let previous = readFileStabilitySnapshot(filePath);
  if (!previous) {
    return;
  }
  let stableForMs = 0;
  while (stableForMs < stabilityMs) {
    const delayMs = Math.min(RAW_SKILL_FILE_POLL_INTERVAL_MS, stabilityMs - stableForMs);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
    // Closing a watcher retires raw polling, even while the file keeps changing.
    if (watcher.closed) {
      return;
    }
    const nextRevision = readRevision();
    const next = readFileStabilitySnapshot(filePath);
    if (!next) {
      return;
    }
    if (
      nextRevision === previousRevision &&
      next.size === previous.size &&
      next.mtimeMs === previous.mtimeMs
    ) {
      stableForMs += delayMs;
      continue;
    }
    previous = next;
    previousRevision = nextRevision;
    stableForMs = 0;
  }
}

export function createRawSkillFileScheduler({
  watcher,
  stabilityMs,
  schedule,
  onError,
}: {
  watcher: FSWatcher;
  stabilityMs: number;
  schedule: (filePath: string) => void;
  onError: (filePath: string, error: unknown) => void;
}) {
  const pendingRawFiles = new Map<string, { revision: number }>();
  return (changedPath: string) => {
    if (watcher.closed) {
      return;
    }
    const pending = pendingRawFiles.get(changedPath);
    if (pending) {
      pending.revision += 1;
      return;
    }
    const current = { revision: 0 };
    pendingRawFiles.set(changedPath, current);
    void (async () => {
      try {
        while (!watcher.closed) {
          let sampledRevision = current.revision;
          await waitForStableSkillFile(changedPath, stabilityMs, watcher, () => {
            sampledRevision = current.revision;
            return sampledRevision;
          }).catch((err: unknown) => onError(changedPath, err));
          // A raw event can arrive after the final sample but before this continuation.
          if (current.revision !== sampledRevision) {
            continue;
          }
          schedule(changedPath);
          return;
        }
      } finally {
        pendingRawFiles.delete(changedPath);
      }
    })();
  };
}
