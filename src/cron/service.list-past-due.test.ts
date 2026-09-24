import { describe, expect, it, vi } from "vitest";
import { mockCall } from "../test-utils/mock-call-assertions.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  setupCronServiceSuite,
} from "./service.test-harness.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-16156-",
  baseTimeIso: "2025-12-13T00:00:00.000Z",
});

// Regression #16156: read operations must not consume an overdue occurrence.
describe("#16156: cron reads must not silently advance past-due recurring jobs", () => {
  it.each([
    { read: "list", expr: "* * * * *", text: "cron-tick", dueMinutes: 1, lateMs: 5 },
    { read: "status", expr: "*/5 * * * *", text: "tick-5", dueMinutes: 5, lateMs: 10 },
  ])("does not skip a past-due cron job when $read() is called", async (scenario) => {
    const store = await makeStorePath();
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });

    await cron.start();
    const job = await cron.add({
      name: `${scenario.read}-past-due`,
      enabled: true,
      schedule: { kind: "cron", expr: scenario.expr },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: scenario.text },
    });
    const firstDueAt = job.state.nextRunAtMs!;
    expect(firstDueAt).toBe(Date.parse("2025-12-13T00:00:00.000Z") + scenario.dueMinutes * 60_000);
    vi.setSystemTime(new Date(firstDueAt + scenario.lateMs));

    if (scenario.read === "list") {
      const listed = await cron.list({ includeDisabled: true });
      expect(listed.find((entry) => entry.id === job.id)?.state.nextRunAtMs).toBe(firstDueAt);
    } else {
      await cron.status();
    }

    const finishedRun = finished.waitForOk(job.id);
    await vi.runOnlyPendingTimersAsync();
    await finishedRun;

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((entry) => entry.id === job.id);
    const [text, options] = mockCall(enqueueSystemEvent) as [
      string,
      { agentId?: string } | undefined,
    ];
    expect(text).toBe(scenario.text);
    expect(options?.agentId).toBe("main");
    expect(updated?.state.lastStatus).toBe("ok");
    expect(updated?.state.nextRunAtMs).toBeGreaterThan(firstDueAt);

    cron.stop();
  });
});
