import fs from "node:fs/promises";
import { writeHeapSnapshot } from "node:v8";
import { observeRuntimeProfileCapability } from "../infra/runtime-capabilities.js";
import { reserveDiagnosticProfileFile } from "./diagnostic-profile-file.js";
import {
  captureDiagnosticProfile,
  createInspectorProfileCapture,
  ProfileFailure,
} from "./diagnostic-profile.js";
import { createSubsystemLogger } from "./subsystem.js";

const MAX_HEAP_BYTES = 6 * 1024 ** 3;
const COOLDOWN_MS = 60_000;
const log = createSubsystemLogger("gateway").child("diagnostics/heap-snapshot");
let nextCaptureAt = 0;

/** Owns opt-in main-isolate snapshots; native capture cannot be interrupted. */
export async function captureDiagnosticHeapSnapshot(options: {
  reason?: string;
  signal: AbortSignal;
  hasAuthority: () => boolean;
}) {
  let ownedPath: string | undefined;
  let elapsedMs = 0;
  let heapUsedAfter = 0;
  const outcome = await observeRuntimeProfileCapability(
    "heapSnapshot",
    captureDiagnosticProfile({
      ...options,
      durationMs: 0,
      create: (inspector) => {
        const capture = {
          setup: async () => {
            if (performance.now() < nextCaptureAt) {
              throw new ProfileFailure("cooldown");
            }
            if (process.memoryUsage().heapUsed > MAX_HEAP_BYTES) {
              throw new ProfileFailure("heap-too-large");
            }
            const file = await reserveDiagnosticProfileFile("heap", () => {
              if (options.signal.aborted || !options.hasAuthority()) {
                throw new ProfileFailure("cancelled");
              }
            });
            ownedPath = file.path;
            await file.handle.close();
          },
          start: async () => {
            const heapUsedBefore = process.memoryUsage().heapUsed;
            if (heapUsedBefore > MAX_HEAP_BYTES) {
              throw new ProfileFailure("heap-too-large");
            }
            log.warn("Writing heap snapshot: the main thread will block until capture finishes", {
              heapUsedBefore,
              reason: options.reason,
            });
            const startedAt = performance.now();
            try {
              writeHeapSnapshot(ownedPath!);
            } finally {
              // Starts after native work, so requests queued during a long stall cannot recapture.
              nextCaptureAt = performance.now() + COOLDOWN_MS;
            }
            elapsedMs = performance.now() - startedAt;
            // Metadata I/O can yield to fresh allocations; preserve the post-GC reading now.
            heapUsedAfter = process.memoryUsage().heapUsed;
          },
          stop: async () => ({
            profile: { path: ownedPath!, sizeBytes: (await fs.stat(ownedPath!)).size },
          }),
        };
        // V8 retains object IDs after native snapshots until its heap domain is disabled.
        return process.versions.bun
          ? { ...capture, close: () => {} }
          : createInspectorProfileCapture(inspector, {
              ...capture,
              disable: (session) => session.post("HeapProfiler.disable"),
            });
      },
      sanitize: (profile, _packageRoot, measurement) => ({
        ...profile,
        heapUsedBefore: measurement.before.heapUsed,
        heapUsedAfter,
        elapsedMs,
      }),
    }),
  );
  if (outcome.status === "unavailable" && ownedPath) {
    const removalFailed = await fs.unlink(ownedPath).then(
      () => false,
      () => true,
    );
    outcome.cleanupFailed ||= removalFailed;
  }
  return outcome;
}
