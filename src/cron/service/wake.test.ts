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
  it("returns ok:false on empty text without enqueueing or waking", () => {
    const { state, enqueueSessionEvent, deferSessionEvent } = createState();
    expect(wake(state, { mode: "now", text: "   " })).toEqual({ ok: false });
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
    expect(deferSessionEvent).not.toHaveBeenCalled();
  });

  it("threads sessionKey into ordinary session admission on mode=now", () => {
    const { state, enqueueSessionEvent, deferSessionEvent } = createState();
    expect(
      wake(state, {
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

  it("defers untargeted next-heartbeat work to an enabled scheduled session job", () => {
    const job: CronJob = {
      id: "scheduled-session",
      name: "scheduled session",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "check pending work" },
      sessionTarget: "main",
      wakeMode: "now",
      state: { nextRunAtMs: 60_000 },
    };
    const { state, enqueueSessionEvent, deferSessionEvent } = createState([
      { ...job, id: "other-owner", agentId: "other" },
      job,
    ]);
    expect(wake(state, { mode: "next-heartbeat", text: "ping" })).toEqual({ ok: true });
    expect(deferSessionEvent).toHaveBeenCalledExactlyOnceWith("ping", job, undefined);
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
  });

  it("reports when no scheduled session can receive deferred work", () => {
    const { state, enqueueSessionEvent, deferSessionEvent } = createState();
    expect(wake(state, { mode: "next-heartbeat", text: "ping" })).toEqual({
      ok: false,
      reason: expect.stringContaining("No enabled ordinary scheduled session job"),
    });
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
    expect(deferSessionEvent).not.toHaveBeenCalled();
  });

  it("rejects subagent sessionKey targets without enqueueing or waking", () => {
    const { state, enqueueSessionEvent, deferSessionEvent } = createState();
    expect(
      wake(state, {
        mode: "now",
        text: "ping",
        sessionKey: "agent:main:subagent:worker",
      }),
    ).toEqual({ ok: false, reason: "unwakeable-session-key" });
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
    expect(deferSessionEvent).not.toHaveBeenCalled();
  });
});
