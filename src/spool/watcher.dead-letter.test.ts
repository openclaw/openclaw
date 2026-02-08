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

// Control dispatcher behavior for dead-letter testing
let shouldFail = false;
let failureError = "simulated failure";

vi.mock("./dispatcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dispatcher.js")>();
  return {
    ...actual,
    dispatchSpoolEventFile: vi.fn().mockImplementation(async (params) => {
      // Use path.basename for cross-platform compatibility (Windows uses backslashes)
      const eventId = path.basename(params.filePath).replace(".json", "");

      if (shouldFail) {
        return {
          status: "error",
          eventId,
          error: failureError,
        };
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
  return withTempHomeBase(fn, { prefix: "openclaw-watcher-deadletter-" });
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

describe("spool watcher - dead-letter handling", () => {
  beforeEach(() => {
    shouldFail = false;
    failureError = "simulated failure";
    vi.mocked(dispatchSpoolEventFile).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "logs warning when event fails",
    async () => {
      await withTempHome(async (home) => {
        const eventsDir = path.join(home, ".openclaw", "spool", "events");
        await fs.mkdir(eventsDir, { recursive: true });

        shouldFail = true;
        failureError = "dispatch failed";

        const event = buildSpoolEvent({
          version: 1,
          payload: { kind: "agentTurn", message: "Will fail" },
        });
        await writeSpoolEvent(event);

        const logger = createMockLogger();
        const results: SpoolDispatchResult[] = [];

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
          onEvent: (result) => results.push(result),
        });

        await watcher.start();
        await new Promise((resolve) => setTimeout(resolve, 500 * CI_WAIT_MULTIPLIER));
        await stopWatcherSafely(watcher);

        // Should have logged warning
        const warnLog = logger.logs.find((l) => l.level === "warn" && l.msg.includes("failed"));
        expect(warnLog).toBeDefined();
        expect(warnLog?.msg).toContain(event.id);
        expect(warnLog?.msg).toContain("dispatch failed");

        // Result should indicate error
        expect(results).toHaveLength(1);
        expect(results[0].status).toBe("error");
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "logs info when event expires",
    async () => {
      await withTempHome(async (home) => {
        const eventsDir = path.join(home, ".openclaw", "spool", "events");
        await fs.mkdir(eventsDir, { recursive: true });

        // Mock expired status
        vi.mocked(dispatchSpoolEventFile).mockResolvedValueOnce({
          status: "expired",
          eventId: "expired-event",
          error: "event expired",
        });

        const event = buildSpoolEvent({
          version: 1,
          expiresAt: new Date(Date.now() - 60_000).toISOString(), // Past
          payload: { kind: "agentTurn", message: "Expired event" },
        });
        await writeSpoolEvent(event);

        const logger = createMockLogger();
        const results: SpoolDispatchResult[] = [];

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
          onEvent: (result) => results.push(result),
        });

        await watcher.start();
        await new Promise((resolve) => setTimeout(resolve, 500 * CI_WAIT_MULTIPLIER));
        await stopWatcherSafely(watcher);

        // Should have logged info about expiration
        const infoLog = logger.logs.find((l) => l.level === "info" && l.msg.includes("expired"));
        expect(infoLog).toBeDefined();

        // Result should indicate expired
        expect(results).toHaveLength(1);
        expect(results[0].status).toBe("expired");
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "logs success on successful dispatch",
    async () => {
      await withTempHome(async (home) => {
        const eventsDir = path.join(home, ".openclaw", "spool", "events");
        await fs.mkdir(eventsDir, { recursive: true });

        const event = buildSpoolEvent({
          version: 1,
          payload: { kind: "agentTurn", message: "Success" },
        });
        await writeSpoolEvent(event);

        const logger = createMockLogger();

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
        });

        await watcher.start();
        await new Promise((resolve) => setTimeout(resolve, 500 * CI_WAIT_MULTIPLIER));
        await stopWatcherSafely(watcher);

        // Should have logged success
        const infoLog = logger.logs.find((l) => l.level === "info" && l.msg.includes("dispatched"));
        expect(infoLog).toBeDefined();
        expect(infoLog?.msg).toContain(event.id);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "logs error on unexpected processing failure",
    async () => {
      await withTempHome(async (home) => {
        const eventsDir = path.join(home, ".openclaw", "spool", "events");
        await fs.mkdir(eventsDir, { recursive: true });

        // Make dispatcher throw
        vi.mocked(dispatchSpoolEventFile).mockRejectedValueOnce(new Error("unexpected crash"));

        const event = buildSpoolEvent({
          version: 1,
          payload: { kind: "agentTurn", message: "Will crash" },
        });
        await writeSpoolEvent(event);

        const logger = createMockLogger();

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
        });

        await watcher.start();
        await new Promise((resolve) => setTimeout(resolve, 500 * CI_WAIT_MULTIPLIER));
        await stopWatcherSafely(watcher);

        // Should have logged error
        const errorLog = logger.logs.find(
          (l) => l.level === "error" && l.msg.includes("failed to process"),
        );
        expect(errorLog).toBeDefined();
        expect(errorLog?.msg).toContain("unexpected crash");
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "includes summary in success log when present",
    async () => {
      await withTempHome(async (home) => {
        const eventsDir = path.join(home, ".openclaw", "spool", "events");
        await fs.mkdir(eventsDir, { recursive: true });

        const event = buildSpoolEvent({
          version: 1,
          payload: { kind: "agentTurn", message: "With summary" },
        });

        vi.mocked(dispatchSpoolEventFile).mockResolvedValueOnce({
          status: "ok",
          eventId: event.id,
          summary: "Task completed successfully",
        });

        await writeSpoolEvent(event);

        const logger = createMockLogger();

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
        });

        await watcher.start();
        await new Promise((resolve) => setTimeout(resolve, 500 * CI_WAIT_MULTIPLIER));
        await stopWatcherSafely(watcher);

        // Should have logged success with summary
        const infoLog = logger.logs.find((l) => l.level === "info" && l.msg.includes("dispatched"));
        expect(infoLog).toBeDefined();
        expect(infoLog?.msg).toContain("Task completed successfully");
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "reports dead-letter directory in state",
    async () => {
      await withTempHome(async () => {
        const logger = createMockLogger();

        const watcher = createSpoolWatcher({
          deps: mockDeps,
          log: logger,
        });

        await watcher.start();

        const state = watcher.getState();
        expect(state.deadLetterDir).toContain("dead-letter");

        await stopWatcherSafely(watcher);
      });
    },
    TEST_TIMEOUT,
  );
});
