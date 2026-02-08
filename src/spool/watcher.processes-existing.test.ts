import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { SpoolDispatchResult } from "./types.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { createSpoolWatcher, type SpoolWatcherLogger } from "./watcher.js";
import { buildSpoolEvent, writeSpoolEvent } from "./writer.js";

// Per-test timeout: fail fast instead of hanging CI
const TEST_TIMEOUT = 15_000;

// Extra delay for Windows to release file handles after watcher.stop()
const WINDOWS_CLEANUP_DELAY = process.platform === "win32" ? 500 : 100;

// Longer waits for CI environments (especially Windows)
const CI_WAIT_MULTIPLIER = process.env.CI ? 2 : 1;

// Mock the dispatcher to avoid running actual agent turns
vi.mock("./dispatcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dispatcher.js")>();
  return {
    ...actual,
    dispatchSpoolEventFile: vi.fn().mockResolvedValue({
      status: "ok",
      eventId: "test-id",
      summary: "mocked dispatch",
    }),
  };
});

import { dispatchSpoolEventFile } from "./dispatcher.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-watcher-existing-" });
}

function createMockLogger(): SpoolWatcherLogger & { logs: { level: string; msg: string }[] } {
  const logs: { level: string; msg: string }[] = [];
  return {
    logs,
    info: (msg: string) => logs.push({ level: "info", msg }),
    warn: (msg: string) => logs.push({ level: "warn", msg }),
    error: (msg: string) => logs.push({ level: "error", msg }),
  };
}

/**
 * Stop watcher with platform-appropriate cleanup delay.
 * Windows needs extra time to release file handles.
 */
async function stopWatcherSafely(watcher: ReturnType<typeof createSpoolWatcher>): Promise<void> {
  await watcher.stop();
  await new Promise((resolve) => setTimeout(resolve, WINDOWS_CLEANUP_DELAY));
}

const mockDeps = {} as CliDeps;

describe("spool watcher - processes existing files on startup", () => {
  beforeEach(() => {
    vi.mocked(dispatchSpoolEventFile).mockReset();
    vi.mocked(dispatchSpoolEventFile).mockResolvedValue({
      status: "ok",
      eventId: "test-id",
      summary: "mocked dispatch",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "processes existing events when watcher starts",
    async () => {
      await withTempHome(async (home) => {
        const eventsDir = path.join(home, ".openclaw", "spool", "events");
        await fs.mkdir(eventsDir, { recursive: true });

        // Create some existing events
        const event1 = buildSpoolEvent({
          version: 1,
          payload: { kind: "agentTurn", message: "Existing event 1" },
        });
        const event2 = buildSpoolEvent({
          version: 1,
          payload: { kind: "agentTurn", message: "Existing event 2" },
        });

        await writeSpoolEvent(event1);
        await writeSpoolEvent(event2);

        const logger = createMockLogger();
        const results: SpoolDispatchResult[] = [];

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
          onEvent: (result) => results.push(result),
        });

        await watcher.start();

        // Wait for chokidar to detect files and debounce to trigger
        // CI environments may need more time due to slower file systems
        await new Promise((resolve) => setTimeout(resolve, 1000 * CI_WAIT_MULTIPLIER));

        await stopWatcherSafely(watcher);

        // Both events should have been dispatched
        expect(dispatchSpoolEventFile).toHaveBeenCalledTimes(2);
        expect(results).toHaveLength(2);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "logs watching directory on start",
    async () => {
      await withTempHome(async (_home) => {
        const logger = createMockLogger();

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
        });

        await watcher.start();
        await stopWatcherSafely(watcher);

        const watchingLog = logger.logs.find((l) => l.msg.includes("watching"));
        expect(watchingLog).toBeDefined();
        // Use path.join for cross-platform path comparison
        expect(watchingLog?.msg).toContain(path.join("spool", "events"));
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "processExisting() adds all events to queue",
    async () => {
      await withTempHome(async (home) => {
        const eventsDir = path.join(home, ".openclaw", "spool", "events");
        await fs.mkdir(eventsDir, { recursive: true });

        const logger = createMockLogger();

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
        });

        // Start watcher first (no events exist yet)
        await watcher.start();

        // Wait for initial scan to complete
        await new Promise((resolve) => setTimeout(resolve, 300 * CI_WAIT_MULTIPLIER));

        // Clear any calls from startup
        vi.mocked(dispatchSpoolEventFile).mockClear();

        // Now create events AFTER watcher is running but before processExisting
        // We need to wait for chokidar to detect them, then call processExisting
        const event1 = buildSpoolEvent({
          version: 1,
          payload: { kind: "agentTurn", message: "Event 1" },
        });
        const event2 = buildSpoolEvent({
          version: 1,
          payload: { kind: "agentTurn", message: "Event 2" },
        });
        const event3 = buildSpoolEvent({
          version: 1,
          payload: { kind: "agentTurn", message: "Event 3" },
        });

        // Write files with small delays to ensure chokidar detects each one
        // (rapid writes can be coalesced or missed in CI environments)
        await writeSpoolEvent(event1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await writeSpoolEvent(event2);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await writeSpoolEvent(event3);

        // Wait for chokidar to pick up the files and process them
        // CI environments may need more time due to slower file systems and awaitWriteFinish
        await new Promise((resolve) => setTimeout(resolve, 1500 * CI_WAIT_MULTIPLIER));

        await stopWatcherSafely(watcher);

        // All three events should be processed (by chokidar watching)
        expect(dispatchSpoolEventFile).toHaveBeenCalledTimes(3);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "skips temp files during processing",
    async () => {
      await withTempHome(async (home) => {
        const eventsDir = path.join(home, ".openclaw", "spool", "events");
        await fs.mkdir(eventsDir, { recursive: true });

        // Create a regular event
        const event = buildSpoolEvent({
          version: 1,
          payload: { kind: "agentTurn", message: "Regular event" },
        });
        await writeSpoolEvent(event);

        // Create a temp file (should be skipped) - matches writer.ts pattern: <id>.json.tmp.<uuid>
        const tempFile = path.join(eventsDir, "abc.json.tmp.123");
        await fs.writeFile(tempFile, JSON.stringify({ version: 1 }));

        const logger = createMockLogger();

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
        });

        await watcher.start();
        await new Promise((resolve) => setTimeout(resolve, 500 * CI_WAIT_MULTIPLIER));
        await stopWatcherSafely(watcher);

        // Only the regular event should be dispatched
        expect(dispatchSpoolEventFile).toHaveBeenCalledTimes(1);
        const calls = vi.mocked(dispatchSpoolEventFile).mock.calls;
        expect(calls[0][0].filePath).toContain(event.id);
      });
    },
    TEST_TIMEOUT,
  );
});
