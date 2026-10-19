import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { reconcileHeartbeatMonitorJobs } from "../cron/heartbeat-monitor.js";
import type { CronJob, CronJobCreate } from "../cron/types.js";

const logger = { warn: vi.fn() };

type AddOptions = { matchesExisting?: (job: CronJob) => boolean };
type Add = (
  input: CronJobCreate,
  options?: AddOptions & { commitGuard?: () => void },
) => Promise<unknown>;

async function reconcile(
  cfg: OpenClawConfig,
  add: Add,
  jobs: CronJob[] = [],
  commitGuard?: () => void,
) {
  const remove = vi.fn(async (_id: string) => ({ ok: true }));
  await reconcileHeartbeatMonitorJobs({
    cron: { add, remove, list: vi.fn(async () => jobs) } as never,
    cfg,
    logger,
    commitGuard,
  });
  return remove;
}

function heartbeatConfig(
  every: string,
  entries: NonNullable<OpenClawConfig["agents"]>["entries"] = { main: {} },
): OpenClawConfig {
  return { agents: { ownership: "explicit", defaults: { heartbeat: { every } }, entries } };
}

function monitorJob(agentId: string, id = `job-${agentId}`): CronJob {
  return {
    id,
    declarationKey: `heartbeat:${agentId}`,
    name: `heartbeat-${agentId}`,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    agentId,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "heartbeat" },
    state: {},
  } as CronJob;
}

describe("reconcileHeartbeatMonitorJobs", () => {
  it.each(["add", "remove"] as const)(
    "lets the event loop progress between %s attempts, including a failed attempt",
    async (mutation) => {
      let progressed = false;
      let checkpoint: Promise<void> | undefined;
      const observed: Array<{ id: string; progressed: boolean }> = [];
      const recordAttempt = (id: string) => {
        observed.push({ id, progressed });
        if (observed.length === 1) {
          checkpoint = nextTurn().then(() => {
            progressed = true;
          });
          throw new Error("first mutation failed");
        }
      };
      const add = vi.fn(async (input: { agentId: string }) => {
        if (mutation === "add") {
          recordAttempt(input.agentId);
        }
        return monitorJob(input.agentId);
      });
      const remove = vi.fn(async (id: string) => {
        if (mutation === "remove") {
          recordAttempt(id);
        }
        return { ok: true, removed: true };
      });
      try {
        const result = await reconcileHeartbeatMonitorJobs({
          cron: {
            add,
            remove,
            list: vi.fn(async () =>
              mutation === "remove" ? [monitorJob("a"), monitorJob("b"), monitorJob("c")] : [],
            ),
          } as never,
          cfg: heartbeatConfig("30m", mutation === "add" ? { a: {}, b: {}, c: {} } : { main: {} }),
          logger,
        });
        expect(result).toEqual({ ok: false });
        expect(observed).toEqual(
          (mutation === "add" ? ["a", "b", "c"] : ["job-a", "job-b", "job-c"]).map((id, index) => ({
            id,
            progressed: index > 0,
          })),
        );
      } finally {
        await checkpoint;
      }
    },
  );

  it("rejects stale authority after yielding before another mutation is invoked", async () => {
    const revoked = new Error("reconciliation revoked");
    let current = true;
    let checkpoint: Promise<void> | undefined;
    const commitGuard = () => {
      if (!current) {
        throw revoked;
      }
    };
    const add = vi.fn(async (input: CronJobCreate, options?: { commitGuard?: () => void }) => {
      options?.commitGuard?.();
      checkpoint ??= nextTurn().then(() => {
        current = false;
      });
      return monitorJob(expectDefined(input.agentId, "heartbeat agent"));
    });
    try {
      await expect(
        reconcile(heartbeatConfig("30m", { a: {}, b: {} }), add, [], commitGuard),
      ).rejects.toBe(revoked);
      expect(add).toHaveBeenCalledTimes(1);
    } finally {
      await checkpoint;
    }
  });

  it("converges one monitor per heartbeat agent and prunes unconfigured ones", async () => {
    const add = vi.fn(async (input: CronJobCreate, _options?: AddOptions) => ({
      job: input,
    }));
    const jobs = [
      monitorJob("stale-agent"),
      {
        ...monitorJob("main"),
        id: "user-job",
        declarationKey: undefined,
        payload: { kind: "systemEvent", text: "user job" },
      } as CronJob,
      // Prefix collision without a heartbeat payload must never be pruned.
      {
        ...monitorJob("collider"),
        id: "prefix-collider",
        payload: { kind: "systemEvent", text: "not a monitor" },
      } as CronJob,
    ];
    const remove = await reconcile(
      {
        agents: {
          defaults: { heartbeat: { every: "15m" } },
          entries: { main: {}, ops: {} },
        },
      },
      add,
      jobs,
    );

    const declarationKeys = add.mock.calls.map(([input]) => input.declarationKey);
    expect(declarationKeys.toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual([
      "heartbeat:main",
      "heartbeat:ops",
    ]);
    for (const [input, opts] of add.mock.calls) {
      expect(input.payload).toEqual({ kind: "heartbeat" });
      expect(input).toMatchObject({
        schedule: { kind: "every", everyMs: 15 * 60_000 },
        sessionTarget: "main",
        enabled: true,
      });
      if (input.schedule.kind !== "every") {
        throw new Error("expected heartbeat interval");
      }
      // Deterministic phase anchor spreads multi-agent beats inside the interval.
      expect(input.schedule.anchorMs).toBeGreaterThanOrEqual(0);
      expect(input.schedule.anchorMs).toBeLessThan(15 * 60_000);
      const matches = expectDefined(opts, "system-owned add options").matchesExisting;
      const agentId = expectDefined(input.agentId, "heartbeat agent");
      expect(
        [
          monitorJob(agentId),
          monitorJob("another-agent"),
          {
            ...monitorJob(agentId),
            payload: { kind: "systemEvent", text: "user" },
          } as CronJob,
        ].map((job) => matches?.(job)),
      ).toEqual([true, false, false]);
    }
    expect(remove).toHaveBeenCalledExactlyOnceWith("job-stale-agent", { systemOwned: true });
  });

  it("keeps a stable disabled monitor when heartbeat cadence is disabled", async () => {
    const add = vi.fn(async (_input: { declarationKey?: string }, _options?: AddOptions) => ({}));
    const remove = await reconcile({ agents: { defaults: { heartbeat: { every: "0m" } } } }, add, [
      monitorJob("main"),
    ]);

    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        declarationKey: "heartbeat:main",
        enabled: false,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: expect.any(Number) },
      }),
    );
    expect(remove).not.toHaveBeenCalled();
  });
});
