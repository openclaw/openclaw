import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronJob } from "../types.js";
import { createCronServiceState, type CronServiceDeps } from "./state.js";
import { wake } from "./wake.js";

function createState(jobs: CronJob[] = []) {
  const enqueueSessionEvent = vi.fn<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>();
  const deferSessionEvent = vi.fn<NonNullable<CronServiceDeps["deferSessionEvent"]>>();
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath: "unused-wake-receiver-store",
    nowMs: () => 10_000,
    cronEnabled: true,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
    enqueueSessionEvent,
    deferSessionEvent,
    resolveSessionEventTarget: (opts) => ({
      agentId: opts?.agentId ?? "main",
      sessionKey: opts?.sessionKey ?? `agent:${opts?.agentId ?? "main"}:main`,
    }),
  });
  state.store = { version: 1, jobs };
  return { state, enqueueSessionEvent, deferSessionEvent };
}
const oneShot: CronJob["schedule"] = { kind: "at", at: new Date(60_000).toISOString() };
const restrictedHours = { start: "09:00", end: "17:00", timezone: "UTC" };
const receiverJob = (overrides: Partial<CronJob>) =>
  makeCronJob({
    sessionTarget: "main",
    state: { nextRunAtMs: 60_000 },
    ...overrides,
  });
const noReceiver = {
  ok: false,
  reason: expect.stringContaining("No enabled ordinary scheduled session job"),
};

describe("wake (cron timer)", () => {
  it.each([
    [{ mode: "now", text: "   " }, { ok: false }],
    [{ mode: "next-heartbeat", text: "ping" }, noReceiver],
    [
      { mode: "now", text: "ping", sessionKey: "agent:main:subagent:worker" },
      { ok: false, reason: "unwakeable-session-key" },
    ],
  ] as const)("rejects %j without admission", async (opts, expected) => {
    const { state, enqueueSessionEvent, deferSessionEvent } = createState();
    expect(await wake(state, opts)).toEqual(expected);
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
    expect(deferSessionEvent).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "targets ordinary admission and returns its acceptance (%s)",
    async (accepted) => {
      const { state, enqueueSessionEvent, deferSessionEvent } = createState();
      enqueueSessionEvent.mockResolvedValueOnce(
        accepted ? { ok: true } : { ok: false, error: "session was replaced" },
      );
      const sessionKey = "agent:main:telegram:dm:42";
      expect(await wake(state, { mode: "now", text: "ping", sessionKey })).toEqual(
        accepted ? { ok: true } : { ok: false, reason: "session was replaced" },
      );
      expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("ping", { sessionKey });
      expect(deferSessionEvent).not.toHaveBeenCalled();
    },
  );

  it.each<Partial<CronJob>>([
    { trigger: { script: "return false" }, activeHours: restrictedHours },
    { schedule: oneShot },
    { schedule: oneShot, activeHours: { start: "00:00", end: "24:00", timezone: "UTC" } },
  ])("defers to the matching scheduled receiver (%j)", async (overrides) => {
    const job = receiverJob(overrides);
    const fixture = createState([{ ...job, id: "other-owner", agentId: "other" }, job]);
    expect(await wake(fixture.state, { mode: "next-heartbeat", text: "ping" })).toEqual({
      ok: true,
    });
    expect(fixture.deferSessionEvent).toHaveBeenCalledExactlyOnceWith(
      "ping",
      job,
      undefined,
      expect.any(Function),
      60_000,
      undefined,
      undefined,
    );
    expect(fixture.enqueueSessionEvent).not.toHaveBeenCalled();
  });

  it("skips a restricted one-shot and accepts a later unconditional receiver", async () => {
    const job = receiverJob({ schedule: oneShot, activeHours: restrictedHours });
    const { state, enqueueSessionEvent, deferSessionEvent } = createState([job]);
    const opts = { mode: "next-heartbeat", text: "ping" } as const;
    expect(await wake(state, opts)).toEqual(noReceiver);
    expect(deferSessionEvent).not.toHaveBeenCalled();
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
    const later = receiverJob({
      id: "later",
      schedule: { kind: "at", at: new Date(120_000).toISOString() },
      state: { nextRunAtMs: 120_000 },
    });
    state.store!.jobs.push(later);
    expect(await wake(state, opts)).toEqual({ ok: true });
    expect(deferSessionEvent).toHaveBeenCalledExactlyOnceWith(
      "ping",
      later,
      undefined,
      expect.any(Function),
      120_000,
      undefined,
      undefined,
    );
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
  });

  it("rechecks requester authority after resolving the origin route", async () => {
    const { state, enqueueSessionEvent } = createState();
    const entered = createDeferred();
    const release = createDeferred();
    let current = true;
    state.deps.resolveOriginDeliveryContext = async () => {
      entered.resolve();
      await release.promise;
      return undefined;
    };
    const pending = wake(state, {
      mode: "now",
      text: "pending reminder",
      sessionKey: "agent:main:project:notes",
      commitGuard: () => {
        if (!current) {
          throw new Error("requester authority revoked");
        }
      },
    });
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "Wake skipped route resolution");
      current = false;
      release.resolve();
      await expect(pending).rejects.toThrow("requester authority revoked");
      expect(enqueueSessionEvent).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
  });
});
