import fs from "node:fs";
import path from "node:path";
import { appendRegularFileSync } from "@openclaw/fs-safe/advanced";
import { resolveStateDir } from "../config/state-dir.js";
import { registerProcessExitCleanup } from "../infra/process-exit-cleanup.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { formatConsoleDiagnosticLine } from "./json-console-line.js";
import {
  prepareFileLogTarget,
  resolveDefaultFileLogTarget,
  rotateLogFile,
  type DefaultFileLogRoot,
  type FileLogIORequest,
  type FileLogIOResults,
} from "./logger-file-io.js";
import { redactSensitiveText } from "./redact.js";
import { formatTimestamp } from "./timestamps.js";

async function runFileLogIO<Request extends FileLogIORequest>(
  request: Request,
): Promise<FileLogIOResults[Request["type"]]> {
  const { runFileLogIOInWorker } = await import("./logger-file-worker.js");
  return runFileLogIOInWorker(request);
}

type DefaultFileLogRootPreparation = {
  options: DefaultFileLogRoot;
  directory?: string;
  resolution?: Promise<string>;
};

type FileLogTargetPreparation = {
  ready?: Promise<void>;
  prepared: boolean;
  file: string;
  rolling: boolean;
  defaultRoot?: DefaultFileLogRootPreparation;
};

function resolveTarget(target: FileLogTargetPreparation, synchronous: true): string;
function resolveTarget(target: FileLogTargetPreparation, synchronous?: false): Promise<string>;
function resolveTarget(
  target: FileLogTargetPreparation,
  synchronous = false,
): string | Promise<string> {
  const root = target.defaultRoot;
  if (!root) {
    return synchronous ? target.file : Promise.resolve(target.file);
  }
  if (root.directory !== undefined) {
    const file = path.join(root.directory, target.file);
    return synchronous ? file : Promise.resolve(file);
  }
  if (synchronous) {
    const file = resolveDefaultFileLogTarget(target.file, root.options);
    root.directory = path.dirname(file);
    return file;
  }
  return (root.resolution ??= runFileLogIO({
    type: "resolveDefault",
    file: target.file,
    root: root.options,
  })
    .then((file) => (root.directory = path.dirname(file)))
    .catch((error: unknown) => {
      root.resolution = undefined;
      throw error;
    })).then((directory) => path.join(directory, target.file));
}

function prepareTarget(target: FileLogTargetPreparation, synchronous: true): void;
function prepareTarget(target: FileLogTargetPreparation, synchronous: false): Promise<void>;
function prepareTarget(
  target: FileLogTargetPreparation,
  synchronous: boolean,
): void | Promise<void> {
  if (target.prepared) {
    return synchronous ? undefined : Promise.resolve();
  }
  if (synchronous) {
    try {
      prepareFileLogTarget(resolveTarget(target, true), target.rolling);
      target.prepared = true;
    } catch {}
    return;
  }
  return (target.ready ??= resolveTarget(target)
    .then((file) =>
      runFileLogIO({
        type: "prepare",
        file,
        rolling: target.rolling,
      }),
    )
    .then(() => {
      target.prepared = true;
    })
    .catch(() => undefined));
}

// Keep burst memory bounded while one equally bounded batch is in flight.
const DEFAULT_MAX_QUEUED_RECORDS = 4_096;
const MAX_APPEND_BATCH_BYTES = 64 * 1024;
// A failing path stays armed until recovery; cap retained paths so target churn cannot leak memory.
const MAX_TRACKED_APPEND_FAILURE_FILES = 64;

type FileLogQueueEntry = {
  file: string;
  hostname: string;
  maxFileBytes: number;
  payload: string;
  targetPreparation?: FileLogTargetPreparation;
};

type FileCursor = {
  bytes: number;
};

let queue: FileLogQueueEntry[] = [];
let queueStart = 0;
let activeBatch: FileLogQueueEntry[] | null = null;
let activeIndex = 0;
let droppedCount = 0;
let droppedTarget: FileLogQueueEntry | null = null;
let scheduledFlush: NodeJS.Immediate | null = null;
let flushPromise: Promise<void> | null = null;
let processExiting = false;
let processHooksInstalled = false;
const warnedRotationFiles = new Map<string, number>();
const warnedAppendFiles = new Set<string>();
let appendFailureTrackingSaturated = false;

function getCurrentLogFileBytesSync(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function buildDroppedMarker(target: FileLogQueueEntry, count: number): FileLogQueueEntry {
  const date = new Date();
  const message = `[openclaw] file log queue overflow; dropped ${count} oldest record${count === 1 ? "" : "s"}`;
  const record = {
    0: message,
    _meta: {
      date,
      hostname: target.hostname,
      logLevelName: "WARN",
      name: "openclaw",
    },
    time: formatTimestamp(date, { style: "long" }),
    hostname: target.hostname,
    message,
    dropped: count,
  };
  return {
    ...target,
    payload: `${JSON.stringify(record)}\n`,
  };
}

function writeFileTransportWarning(message: string, synchronous: boolean): boolean {
  try {
    const redactedMessage = redactSensitiveText(message);
    const line = `${formatConsoleDiagnosticLine({ level: "warn", message: redactedMessage })}\n`;
    if (synchronous) {
      fs.writeSync(process.stderr.fd, line);
    } else {
      process.stderr.write(line);
    }
    return true;
  } catch {
    // Logging diagnostics must not stop the file queue.
    return false;
  }
}

function warnAboutRotationFailure(entry: FileLogQueueEntry, synchronous: boolean): void {
  if (warnedRotationFiles.get(entry.file) === entry.maxFileBytes) {
    return;
  }
  warnedRotationFiles.set(entry.file, entry.maxFileBytes);
  const message = `[openclaw] log file rotation failed; continuing writes file=${entry.file} maxFileBytes=${entry.maxFileBytes}`;
  writeFileTransportWarning(message, synchronous);
}

function warnAboutAppendFailure(entry: FileLogQueueEntry, synchronous: boolean): void {
  if (warnedAppendFiles.has(entry.file)) {
    return;
  }
  const saturated = warnedAppendFiles.size >= MAX_TRACKED_APPEND_FAILURE_FILES;
  if (saturated && appendFailureTrackingSaturated) {
    return;
  }
  const message = saturated
    ? "[openclaw] log file append failure diagnostics saturated; suppressing new file targets"
    : `[openclaw] log file append failed; records dropped; check that the path is a writable regular file; file=${entry.file}`;
  if (!writeFileTransportWarning(message, synchronous)) {
    return;
  }
  if (saturated) {
    appendFailureTrackingSaturated = true;
  } else {
    warnedAppendFiles.add(entry.file);
  }
}

function clearAppendFailure(entry: FileLogQueueEntry): void {
  if (warnedAppendFiles.delete(entry.file)) {
    appendFailureTrackingSaturated = false;
  }
}

function claimQueuedEntries(): FileLogQueueEntry[] {
  const entries =
    queueStart === 0 ? queue : [...queue.slice(queueStart), ...queue.slice(0, queueStart)];
  queue = [];
  queueStart = 0;
  if (droppedCount > 0 && droppedTarget) {
    entries.unshift(buildDroppedMarker(droppedTarget, droppedCount));
  }
  droppedCount = 0;
  droppedTarget = null;
  return entries;
}

function prepareWrite(
  entry: FileLogQueueEntry,
  currentBytes: number,
  synchronous: boolean,
  entries: FileLogQueueEntry[],
  index: number,
): { payload: string; payloadBytes: number; nextIndex: number } {
  let payloadBytes = Buffer.byteLength(entry.payload, "utf8");
  let nextIndex = index + 1;
  // fs-safe's synchronous helper can short-write, so keep exit rescue per record.
  if (synchronous) {
    return { payload: entry.payload, payloadBytes, nextIndex };
  }
  const payloads = [entry.payload];
  // Rotate only between appends, preserving record boundaries and target changes.
  // An oversized record remains one append; ordinary bursts share bounded secured I/O.
  for (; nextIndex < entries.length; nextIndex += 1) {
    const next = entries[nextIndex];
    if (
      !next ||
      next.file !== entry.file ||
      next.maxFileBytes !== entry.maxFileBytes ||
      next.targetPreparation !== entry.targetPreparation
    ) {
      break;
    }
    const nextBytes = Buffer.byteLength(next.payload, "utf8");
    if (
      payloadBytes + nextBytes > MAX_APPEND_BATCH_BYTES ||
      currentBytes + payloadBytes + nextBytes > entry.maxFileBytes
    ) {
      break;
    }
    payloads.push(next.payload);
    payloadBytes += nextBytes;
  }
  return { payload: payloads.join(""), payloadBytes, nextIndex };
}

async function writeEntries(entries: FileLogQueueEntry[]): Promise<void> {
  const cursors = new Map<string, FileCursor>();
  for (let index = 0; index < entries.length;) {
    if (processExiting) {
      return;
    }
    const entry = entries[index];
    if (!entry) {
      return;
    }
    let file: string;
    try {
      file = entry.targetPreparation ? await resolveTarget(entry.targetPreparation) : entry.file;
    } catch {
      warnAboutAppendFailure(entry, false);
      entry.payload = "";
      activeIndex = ++index;
      continue;
    }
    if (entry.targetPreparation) {
      await prepareTarget(entry.targetPreparation, false);
    }
    let cursor = cursors.get(file);
    if (!cursor) {
      cursor = { bytes: await runFileLogIO({ type: "size", file }).catch(() => 0) };
      if (processExiting) {
        return;
      }
      cursors.set(file, cursor);
    }
    const rotate =
      cursor.bytes > 0 && cursor.bytes + Buffer.byteLength(entry.payload) > entry.maxFileBytes;
    const batch = prepareWrite(entry, rotate ? 0 : cursor.bytes, false, entries, index);
    // Forced drains must skip the whole issued append, which cannot be safely replayed.
    activeIndex = batch.nextIndex;
    try {
      const result = await runFileLogIO({
        type: "append",
        file,
        payload: batch.payload,
        rotate,
      });
      if (result.rotation === "rotated") {
        cursor.bytes = 0;
        warnedRotationFiles.delete(entry.file);
      } else if (result.rotation === "failed") {
        warnAboutRotationFailure(entry, false);
      }
      if (result.appended) {
        cursor.bytes += batch.payloadBytes;
        clearAppendFailure(entry);
      } else {
        warnAboutAppendFailure(entry, false);
      }
    } catch {
      // A lost worker result leaves the file size unknown; the next batch observes it once.
      cursors.delete(file);
      warnAboutAppendFailure(entry, false);
    } finally {
      // Drains share entries; release settled text even while a later append is still pending.
      for (const written of entries.slice(index, batch.nextIndex)) {
        written.payload = "";
      }
      index = batch.nextIndex;
    }
  }
}

function writeEntriesSync(entries: FileLogQueueEntry[]): void {
  const cursors = new Map<string, FileCursor>();
  for (let index = 0; index < entries.length;) {
    const entry = entries[index];
    if (!entry) {
      return;
    }
    let file: string;
    try {
      file = entry.targetPreparation ? resolveTarget(entry.targetPreparation, true) : entry.file;
    } catch {
      warnAboutAppendFailure(entry, true);
      entry.payload = "";
      index++;
      continue;
    }
    let cursor = cursors.get(file);
    if (!cursor) {
      cursor = { bytes: getCurrentLogFileBytesSync(file) };
      cursors.set(file, cursor);
    }
    if (entry.targetPreparation) {
      prepareTarget(entry.targetPreparation, true);
    }
    if (cursor.bytes > 0 && cursor.bytes + Buffer.byteLength(entry.payload) > entry.maxFileBytes) {
      if (rotateLogFile(file)) {
        cursor.bytes = 0;
        warnedRotationFiles.delete(entry.file);
      } else {
        warnAboutRotationFailure(entry, true);
      }
    }
    const batch = prepareWrite(entry, cursor.bytes, true, entries, index);
    try {
      appendRegularFileSync({ filePath: file, content: batch.payload });
      cursor.bytes += batch.payloadBytes;
      clearAppendFailure(entry);
    } catch {
      // Match the old best-effort transport: a failed append must not stop later records.
      warnAboutAppendFailure(entry, true);
    }
    entry.payload = "";
    index = batch.nextIndex;
  }
}

async function runFlushLoop(): Promise<void> {
  for (;;) {
    if (processExiting) {
      return;
    }
    const entries = claimQueuedEntries();
    if (entries.length === 0) {
      return;
    }
    activeBatch = entries;
    activeIndex = 0;
    await writeEntries(entries);
    activeBatch = null;
    activeIndex = 0;
  }
}

function startFlush(): void {
  if (flushPromise || processExiting) {
    return;
  }
  const running = runFlushLoop().catch(() => undefined);
  flushPromise = running;
  void running.then(() => {
    flushPromise = null;
    if (queue.length > 0 || droppedCount > 0) {
      scheduleFlush();
    }
  });
}

function scheduleFlush(): void {
  if (scheduledFlush || flushPromise || processExiting) {
    return;
  }
  scheduledFlush = setImmediate(() => {
    scheduledFlush = null;
    startFlush();
  });
}

function handleProcessBeforeExit(): void {
  void flushFileLogQueue();
}

function handleProcessExit(): void {
  processExiting = true;
  drainFileLogQueueSync();
}

function installProcessHooks(): void {
  if (processHooksInstalled) {
    return;
  }
  processHooksInstalled = true;
  process.on("beforeExit", handleProcessBeforeExit);
  registerProcessExitCleanup(handleProcessExit);
}

/** Enqueues one serialized record without waiting for filesystem I/O. */
function enqueueFileLog(entry: FileLogQueueEntry): void {
  if (processExiting) {
    writeEntriesSync([entry]);
    return;
  }
  installProcessHooks();
  // Keep the newest diagnostics and report every eviction once in the next drain batch.
  if (queue.length >= DEFAULT_MAX_QUEUED_RECORDS) {
    const dropped = queue[queueStart];
    if (dropped) {
      // The overflow marker retains this entry's metadata, so release its discarded text now.
      dropped.payload = "";
      droppedTarget ??= dropped;
      droppedCount += 1;
    }
    queue[queueStart] = entry;
    queueStart = (queueStart + 1) % queue.length;
  } else {
    queue.push(entry);
  }
  scheduleFlush();
}

/** Waits until every record currently queued for the async transport has settled. */
async function flushFileLogQueue(): Promise<void> {
  for (;;) {
    if (scheduledFlush) {
      clearImmediate(scheduledFlush);
      scheduledFlush = null;
    }
    if (!flushPromise && (queue.length > 0 || droppedCount > 0)) {
      startFlush();
    }
    const running = flushPromise;
    if (!running) {
      return;
    }
    await running;
  }
}

/** Synchronously rescues pending records for process.exit() and crash-adjacent paths. */
function drainFileLogQueueSync(): void {
  if (scheduledFlush) {
    clearImmediate(scheduledFlush);
    scheduledFlush = null;
  }
  // An issued append cannot be cancelled or safely replayed. Graceful exits await it; forced
  // exits rescue the still-queued tail without risking duplicate or interleaved JSONL records.
  const entries = activeBatch ? activeBatch.slice(activeIndex) : [];
  activeBatch = null;
  activeIndex = 0;
  entries.push(...claimQueuedEntries());
  writeEntriesSync(entries);
}

// Source backends and compiled worker carriers must enqueue and flush through one owner.
export const fileLogTransport = resolveGlobalSingleton(
  Symbol.for("openclaw.fileLogTransport"),
  () => {
    // Production rescues logs from other exit listeners; tests install hooks when logging starts.
    if (process.env.VITEST !== "true") {
      installProcessHooks();
    }
    return {
      prepareTarget: (
        file: string,
        rolling: boolean,
        defaultRoot: boolean | DefaultFileLogRootPreparation = false,
      ): FileLogTargetPreparation => ({
        file,
        rolling,
        prepared: false,
        ...(defaultRoot
          ? {
              defaultRoot:
                typeof defaultRoot === "boolean"
                  ? { options: { stateDir: resolveStateDir() } }
                  : defaultRoot,
            }
          : {}),
      }),
      resolveTarget,
      drainSync: drainFileLogQueueSync,
      enqueue: enqueueFileLog,
      flush: flushFileLogQueue,
    };
  },
);
