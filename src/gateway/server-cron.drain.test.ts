import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCronJobActive } from "../cron/active-jobs.js";
import { waitForActiveCronTaskRuns } from "../cron/service/active-run-cancellation.js";
import * as cronStore from "../cron/store.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";

const { cancelAllMock, getRuntimeConfigMock, stopAllMock } = vi.hoisted(() => ({
  cancelAllMock: vi.fn<() => Promise<void>>(),
  getRuntimeConfigMock: vi.fn(),
  stopAllMock: vi.fn<() => Promise<void>>(),
}));

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("./cron-exit-watchers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cron-exit-watchers.js")>()),
  createCronExitWatchers: () => ({
    reconcile: vi.fn(),
    cancel: vi.fn(),
    cancelAll: cancelAllMock,
    activeJobIds: () => [],
    updateHandlers: vi.fn(),
  }),
}));

vi.mock("./cron-stream-watchers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cron-stream-watchers.js")>()),
  createCronStreamWatchers: () => ({
    reconcile: vi.fn(async () => {}),
    resume: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    stopAll: stopAllMock,
    activeJobIds: () => [],
    inspect: () => undefined,
  }),
}));

import { sessionChanges } from "../sessions/session-row-changes.js";
import { buildGatewayCronService } from "./server-cron.js";
import { sessionHasAutomation } from "./session-automation-index.js";

type StartedGatewayCron = {
  clock: ReturnType<typeof createGatewaySchedulerClock>;
  state: ReturnType<typeof buildGatewayCronService>;
  cfg: OpenClawConfig;
  stateDir: string;
};

async function startGatewayCron(
  label: string,
  enabled = true,
  broadcast: Parameters<typeof buildGatewayCronService>[0]["broadcast"] = () => {},
): Promise<StartedGatewayCron> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), `openclaw-cron-drain-${label}-`));
  const cfg: OpenClawConfig = {
    session: { mainKey: "main" },
    cron: { enabled, triggers: { enabled: true } },
  };
  getRuntimeConfigMock.mockReturnValue(cfg);
  const clock = createGatewaySchedulerClock(Date.now());
  const state = buildGatewayCronService({
    scheduler: createTestGatewayScheduler(clock.clock),
    cfg,
    deps: {} as CliDeps,
    broadcast,
    env: { ...process.env, OPENCLAW_SKIP_CRON: "0", OPENCLAW_STATE_DIR: stateDir },
  });
  await state.cron.start();
  await state.cron.add({
    name: `${label} stream source`,
    enabled: true,
    schedule: { kind: "stream", command: ["source"] },
    payload: { kind: "systemEvent", text: "event" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
  });
  return { state, cfg, stateDir, clock };
}

async function cleanGatewayCron({ state, stateDir }: StartedGatewayCron): Promise<void> {
  try {
    await state.cron.stopAndDrain?.();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

describe("gateway cron stop-and-drain automation ownership", () => {
  beforeEach(() => {
    cancelAllMock.mockReset();
    cancelAllMock.mockResolvedValue(undefined);
    getRuntimeConfigMock.mockReset();
    stopAllMock.mockReset();
  });

  it.each(["success", "exit-watcher-failure"] as const)(
    "waits for durable manual-run finalization after its payload has settled (%s)",
    async (stopResult) => {
      stopAllMock.mockResolvedValue(undefined);
      const finalizationEntered = createDeferred();
      const releaseFinalization = createDeferred();
      const stopError = new Error("exit watcher drain failed");
      let jobId: string | undefined;
      let holdFinalization = false;
      const original = await startGatewayCron("finalization", false, (event, payload) => {
        const change = asNonArrayRecord(payload);
        if (event === "cron" && change.jobId === jobId && change.action === "started") {
          holdFinalization = true;
        }
      });
      const realLoad = cronStore.loadCronJobsStoreWithConfigJobs;
      const load = vi
        .spyOn(cronStore, "loadCronJobsStoreWithConfigJobs")
        .mockImplementation(async (storePath) => {
          const snapshot = await realLoad(storePath);
          if (holdFinalization && storePath === original.state.storePath) {
            holdFinalization = false;
            finalizationEntered.resolve();
            await releaseFinalization.promise;
          }
          return snapshot;
        });
      let run: Promise<unknown> | undefined;
      let drain: Promise<void> | undefined;
      try {
        const job = await original.state.cron.add({
          name: "finalization drain",
          enabled: true,
          schedule: { kind: "at", at: new Date(original.clock.clock.now() - 1_000).toISOString() },
          payload: { kind: "command", argv: [process.execPath, "-e", "process.exit(0)"] },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          delivery: { mode: "none" },
          deleteAfterRun: false,
        });
        jobId = job.id;
        run = original.state.cron.run(job.id, "force");
        await finalizationEntered.promise;
        expect(await waitForActiveCronTaskRuns(0)).toEqual({ drained: true, active: 0 });
        expect(isCronJobActive(job.id)).toBe(true);
        if (stopResult === "exit-watcher-failure") {
          cancelAllMock.mockRejectedValueOnce(stopError);
        }
        let outcome: { ok: true } | { ok: false; error: unknown } | undefined;
        drain = original.state.cron.stopAndDrain?.().then(
          () => {
            outcome = { ok: true };
          },
          (error: unknown) => {
            outcome = { ok: false, error };
          },
        );
        expect(drain).toBeDefined();
        const pending = (await realLoad(original.state.storePath)).store.jobs.find(
          (entry) => entry.id === job.id,
        );
        expect(pending?.state.runningAtMs).toEqual(expect.any(Number));
        expect(pending?.state.lastRunStatus).toBeUndefined();
        expect(outcome).toBeUndefined();

        releaseFinalization.resolve();
        await expect(run).resolves.toMatchObject({ ok: true, ran: true });
        await drain;
        expect(outcome).toEqual(
          stopResult === "success" ? { ok: true } : { ok: false, error: stopError },
        );
        const completed = (await realLoad(original.state.storePath)).store.jobs.find(
          (entry) => entry.id === job.id,
        );
        expect(completed).toMatchObject({ enabled: false, state: { lastRunStatus: "ok" } });
        expect(completed?.state.runningAtMs).toBeUndefined();
        expect(isCronJobActive(job.id)).toBe(false);
      } finally {
        releaseFinalization.resolve();
        await Promise.allSettled([run, drain]);
        load.mockRestore();
        if (stopResult === "exit-watcher-failure" && drain) {
          await expect(cleanGatewayCron(original)).rejects.toBe(stopError);
        } else {
          await cleanGatewayCron(original);
        }
      }
    },
  );

  it.each([false, true])(
    "publishes a one-shot binding removal after completion (delete=%s)",
    async (deleteAfterRun) => {
      stopAllMock.mockResolvedValue(undefined);
      const original = await startGatewayCron(`one-shot-${deleteAfterRun}`, false);
      const changed = vi.fn();
      let stop = () => {};
      try {
        const job = await original.state.cron.add({
          name: "one-shot binding",
          enabled: true,
          schedule: { kind: "at", at: new Date(original.clock.clock.now() - 1_000).toISOString() },
          payload: { kind: "command", argv: [process.execPath, "-e", "process.exit(0)"] },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          delivery: { mode: "none" },
          deleteAfterRun,
        });
        const key = `agent:main:cron:${job.id}`;
        expect(sessionHasAutomation(key, original.cfg)).toBe(true);
        stop = sessionChanges.subscribe(changed);
        expect(await original.state.cron.run(job.id, "force")).toMatchObject({
          ok: true,
          ran: true,
        });
        expect(original.state.cron.getJob(job.id)?.state.lastError).toBeUndefined();
        expect(sessionHasAutomation(key, original.cfg)).toBe(false);
        const automation = changed.mock.calls
          .map(([change]) => change)
          .filter((change) => change.scope === "automation");
        expect(automation).toEqual([{ sessionKey: key, scope: "automation" }]);
        expect(original.state.cron.getJob(job.id)?.enabled).toBe(
          deleteAfterRun ? undefined : false,
        );
      } finally {
        stop();
        await cleanGatewayCron(original);
      }
    },
  );

  it("waits for cancelled exit watchers to settle before completing the drain", async () => {
    const exitWatcherDrain = createDeferred();
    cancelAllMock.mockReturnValue(exitWatcherDrain.promise);
    stopAllMock.mockResolvedValue(undefined);
    const original = await startGatewayCron("exit-watcher");

    try {
      let drained = false;
      const drain = original.state.cron.stopAndDrain?.().then(() => {
        drained = true;
      });
      if (!drain) {
        throw new Error("expected cron stop-and-drain");
      }

      await vi.waitFor(() => expect(cancelAllMock).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(drained).toBe(false);

      exitWatcherDrain.resolve(undefined);
      await drain;
      expect(drained).toBe(true);
    } finally {
      exitWatcherDrain.resolve(undefined);
      await cleanGatewayCron(original);
    }
  });

  it("waits for prior exit watchers to settle before restarting the scheduler", async () => {
    const exitWatcherDrain = createDeferred();
    cancelAllMock.mockReturnValue(exitWatcherDrain.promise);
    stopAllMock.mockResolvedValue(undefined);
    const original = await startGatewayCron("exit-watcher-restart");

    try {
      original.state.cron.stop();
      let restarted = false;
      const restart = original.state.cron.start().then(() => {
        restarted = true;
      });

      await vi.waitFor(() => expect(cancelAllMock).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(restarted).toBe(false);

      exitWatcherDrain.resolve(undefined);
      await restart;
      expect(restarted).toBe(true);
    } finally {
      exitWatcherDrain.resolve(undefined);
      await cleanGatewayCron(original);
    }
  });

  it("does not reopen the scheduler when a later stop wins a pending restart", async () => {
    const exitWatcherDrain = createDeferred();
    cancelAllMock.mockReturnValue(exitWatcherDrain.promise);
    stopAllMock.mockResolvedValue(undefined);
    const original = await startGatewayCron("exit-watcher-restart-cancelled");

    try {
      original.state.cron.stop();
      const restart = original.state.cron.start();
      await vi.waitFor(() => expect(cancelAllMock).toHaveBeenCalledOnce());

      original.state.cron.stop();
      exitWatcherDrain.resolve(undefined);
      await restart;

      expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(false);
    } finally {
      exitWatcherDrain.resolve(undefined);
      await cleanGatewayCron(original);
    }
  });

  it("unregisters a stopped scheduler when stream draining fails and permits retry", async () => {
    stopAllMock.mockRejectedValueOnce(new Error("stream drain failed"));
    stopAllMock.mockResolvedValue(undefined);
    const original = await startGatewayCron("failed");

    try {
      expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(true);

      await expect(original.state.cron.stopAndDrain?.()).rejects.toThrow("stream drain failed");

      expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(false);
      await expect(original.state.cron.stopAndDrain?.()).resolves.toBeUndefined();
      expect(stopAllMock).toHaveBeenCalledTimes(2);
      expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(false);
    } finally {
      await cleanGatewayCron(original);
    }
  });

  it("does not unregister a replacement scheduler when a stale drain fails", async () => {
    const pendingDrain = createDeferred();
    stopAllMock.mockImplementationOnce(() => pendingDrain.promise);
    stopAllMock.mockResolvedValue(undefined);
    const original = await startGatewayCron("stale");
    let replacement: StartedGatewayCron | undefined;

    try {
      expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(true);

      const staleDrain = original.state.cron.stopAndDrain?.();
      if (!staleDrain) {
        throw new Error("expected cron stop-and-drain");
      }

      replacement = await startGatewayCron("replacement");
      expect(sessionHasAutomation("agent:main:main", replacement.cfg)).toBe(true);

      const failedDrain = expect(staleDrain).rejects.toThrow("stream drain failed");
      pendingDrain.reject(new Error("stream drain failed"));
      await failedDrain;

      expect(sessionHasAutomation("agent:main:main", replacement.cfg)).toBe(true);
      await expect(original.state.cron.stopAndDrain?.()).resolves.toBeUndefined();
      expect(sessionHasAutomation("agent:main:main", replacement.cfg)).toBe(true);
    } finally {
      try {
        if (replacement) {
          await cleanGatewayCron(replacement);
        }
      } finally {
        await cleanGatewayCron(original);
      }
    }
  });
});
