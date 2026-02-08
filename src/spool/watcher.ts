/**
 * Spool file watcher - watches the events directory and dispatches events.
 *
 * Uses chokidar (like config-reload.ts) to watch for new event files.
 */

import chokidar from "chokidar";
import path from "node:path";
import type { CliDeps } from "../cli/deps.js";
import type { SpoolWatcherState, SpoolDispatchResult } from "./types.js";
import { loadConfig } from "../config/config.js";
import { dispatchSpoolEventFile } from "./dispatcher.js";
import { resolveSpoolEventsDir, resolveSpoolDeadLetterDir } from "./paths.js";
import { listSpoolEvents } from "./reader.js";
import { ensureSpoolEventsDir } from "./writer.js";

export type SpoolWatcherLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type SpoolWatcherParams = {
  deps: CliDeps;
  log: SpoolWatcherLogger;
  onEvent?: (result: SpoolDispatchResult) => void;
};

export type SpoolWatcher = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getState: () => SpoolWatcherState;
  processExisting: () => Promise<void>;
};

// Error codes that indicate fatal watcher failures requiring restart
const FATAL_WATCH_ERRORS = new Set(["ENOSPC", "EMFILE", "ENFILE", "EACCES"]);

/**
 * Check if an error is a fatal filesystem watcher error.
 */
function isFatalWatchError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return FATAL_WATCH_ERRORS.has(String((err as { code: unknown }).code));
  }
  return false;
}

/**
 * Create a spool watcher that processes events from the spool directory.
 */
export function createSpoolWatcher(params: SpoolWatcherParams): SpoolWatcher {
  const { deps, log, onEvent } = params;

  let watcher: ReturnType<typeof chokidar.watch> | null = null;
  let running = false;
  let processing = false;
  let pendingFiles: Set<string> = new Set();
  let processTimer: ReturnType<typeof setTimeout> | null = null;

  // Promise that resolves when the current processing cycle completes.
  // Used by stop() to wait for in-flight dispatches before returning.
  let processingDoneResolve: (() => void) | null = null;
  let processingDonePromise: Promise<void> | null = null;

  // Recovery state for fatal watcher errors
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  const RECOVERY_DELAY_MS = 5000;

  const eventsDir = resolveSpoolEventsDir();
  const deadLetterDir = resolveSpoolDeadLetterDir();

  const scheduleProcessing = (delayMs = 100) => {
    if (processTimer) {
      clearTimeout(processTimer);
    }
    // Debounce to avoid processing the same file multiple times
    processTimer = setTimeout(() => {
      processQueue().catch((err) => {
        log.error(`queue processing failed: ${String(err)}`);
        // Schedule retry after initialization failure so events aren't stranded
        if (pendingFiles.size > 0) {
          scheduleProcessing(1000); // Back off on failure
        }
      });
    }, delayMs);
  };

  const processQueue = async () => {
    if (processing || !running) {
      return;
    }
    processing = true;

    // Create a promise that stop() can await to know when processing completes
    processingDonePromise = new Promise((resolve) => {
      processingDoneResolve = resolve;
    });

    // Capture pending file paths and extract IDs (but don't remove yet - preserve on failure)
    // Also track non-event files (temp files, non-JSON) so we can clean them from the queue
    const capturedPaths = new Set<string>();
    const skippedPaths = new Set<string>();
    const pendingIds = new Set<string>();
    for (const filePath of pendingFiles) {
      const filename = path.basename(filePath);
      if (filename.endsWith(".json") && !filename.includes(".json.tmp.")) {
        capturedPaths.add(filePath);
        pendingIds.add(filename.replace(/\.json$/, ""));
      } else {
        // Non-event file (temp file, non-JSON) - mark for removal to prevent queue inflation
        skippedPaths.add(filePath);
      }
    }

    // Always remove skipped files to prevent stale pending state
    for (const filePath of skippedPaths) {
      pendingFiles.delete(filePath);
    }

    if (pendingIds.size === 0) {
      processing = false;
      processingDoneResolve?.();
      processingDoneResolve = null;
      processingDonePromise = null;
      return;
    }

    // Load config and list events - if this fails, pendingFiles is preserved
    let cfg;
    let sortedEvents;
    try {
      cfg = loadConfig();
      sortedEvents = await listSpoolEvents();
    } catch (err) {
      // Batch initialization failed - leave pendingFiles intact for retry
      processing = false;
      processingDoneResolve?.();
      processingDoneResolve = null;
      processingDonePromise = null;
      throw err;
    }

    // Initialization succeeded - remove only the captured paths, not all pending files
    // (new files may have arrived during initialization)
    for (const filePath of capturedPaths) {
      pendingFiles.delete(filePath);
    }

    try {
      // Track which IDs were successfully matched (valid events)
      const processedIds = new Set<string>();

      // Filter to only pending events and process in priority order
      for (const event of sortedEvents) {
        if (!running) {
          break;
        }

        if (!pendingIds.has(event.id)) {
          continue;
        }

        processedIds.add(event.id);
        const filePath = path.join(eventsDir, `${event.id}.json`);

        try {
          const result = await dispatchSpoolEventFile({
            cfg,
            deps,
            filePath,
            lane: "spool",
          });

          if (result.status === "ok") {
            log.info(
              `dispatched event ${result.eventId}${result.summary ? `: ${result.summary}` : ""}`,
            );
          } else if (result.status === "error") {
            log.warn(`event ${result.eventId} failed: ${result.error}`);
          } else if (result.status === "expired") {
            log.info(`event ${result.eventId} expired, moved to dead-letter`);
          }

          onEvent?.(result);
        } catch (err) {
          // Re-add file to queue so it's not orphaned after transient failures
          pendingFiles.add(filePath);
          log.error(`failed to process ${filePath}: ${String(err)}`);
        }
      }

      // Handle malformed files that weren't matched by listSpoolEvents()
      // Dispatch them directly so they get moved to dead-letter
      for (const eventId of pendingIds) {
        if (!running) {
          break;
        }

        if (processedIds.has(eventId)) {
          continue;
        }

        // This file wasn't in sortedEvents - likely malformed/invalid
        const filePath = path.join(eventsDir, `${eventId}.json`);

        try {
          const result = await dispatchSpoolEventFile({
            cfg,
            deps,
            filePath,
            lane: "spool",
          });

          // dispatchSpoolEventFile will move invalid files to dead-letter
          if (result.status === "error") {
            log.warn(`event ${result.eventId} failed: ${result.error}`);
          }

          onEvent?.(result);
        } catch (err) {
          // Re-add file to queue so it's not orphaned after transient failures
          pendingFiles.add(filePath);
          log.error(`failed to process ${filePath}: ${String(err)}`);
        }
      }
    } finally {
      processing = false;
      processingDoneResolve?.();
      processingDoneResolve = null;
      processingDonePromise = null;

      // If more files arrived while processing, schedule another round
      if (pendingFiles.size > 0 && running) {
        scheduleProcessing();
      }
    }
  };

  /**
   * Attempt to recover from a fatal watcher error by restarting.
   */
  const scheduleRecovery = () => {
    if (recoveryTimer || !running) {
      return;
    }

    log.warn(`scheduling watcher recovery in ${RECOVERY_DELAY_MS}ms`);

    recoveryTimer = setTimeout(async () => {
      recoveryTimer = null;

      if (!running) {
        return;
      }

      try {
        // Close the existing watcher if it exists
        if (watcher) {
          await watcher.close();
          watcher = null;
        }

        // Restart the watcher
        await startWatcher();
        log.info("watcher recovered successfully");

        // Re-scan for any files that may have been added during the outage
        await processExisting();
      } catch (err) {
        log.error(`watcher recovery failed: ${String(err)}`);
        // Schedule another recovery attempt
        scheduleRecovery();
      }
    }, RECOVERY_DELAY_MS);
  };

  /**
   * Internal function to start the chokidar watcher.
   * Separated from start() to allow recovery to reuse it.
   */
  const startWatcher = async () => {
    // Start watching (depth: 0 prevents recursive watching so nested files
    // don't get misresolved to top-level paths during dispatch)
    watcher = chokidar.watch(eventsDir, {
      ignoreInitial: false, // Process existing files on startup
      depth: 0, // Only watch immediate children, not subdirectories
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      usePolling: Boolean(process.env.VITEST),
    });

    watcher.on("add", (filePath) => {
      if (!running) {
        return;
      }
      pendingFiles.add(filePath);
      scheduleProcessing();
    });

    watcher.on("change", (filePath) => {
      if (!running) {
        return;
      }
      // Re-process changed files (e.g., retry count updated)
      pendingFiles.add(filePath);
      scheduleProcessing();
    });

    watcher.on("error", (err) => {
      log.error(`watcher error: ${String(err)}`);

      // On fatal errors, attempt to recover
      if (isFatalWatchError(err)) {
        log.error("fatal watcher error detected, attempting recovery");
        scheduleRecovery();
      }
    });

    log.info(`watching ${eventsDir}`);
  };

  const start = async () => {
    if (running) {
      return;
    }
    running = true;

    try {
      // Ensure directory exists
      await ensureSpoolEventsDir();

      // Check if stop() was called during the async init
      if (!running) {
        return;
      }

      await startWatcher();
    } catch (err) {
      // Reset state on startup failure to allow recovery
      running = false;
      watcher = null;
      throw err;
    }
  };

  const stop = async () => {
    // Always clear the running flag first to signal shutdown to in-flight start()
    const wasRunning = running;
    running = false;

    // Clear any pending timers
    if (processTimer) {
      clearTimeout(processTimer);
      processTimer = null;
    }

    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }

    // Wait for any in-flight processing to complete before closing the watcher.
    // This prevents duplicate event processing during config reload:
    // if we return before dispatch completes, a new watcher could start and
    // process the same event file that the old watcher is still handling.
    if (processingDonePromise) {
      await processingDonePromise;
    }

    // Always close watcher if it exists, even if running was already false
    // This handles the race where stop() is called during start()'s async init
    if (watcher) {
      await watcher.close();
      watcher = null;
    }

    if (wasRunning) {
      log.info("stopped");
    }
  };

  const getState = (): SpoolWatcherState => ({
    running,
    eventsDir,
    deadLetterDir,
    pendingCount: pendingFiles.size,
  });

  const processExisting = async () => {
    if (!running) {
      return;
    }

    const events = await listSpoolEvents();
    for (const event of events) {
      const filePath = path.join(eventsDir, `${event.id}.json`);
      pendingFiles.add(filePath);
    }

    if (pendingFiles.size > 0) {
      scheduleProcessing();
    }
  };

  return {
    start,
    stop,
    getState,
    processExisting,
  };
}
