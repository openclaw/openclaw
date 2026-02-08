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

// Track dispatch order for concurrency testing
let dispatchOrder: string[] = [];
let dispatchDelay = 0;

// Mock the dispatcher with controllable timing
vi.mock("./dispatcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dispatcher.js")>();
  return {
    ...actual,
    dispatchSpoolEventFile: vi.fn().mockImplementation(async (params) => {
      // Use path.basename for cross-platform compatibility (Windows uses backslashes)
      const eventId = path.basename(params.filePath).replace(".json", "");
      dispatchOrder.push(eventId);

      // Simulate processing time
      if (dispatchDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, dispatchDelay));
      }

      return {
        status: "ok",
        eventId,
        summary: `dispatched ${eventId}`,
      };
    }),
  };
});

import { dispatchSpoolEventFile } from "./dispatcher.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-watcher-concurrent-" });
}

function createMockLogger(): SpoolWatcherLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
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

describe("spool watcher - handles concurrent events", () => {
  beforeEach(() => {
    dispatchOrder = [];
    dispatchDelay = 0;
    vi.mocked(dispatchSpoolEventFile).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "processes multiple events sequentially within a batch",
    async () => {
      await withTempHome(async (home) => {
        const eventsDir = path.join(home, ".openclaw", "spool", "events");
        await fs.mkdir(eventsDir, { recursive: true });

        // Add processing delay to verify sequential execution
        dispatchDelay = 50;

        // Create multiple events
        const events = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            (async () => {
              const event = buildSpoolEvent({
                version: 1,
                payload: { kind: "agentTurn", message: `Event ${i}` },
              });
              await writeSpoolEvent(event);
              return event;
            })(),
          ),
        );

        const logger = createMockLogger();
        const results: SpoolDispatchResult[] = [];

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
          onEvent: (result) => results.push(result),
        });

        await watcher.start();

        // Wait for all events to be processed (5 events * 50ms + buffer)
        await new Promise((resolve) => setTimeout(resolve, 1000 * CI_WAIT_MULTIPLIER));

        await stopWatcherSafely(watcher);

        // All events should be processed
        expect(results).toHaveLength(5);

        // Dispatch order should have all 5 events (order may vary due to file system)
        expect(dispatchOrder).toHaveLength(5);
        for (const event of events) {
          expect(dispatchOrder).toContain(event.id);
        }
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "debounces rapid file additions",
    async () => {
      await withTempHome(async (home) => {
        const eventsDir = path.join(home, ".openclaw", "spool", "events");
        await fs.mkdir(eventsDir, { recursive: true });

        const logger = createMockLogger();
        const results: SpoolDispatchResult[] = [];

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
          onEvent: (result) => results.push(result),
        });

        await watcher.start();

        // Wait for initial startup
        await new Promise((resolve) => setTimeout(resolve, 300 * CI_WAIT_MULTIPLIER));

        // Add events in rapid succession
        const events = [];
        for (let i = 0; i < 3; i++) {
          const event = buildSpoolEvent({
            version: 1,
            payload: { kind: "agentTurn", message: `Rapid event ${i}` },
          });
          await writeSpoolEvent(event);
          events.push(event);
          // Very short delay between writes
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        // Wait for debounce (100ms) + processing
        await new Promise((resolve) => setTimeout(resolve, 800 * CI_WAIT_MULTIPLIER));

        await stopWatcherSafely(watcher);

        // All events should be processed, potentially in one batch
        expect(results).toHaveLength(3);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "continues processing when new events arrive during processing",
    async () => {
      await withTempHome(async (home) => {
        const eventsDir = path.join(home, ".openclaw", "spool", "events");
        await fs.mkdir(eventsDir, { recursive: true });

        // Slow processing to test queue behavior
        dispatchDelay = 100;

        const logger = createMockLogger();
        const results: SpoolDispatchResult[] = [];

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
          onEvent: (result) => results.push(result),
        });

        // Create initial event
        const event1 = buildSpoolEvent({
          version: 1,
          payload: { kind: "agentTurn", message: "First event" },
        });
        await writeSpoolEvent(event1);

        await watcher.start();

        // Wait a bit for processing to start
        await new Promise((resolve) => setTimeout(resolve, 300 * CI_WAIT_MULTIPLIER));

        // Add another event while first is processing
        const event2 = buildSpoolEvent({
          version: 1,
          payload: { kind: "agentTurn", message: "Second event" },
        });
        await writeSpoolEvent(event2);

        // Wait for both to complete
        await new Promise((resolve) => setTimeout(resolve, 800 * CI_WAIT_MULTIPLIER));

        await stopWatcherSafely(watcher);

        // Both events should be processed
        expect(results).toHaveLength(2);
        expect(dispatchOrder).toContain(event1.id);
        expect(dispatchOrder).toContain(event2.id);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "getState returns current pending count",
    async () => {
      await withTempHome(async (home) => {
        const eventsDir = path.join(home, ".openclaw", "spool", "events");
        await fs.mkdir(eventsDir, { recursive: true });

        // Very slow processing
        dispatchDelay = 500;

        const logger = createMockLogger();

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
        });

        // Create events before starting
        for (let i = 0; i < 3; i++) {
          const event = buildSpoolEvent({
            version: 1,
            payload: { kind: "agentTurn", message: `Event ${i}` },
          });
          await writeSpoolEvent(event);
        }

        await watcher.start();

        // Initial state
        const state = watcher.getState();
        expect(state.running).toBe(true);
        // Use path.join for cross-platform path comparison
        expect(state.eventsDir).toContain(path.join("spool", "events"));
        expect(state.deadLetterDir).toContain(path.join("spool", "dead-letter"));

        await stopWatcherSafely(watcher);

        // Stopped state
        const stoppedState = watcher.getState();
        expect(stoppedState.running).toBe(false);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "does not process files after stop is called",
    async () => {
      await withTempHome(async (home) => {
        const eventsDir = path.join(home, ".openclaw", "spool", "events");
        await fs.mkdir(eventsDir, { recursive: true });

        const logger = createMockLogger();

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
        });

        await watcher.start();

        // Wait for watcher to fully initialize
        await new Promise((resolve) => setTimeout(resolve, 300 * CI_WAIT_MULTIPLIER));

        await stopWatcherSafely(watcher);

        // Clear any calls from startup
        vi.mocked(dispatchSpoolEventFile).mockClear();

        // Add event after stop
        const event = buildSpoolEvent({
          version: 1,
          payload: { kind: "agentTurn", message: "After stop" },
        });
        await writeSpoolEvent(event);

        // Wait to ensure no processing happens
        await new Promise((resolve) => setTimeout(resolve, 500 * CI_WAIT_MULTIPLIER));

        // No new dispatches should occur
        expect(dispatchSpoolEventFile).not.toHaveBeenCalled();
      });
    },
    TEST_TIMEOUT,
  );
});
