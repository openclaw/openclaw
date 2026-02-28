import { describe, expect, it, vi } from "vitest";
import {
  createCronStoreHarness,
  createNoopLogger,
  writeCronStoreSnapshot,
} from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { ensureLoaded } from "./service/store.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({
  prefix: "openclaw-cron-issue-29757-",
});

describe("Cron issue #29757 delayed-interval replay", () => {
  it("fails fast when cron store contains missing ids", async () => {
    const store = await makeStorePath();
    const nowMs = Date.parse("2026-02-28T08:59:50.000Z");

    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        {
          // Mirrors malformed records seen in #29757 reports.
          id: undefined as unknown as string,
          name: "daily bing wallpaper",
          enabled: true,
          createdAtMs: nowMs - 86_400_000,
          updatedAtMs: nowMs - 86_400_000,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "run bing image script" },
          state: { nextRunAtMs: Date.parse("2026-03-01T01:00:00.000Z") },
        },
        {
          id: undefined as unknown as string,
          name: "book return reminder",
          enabled: true,
          deleteAfterRun: true,
          createdAtMs: nowMs - 86_400_000,
          updatedAtMs: nowMs - 86_400_000,
          schedule: { kind: "at", at: "2026-02-28T09:00:00.000Z" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "book reminder" },
          state: { nextRunAtMs: Date.parse("2026-02-28T09:00:00.000Z") },
        },
      ],
    });

    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      nowMs: () => nowMs,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await expect(ensureLoaded(state, { skipRecompute: true })).rejects.toThrow(
      /missing a non-empty id .*load/i,
    );
    await store.cleanup();
  });
});
