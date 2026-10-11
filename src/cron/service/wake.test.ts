import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.js";
import { wake } from "./wake.js";

function createState(jobs: CronJob[] = []) {
  const enqueueSessionEvent = vi.fn();
  const deferSessionEvent = vi.fn();
  return {
    state: {
      store: { version: 1, jobs },
      stopped: false,
      deps: {
        nowMs: () => 10_000,
        cronEnabled: true,
        enqueueSessionEvent,
        deferSessionEvent,
        resolveSessionEventTarget: (opts?: { agentId?: string; sessionKey?: string }) => ({
          agentId: opts?.agentId ?? "main",
          sessionKey: opts?.sessionKey ?? `agent:${opts?.agentId ?? "main"}:main`,
        }),
      },
    } as unknown as Parameters<typeof wake>[0],
    enqueueSessionEvent,
    deferSessionEvent,
  };
}

describe("wake (cron timer)", () => {
  it("returns ok:false on empty text without enqueueing or waking", async () => {
    const { state, enqueueSessionEvent, deferSessionEvent } = createState();
    expect(await wake(state, { mode: "now", text: "   " })).toEqual({ ok: false });
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
    expect(deferSessionEvent).not.toHaveBeenCalled();
  });

  it("threads sessionKey into ordinary session admission on mode=now", async () => {
    const { state, enqueueSessionEvent, deferSessionEvent } = createState();
    expect(
      await wake(state, {
        mode: "now",
        text: "ping",
        sessionKey: "agent:main:telegram:dm:42",
      }),
    ).toEqual({ ok: true });
    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("ping", {
      sessionKey: "agent:main:telegram:dm:42",
    });
    expect(deferSessionEvent).not.toHaveBeenCalled();
  });

  it.each([
    { name: "recurring", schedule: { kind: "every", everyMs: 60_000 } },
    { name: "one-shot", schedule: { kind: "at", at: new Date(60_000).toISOString() } },
    {
      name: "all-day one-shot",
      schedule: { kind: "at", at: new Date(60_000).toISOString() },
      activeHours: { start: "00:00", end: "24:00", timezone: "UTC" },
    },
    {
      name: "conditional recurring",
      schedule: { kind: "every", everyMs: 60_000 },
      trigger: { script: "return false" },
      activeHours: { start: "09:00", end: "17:00", timezone: "UTC" },
    },
  ] satisfies Array<{ name: string } & Pick<CronJob, "schedule" | "trigger" | "activeHours">>)(
    "defers untargeted next-heartbeat work to an enabled $name session job",
    async (receiver) => {
      const job: CronJob = {
        id: "scheduled-session",
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
        payload: { kind: "agentTurn", message: "check pending work" },
        sessionTarget: "main",
        wakeMode: "now",
        state: { nextRunAtMs: 60_000 },
        ...receiver,
      };
      const { state, enqueueSessionEvent, deferSessionEvent } = createState([
        { ...job, id: "other-owner", agentId: "other" },
        job,
      ]);
      expect(await wake(state, { mode: "next-heartbeat", text: "ping" })).toEqual({ ok: true });
      expect(deferSessionEvent).toHaveBeenCalledExactlyOnceWith(
        "ping",
        job,
        undefined,
        expect.any(Function),
        60_000,
        undefined,
        undefined,
      );
      expect(enqueueSessionEvent).not.toHaveBeenCalled();
    },
  );

  it("does not accept deferred notices onto a one-shot with restricted active hours", async () => {
    const job: CronJob = {
      id: "conditional-one-shot",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "at", at: new Date(60_000).toISOString() },
      payload: { kind: "agentTurn", message: "check pending work" },
      sessionTarget: "main",
      wakeMode: "now",
      state: { nextRunAtMs: 60_000 },
      name: "Conditional one-shot",
      activeHours: { start: "09:00", end: "17:00", timezone: "UTC" },
    };
    const { state, enqueueSessionEvent, deferSessionEvent } = createState([job]);
    expect(await wake(state, { mode: "next-heartbeat", text: "ping" })).toEqual({
      ok: false,
      reason: expect.stringContaining("No enabled ordinary scheduled session job"),
    });
    expect(deferSessionEvent).not.toHaveBeenCalled();
    expect(enqueueSessionEvent).not.toHaveBeenCalled();

    const unconditional: CronJob = {
      ...job,
      id: "later-one-shot",
      trigger: undefined,
      activeHours: undefined,
      schedule: { kind: "at", at: new Date(120_000).toISOString() },
      state: { nextRunAtMs: 120_000 },
    };
    state.store!.jobs.push(unconditional);
    expect(await wake(state, { mode: "next-heartbeat", text: "ping" })).toEqual({ ok: true });
    expect(deferSessionEvent).toHaveBeenCalledExactlyOnceWith(
      "ping",
      unconditional,
      undefined,
      expect.any(Function),
      120_000,
      undefined,
      undefined,
    );
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
  });

  it("reports when no scheduled session can receive deferred work", async () => {
    const { state, enqueueSessionEvent, deferSessionEvent } = createState();
    expect(await wake(state, { mode: "next-heartbeat", text: "ping" })).toEqual({
      ok: false,
      reason: expect.stringContaining("No enabled ordinary scheduled session job"),
    });
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
    expect(deferSessionEvent).not.toHaveBeenCalled();
  });

  it("rejects subagent sessionKey targets without enqueueing or waking", async () => {
    const { state, enqueueSessionEvent, deferSessionEvent } = createState();
    expect(
      await wake(state, {
        mode: "now",
        text: "ping",
        sessionKey: "agent:main:subagent:worker",
      }),
    ).toEqual({ ok: false, reason: "unwakeable-session-key" });
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
    expect(deferSessionEvent).not.toHaveBeenCalled();
  });
});
