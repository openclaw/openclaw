import fs from "node:fs/promises";
import path from "node:path";
import { writeHeapSnapshot } from "node:v8";
import { resolveStateDir } from "../config/state-dir.js";
import type { DiagnosticProfileOutcome } from "./diagnostic-profile.js";
import { createSubsystemLogger } from "./subsystem.js";

const MAX_HEAP_BYTES = 6 * 1024 ** 3;
const COOLDOWN_MS = 60_000;
const log = createSubsystemLogger("gateway").child("diagnostics/heap-snapshot");
let capturing = false;
let nextCaptureAt = 0;

type HeapSnapshotResult = {
  path: string;
  sizeBytes: number;
  heapUsedBefore: number;
  heapUsedAfter: number;
  elapsedMs: number;
};

/** Owns opt-in main-isolate snapshots; native capture cannot be interrupted. */
export async function captureDiagnosticHeapSnapshot(options: {
  reason?: string;
  signal: AbortSignal;
  hasAuthority: () => boolean;
}): Promise<DiagnosticProfileOutcome<HeapSnapshotResult>> {
  const unavailable = (
    reason: "busy" | "cooldown" | "heap-too-large" | "cancelled" | "unsupported",
  ) => ({ status: "unavailable", reason, cleanupFailed: false }) as const;
  const active = () => !options.signal.aborted && options.hasAuthority();
  if (!active()) {
    return unavailable("cancelled");
  }
  if (process.versions.bun) {
    return unavailable("unsupported");
  }
  if (capturing) {
    return unavailable("busy");
  }
  if (performance.now() < nextCaptureAt) {
    return unavailable("cooldown");
  }
  if (process.memoryUsage().heapUsed > MAX_HEAP_BYTES) {
    return unavailable("heap-too-large");
  }
  capturing = true;
  let ownedPath: string | undefined;
  try {
    const directory = path.join(resolveStateDir(), "diagnostics");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!active()) {
      return unavailable("cancelled");
    }
    const filename = path.join(
      directory,
      `heap-${new Date().toISOString().replaceAll(":", "-")}.heapsnapshot`,
    );
    // Reserve privately before V8 opens the file, including with a permissive umask.
    const file = await fs.open(filename, "wx", 0o600);
    ownedPath = filename;
    await file.close();
    const heapUsedBefore = process.memoryUsage().heapUsed;
    if (!active() || heapUsedBefore > MAX_HEAP_BYTES) {
      await fs.unlink(filename);
      ownedPath = undefined;
      return unavailable(active() ? "heap-too-large" : "cancelled");
    }
    log.warn("Writing heap snapshot: the main thread will block until V8 finishes", {
      heapUsedBefore,
      reason: options.reason,
    });
    const startedAt = performance.now();
    try {
      writeHeapSnapshot(filename);
    } finally {
      // Starts after native work, so requests queued during a long stall cannot recapture.
      nextCaptureAt = performance.now() + COOLDOWN_MS;
    }
    const elapsedMs = performance.now() - startedAt;
    const heapUsedAfter = process.memoryUsage().heapUsed;
    const { size: sizeBytes } = await fs.stat(filename);
    return {
      status: "complete",
      result: { path: filename, sizeBytes, heapUsedBefore, heapUsedAfter, elapsedMs },
    };
  } catch {
    const cleanupFailed = ownedPath
      ? await fs.unlink(ownedPath).then(
          () => false,
          () => true,
        )
      : false;
    return { status: "unavailable", reason: "capture-failed", cleanupFailed };
  } finally {
    capturing = false;
  }
}
