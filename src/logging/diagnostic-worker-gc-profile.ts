import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";
import { resolveStateDir } from "../config/state-dir.js";
import type { WorkerGcProfiles, WorkerGcStorm } from "../infra/diagnostic-process-types.js";
import { sanitizeDiagnosticCpuProfile } from "./diagnostic-cpu-profile.js";
import { sanitizeDiagnosticHeapProfile, type SamplingProfile } from "./diagnostic-heap-profile.js";
import { captureDiagnosticProfile, createInspectorProfileCapture } from "./diagnostic-profile.js";
import { createSubsystemLogger } from "./subsystem.js";

const DURATION_MS = 5_000;
const SAMPLING_INTERVAL_BYTES = 262_144;
const MAX_FILES = 20;
const FILE_PATTERN = /^code-mode-gc-\d+-[a-f0-9-]+\.(?:heapprofile|cpuprofile)\.json$/;
let writes: Promise<unknown> = Promise.resolve();

/** The Gateway reports storms lazily; its registry retains the final capture admission. */
export async function reportWorkerGcStorm(
  event: WorkerGcStorm,
  workerThreadId: number,
  workerSlot?: number,
): Promise<Omit<WorkerGcStorm, "profiles"> | undefined> {
  const { profiles, ...storm } = event;
  const metadata = { ...storm, workerThreadId, workerSlot };
  const log = createSubsystemLogger("agents/code-mode");
  if (profiles) {
    try {
      const profileFiles = await writeWorkerGcProfiles(profiles);
      log.warn("Code Mode worker GC storm", { ...metadata, profileFiles });
    } catch {
      log.warn("Code Mode worker GC storm", {
        ...metadata,
        captureStatus: "unavailable",
        captureReason: "profile-write-failed",
      });
    }
  } else {
    log.warn("Code Mode worker GC storm", metadata);
  }
  if (storm.captureStatus === "requested") {
    // Workers cannot query process-wide tracing. Admit here before enabling their profiler.
    const { getEnabledCategories } = await import("node:trace_events");
    if (getEnabledCategories()) {
      log.warn("Code Mode worker GC storm", {
        ...metadata,
        captureStatus: "unavailable",
        captureReason: "tracing-active",
      });
    } else {
      return storm;
    }
  }
  return undefined;
}

/** Runs only in the storming isolate; no inspector listener or guest values are captured. */
export function captureWorkerGcProfiles() {
  return captureDiagnosticProfile({
    hasAuthority: () => true,
    durationMs: DURATION_MS,
    workerTracingInactive: true,
    create: (inspector) =>
      createInspectorProfileCapture(inspector, {
        setup: async (session) => {
          await session.post("HeapProfiler.enable");
          await session.post("Profiler.enable");
          await session.post("Profiler.setSamplingInterval", { interval: 10_000 });
        },
        start: async (session) => {
          await session.post("HeapProfiler.startSampling", {
            samplingInterval: SAMPLING_INTERVAL_BYTES,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
          await session.post("Profiler.start");
        },
        stop: async (session) => {
          const [heap, cpu] = await Promise.all([
            session.post("HeapProfiler.stopSampling"),
            session.post("Profiler.stop"),
          ]);
          return { profile: { heap: heap.profile, cpu: cpu.profile } };
        },
        disable: (session) =>
          Promise.all([session.post("HeapProfiler.disable"), session.post("Profiler.disable")]),
      }),
    sanitize: async ({ heap, cpu }, packageRoot, measurement): Promise<WorkerGcProfiles> => ({
      heap: JSON.stringify(
        // SAFETY: V8 supplies IDs and samples omitted by Node's inspector declarations.
        await sanitizeDiagnosticHeapProfile(heap as SamplingProfile, packageRoot, {
          durationMs: measurement.durationMs,
          requestedDurationMs: DURATION_MS,
          effectiveDurationMs: DURATION_MS,
          actualDurationMs: measurement.durationMs,
          durationLimitReason: null,
          samplingIntervalBytes: SAMPLING_INTERVAL_BYTES,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
          heapUsedBefore: measurement.before.heapUsed,
          heapUsedAfter: measurement.after.heapUsed,
          heapSpacesBefore: measurement.before.heapSpaces,
          heapSpacesAfter: measurement.after.heapSpaces,
          rssBefore: measurement.before.rss,
          rssAfter: measurement.after.rss,
        }),
      ),
      cpu: JSON.stringify(sanitizeDiagnosticCpuProfile(cpu, packageRoot, measurement)),
    }),
  });
}

/** The Gateway serializes all worker writes so the global file cap survives concurrent storms. */
export function writeWorkerGcProfiles(profiles: WorkerGcProfiles): Promise<string[]> {
  const write = writes.then(async () => {
    const directory = path.join(resolveStateDir(), "diagnostics");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const files = (await fs.readdir(directory))
      .filter((file) => FILE_PATTERN.test(file))
      .toSorted();
    // Make room before writing; a crash can leave one file, but never grows the cap.
    for (const file of files.slice(0, Math.max(0, files.length - MAX_FILES + 2))) {
      await fs.unlink(path.join(directory, file));
    }
    const prefix = `code-mode-gc-${Date.now()}-${randomUUID()}`;
    const filenames = [];
    for (const [kind, content] of [
      ["heap", profiles.heap],
      ["cpu", profiles.cpu],
    ] as const) {
      const filename = `${prefix}.${kind}profile.json`;
      await replaceFileAtomic({
        filePath: path.join(directory, filename),
        content,
        mode: 0o600,
        dirMode: 0o700,
      });
      filenames.push(filename);
    }
    return filenames;
  });
  writes = write.catch(() => {});
  return write;
}
