export type BackupProgressStage =
  | "plan"
  | "sqlite-source-acquisition"
  | "sqlite-source-integrity"
  | "sqlite-online-copy"
  | "sqlite-vacuum"
  | "sqlite-hash"
  | "sqlite-published-integrity"
  | "archive-write"
  | "verify-archive-read"
  | "verify-spool"
  | "verify-sqlite-integrity";

export type BackupProgressEvent = {
  stage: BackupProgressStage;
  phase: "start" | "progress" | "done";
  /** Bytes observed at this stage, never a path or database identity. */
  bytes?: number;
  /** Size of the source file, not bytes completed or physical I/O. */
  sourceBytes?: number;
  totalBytes?: number;
  outputBytes?: number;
  pages?: number;
  totalPages?: number;
};

export type ReportBackupProgress = (event: BackupProgressEvent) => void;

type StageTotals = {
  startedAt?: number;
  elapsedMs: number;
  runs: number;
  bytes: number;
  outputBytes: number;
  currentBytes: number;
  currentOutputBytes: number;
};

const MIN_PROGRESS_INTERVAL_MS = 15_000;
const MAX_PROGRESS_LINES = 80;
const MAX_LARGE_START_LINES = 20;
const LARGE_DATABASE_BYTES = 1024 ** 3;

/** Bound live output while retaining a terminal summary for every reached stage. */
export function createBackupProgressLogger(log: (message: string) => void) {
  const stages = new Map<BackupProgressStage, StageTotals>();
  let lastLoggedAt = Number.NEGATIVE_INFINITY;
  let lines = 0;
  let largeStartLines = 0;
  let finished = false;
  const write = (message: string) => {
    try {
      log(message);
    } catch {
      // Progress is advisory; a logging sink must not invalidate a verified backup.
    }
  };
  const report = (event: BackupProgressEvent) => {
    if (finished) {
      return;
    }
    const now = Date.now();
    const firstStart = event.phase === "start" && !stages.has(event.stage);
    const totals = stages.get(event.stage) ?? {
      elapsedMs: 0,
      runs: 0,
      bytes: 0,
      outputBytes: 0,
      currentBytes: 0,
      currentOutputBytes: 0,
    };
    stages.set(event.stage, totals);
    if (event.phase === "start") {
      totals.startedAt = now;
      totals.currentBytes = 0;
      totals.currentOutputBytes = 0;
    }
    if (event.bytes !== undefined && event.phase !== "start") {
      totals.currentBytes = event.bytes;
    }
    if (event.outputBytes !== undefined) {
      totals.currentOutputBytes = event.outputBytes;
    }
    if (event.phase === "done") {
      totals.runs += 1;
      totals.bytes += totals.currentBytes;
      totals.outputBytes += totals.currentOutputBytes;
      totals.elapsedMs += Math.max(0, now - (totals.startedAt ?? now));
      totals.startedAt = undefined;
    }
    const largeStart =
      event.phase === "start" &&
      (event.sourceBytes ?? 0) >= LARGE_DATABASE_BYTES &&
      largeStartLines < MAX_LARGE_START_LINES;
    if (
      !firstStart &&
      !largeStart &&
      (lines >= MAX_PROGRESS_LINES || now - lastLoggedAt < MIN_PROGRESS_INTERVAL_MS)
    ) {
      return;
    }
    const bytes = event.bytes === undefined ? "" : ` bytes=${Math.max(0, event.bytes)}`;
    const source =
      event.sourceBytes === undefined ? "" : ` sourceBytes=${Math.max(0, event.sourceBytes)}`;
    const total =
      event.totalBytes === undefined ? "" : ` totalBytes=${Math.max(0, event.totalBytes)}`;
    const output =
      event.outputBytes === undefined ? "" : ` outputBytes=${Math.max(0, event.outputBytes)}`;
    const pages = event.pages === undefined ? "" : ` pages=${Math.max(0, event.pages)}`;
    const totalPages =
      event.totalPages === undefined ? "" : ` totalPages=${Math.max(0, event.totalPages)}`;
    write(
      `Backup progress: stage=${event.stage} phase=${event.phase}${bytes}${source}${total}${output}${pages}${totalPages}`,
    );
    if (largeStart) {
      largeStartLines += 1;
    } else {
      lines += 1;
    }
    lastLoggedAt = now;
  };
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    const now = Date.now();
    for (const [stage, totals] of stages) {
      const active = totals.startedAt !== undefined;
      const activeMs = active ? Math.max(0, now - totals.startedAt!) : 0;
      write(
        `Backup progress: stage=${stage} phase=summary runs=${totals.runs} bytes=${totals.bytes + (active ? totals.currentBytes : 0)} outputBytes=${totals.outputBytes + (active ? totals.currentOutputBytes : 0)} elapsedMs=${totals.elapsedMs + activeMs} complete=${!active}`,
      );
    }
  };
  return Object.assign(report, { finish });
}
