import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import * as cronStore from "../cron/service/store.js";
import { CronStreamExecApprovalRequiredError } from "../cron/stream-exec-authority.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import {
  addSystemEventJob,
  createCronConfig,
  createWatchedRun,
  loadCronService,
  mockCronSupervisor,
  resetGatewayCronMocks,
} from "./server-cron.test-support.js";
import { cronHandlers } from "./server-methods/cron.js";

function createStreamService(label: string) {
  const cfg = createCronConfig(label);
  cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
  const state = loadCronService(cfg);
  return Object.assign(state, {
    cfg,
    async [Symbol.asyncDispose]() {
      await state.stopStreamWatchers?.();
      state.cron.stop();
    },
  });
}

async function addSource(state: ReturnType<typeof createStreamService>, name: string) {
  const added = await addSystemEventJob(state, name, "event", {
    schedule: { kind: "stream", command: ["source"] },
    sessionTarget: "main",
  });
  return "job" in added ? added.job : added;
}

describe("buildGatewayCronService stream lifecycle", () => {
  beforeEach(resetGatewayCronMocks);

  it("keeps a stream source running when a conditional or invalid update is rejected", async () => {
    const watched = createWatchedRun();
    const { cancel, detachOutput } = watched;
    const { spawn } = mockCronSupervisor(watched);
    await using state = createStreamService("server-cron-stream-rejected-update");

    const streamJob = await addSource(state, "stream source");
    expect(streamJob.state.streamStatus).toBe("running");
    const sourceIdentity = streamJob.state.streamSourceIdentity;
    await expect(
      state.cron.updateWithPrecondition(streamJob.id, { enabled: false }, () => {
        throw new Error("revision mismatch");
      }),
    ).rejects.toThrow("revision mismatch");
    await expect(
      state.cron.update(streamJob.id, {
        schedule: { kind: "stream", command: [] },
      }),
    ).rejects.toThrow("non-empty command argv array");
    await state.cron.update(streamJob.id, {
      schedule: { kind: "stream", command: ["source"] },
    });

    expect(spawn).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(detachOutput).not.toHaveBeenCalled();
    expect(state.cron.getJob(streamJob.id)?.enabled).toBe(true);
    expect(state.cron.getJob(streamJob.id)?.state.streamSourceIdentity).toBe(sourceIdentity);
    const stopped = await state.cron.update(streamJob.id, { enabled: false });
    expect(stopped).toMatchObject({ enabled: false, state: { streamStatus: "stopped" } });
  });

  it("keeps the saved definition when another edit commits during source startup", async () => {
    const watched = createWatchedRun();
    const { spawn } = mockCronSupervisor(watched);
    const starting = createDeferred();
    const releaseStart = createDeferred();
    spawn.mockImplementationOnce(async () => {
      starting.resolve();
      await releaseStart.promise;
      return { ...watched, runId: "held-start" };
    });
    const state = createStreamService("server-cron-stream-observation-race");
    const adding = addSystemEventJob(state, "original name", "event", {
      id: "observed-source",
      schedule: { kind: "stream", command: ["source"] },
      sessionTarget: "main",
    });
    let updating: ReturnType<typeof state.cron.update> | undefined;
    try {
      await starting.promise;
      updating = state.cron.update("observed-source", { name: "later name" });
      // The read joins the mutation lock, while its post-commit watcher route
      // still waits behind the first source startup.
      expect(await state.cron.readJob("observed-source")).toMatchObject({ name: "later name" });
      releaseStart.resolve();
      const added = await adding;
      const saved = "job" in added ? added.job : added;
      expect(saved.name).toBe("original name");
      expect(saved.state.streamStatus).toBeUndefined();
      expect(await updating).toMatchObject({
        name: "later name",
        state: { streamStatus: "running" },
      });
    } finally {
      releaseStart.resolve();
      await Promise.allSettled([adding, updating]);
      await state[Symbol.asyncDispose]();
    }
  });

  it("rejects a stale removal before stopping the changed watcher", async () => {
    const watched = createWatchedRun();
    const replacement = createWatchedRun();
    const { spawn } = mockCronSupervisor(watched, replacement);
    await using state = createStreamService("server-cron-stream-stale-removal");
    const context = createDirectChatContext({
      cron: state.cron,
      getRuntimeConfig: () => state.cfg,
    });
    const remove = expectDefined(cronHandlers["cron.remove"], "registered cron.remove handler");
    const respond = vi.fn();
    const selected = await addSource(state, "selected watcher");
    const expectedConfigRevision = resolveCronJobConfigRevision(selected);
    const changed = await state.cron.update(selected.id, { name: "changed after selection" });
    const params = { id: selected.id, expectedConfigRevision };
    await remove({
      req: { type: "req", id: "stale-remove", method: "cron.remove", params },
      params,
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        details: {
          code: "CRON_JOB_CHANGED",
          expectedConfigRevision,
          actualConfigRevision: resolveCronJobConfigRevision(changed),
        },
      }),
    );
    expect(watched.cancel).not.toHaveBeenCalled();
    expect(watched.detachOutput).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    const current = expectDefined(await state.cron.readJob(selected.id), "changed watcher remains");
    expect(current).toMatchObject({
      name: "changed after selection",
      state: {
        streamSourceIdentity: selected.state.streamSourceIdentity,
        streamStatus: "running",
      },
    });

    const currentParams = {
      id: current.id,
      expectedConfigRevision: resolveCronJobConfigRevision(current),
    };
    respond.mockClear();
    await remove({
      req: { type: "req", id: "current-remove", method: "cron.remove", params: currentParams },
      params: currentParams,
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ removed: true }),
      undefined,
    );
    expect(watched.cancel).toHaveBeenCalledWith("manual-cancel");
    expect(state.cron.getJob(current.id)).toBeUndefined();
  });

  it("does not interrupt the existing source while its replacement requires consent", async () => {
    const watched = createWatchedRun();
    const { spawn } = mockCronSupervisor(watched);
    await using state = createStreamService("server-cron-stream-consent");
    const original = await addSource(state, "current source");
    await expect(
      state.cron.update(
        original.id,
        {
          schedule: { kind: "stream", command: ["replacement"] },
        },
        {
          execPolicy: {
            kind: "resolved",
            assertCurrent: () => {
              throw new CronStreamExecApprovalRequiredError("policy", "full", "always");
            },
          },
        },
      ),
    ).rejects.toThrow(CronStreamExecApprovalRequiredError);
    expect(watched.cancel).not.toHaveBeenCalled();
    expect(watched.detachOutput).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    expect(await state.cron.readJob(original.id)).toMatchObject({
      schedule: original.schedule,
      state: {
        streamSourceIdentity: original.state.streamSourceIdentity,
        streamStatus: "running",
      },
    });
  });

  it("discards a stale reconcile list snapshot that raced a direct mutation route", async () => {
    const watched = createWatchedRun();
    const { cancel, detachOutput } = watched;
    const { spawn } = mockCronSupervisor(watched);
    const state = createStreamService("server-cron-stream-stale-snapshot");

    try {
      // Gate reconcile's first list call: capture the pre-add (empty) snapshot,
      // hold it while the add's direct route starts the owner, then release the
      // stale snapshot. The revision fence must re-list instead of stopping the
      // freshly started owner as "removed".
      const originalList = state.cron.list.bind(state.cron);
      const { promise: staleListGate, resolve: releaseStaleList } = createDeferred();
      let armed = true;
      state.cron.list = async (opts?: Parameters<typeof originalList>[0]) => {
        if (!armed) {
          return await originalList(opts);
        }
        armed = false;
        const snapshot = await originalList(opts);
        await staleListGate;
        return snapshot;
      };

      const reconciling = state.reconcileStreamWatchers?.();
      const streamJob = await addSource(state, "stale snapshot stream source");
      const sourceIdentity = streamJob.state.streamSourceIdentity;
      expect(spawn).toHaveBeenCalledOnce();
      releaseStaleList();
      await reconciling;

      expect(cancel).not.toHaveBeenCalled();
      expect(detachOutput).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledOnce();
      expect(state.cron.getJob(streamJob.id)?.state.streamSourceIdentity).toBe(sourceIdentity);
    } finally {
      await state[Symbol.asyncDispose]();
      vi.unstubAllEnvs();
    }
  });

  it.each(["running", "cleanup pending"] as const)(
    "preserves an explicit terminal failure from %s until authorized recovery",
    async (initialState) => {
      const watched = createWatchedRun();
      const replacement = createWatchedRun();
      const { spawn } = mockCronSupervisor(watched, replacement);
      const state = createStreamService(`server-cron-stream-terminal-${initialState}`);

      try {
        const streamJob = await addSource(state, "terminal stream source");
        if (initialState === "cleanup pending") {
          watched.waitForExtinction.mockRejectedValue(new Error("cleanup is unconfirmed"));
          await state.cron.update(streamJob.id, { enabled: false });
        }
        await state.cron.update(streamJob.id, {
          state: { streamRestartExhausted: true, streamError: "source exhausted its restarts" },
        });
        expect((await state.cron.readJob(streamJob.id))?.state.streamRestartExhausted).toBe(true);

        watched.waitForExtinction.mockResolvedValue(undefined);
        await state.cron.update(streamJob.id, { name: "after cleanup" });
        await state.reconcileStreamWatchers?.();
        expect((await state.cron.readJob(streamJob.id))?.state.streamRestartExhausted).toBe(true);
        expect(watched.cancel).toHaveBeenCalledWith("manual-cancel");
        expect(spawn).toHaveBeenCalledOnce();

        await state.cron.update(streamJob.id, { enabled: true });
        expect((await state.cron.readJob(streamJob.id))?.state).toMatchObject({
          streamStatus: "running",
        });
        expect(
          (await state.cron.readJob(streamJob.id))?.state.streamRestartExhausted,
        ).toBeUndefined();
        expect(spawn).toHaveBeenCalledTimes(2);

        await state.cron.update(streamJob.id, {
          state: {
            streamRestartExhausted: true,
            streamError: "replacement exhausted its restarts",
          },
        });
        await state.stopStreamWatchers?.();
        expect((await state.cron.readJob(streamJob.id))?.state).toMatchObject({
          streamStatus: "error",
          streamRestartExhausted: true,
          streamError: "replacement exhausted its restarts",
        });
      } finally {
        watched.waitForExtinction.mockResolvedValue(undefined);
        await state[Symbol.asyncDispose]();
      }
    },
  );

  it.each(["enable", "clear exhaustion"] as const)(
    "keeps %s recovery in effect after retryable cleanup succeeds",
    async (recovery) => {
      const watched = createWatchedRun();
      const { spawn } = mockCronSupervisor(watched);
      const state = createStreamService(`server-cron-stream-recovery-${recovery}`);

      try {
        const streamJob = await addSource(state, "recovering source");
        watched.waitForExtinction.mockRejectedValue(new Error("cleanup is unconfirmed"));
        await state.cron.update(streamJob.id, {
          state: { streamRestartExhausted: true, streamError: "source exhausted its restarts" },
        });
        expect((await state.cron.readJob(streamJob.id))?.state.streamRestartExhausted).toBe(true);

        await state.cron.update(
          streamJob.id,
          recovery === "enable" ? { enabled: true } : { state: { streamRestartExhausted: false } },
        );
        watched.waitForExtinction.mockResolvedValue(undefined);
        await state.stopStreamWatchers?.();
        const stopped = expectDefined(await state.cron.readJob(streamJob.id), "retained source");
        expect(stopped.state.streamStatus).toBe("stopped");
        expect(stopped.state.streamRestartExhausted).toBeUndefined();
        expect(stopped.state.streamError).toBeUndefined();
        expect(spawn).toHaveBeenCalledOnce();
      } finally {
        watched.waitForExtinction.mockResolvedValue(undefined);
        await state[Symbol.asyncDispose]();
      }
    },
  );

  it("drains stream teardown once when stop and stopAndDrain overlap", async () => {
    const watched = createWatchedRun();
    const { cancel, waitForExtinction } = watched;
    mockCronSupervisor(watched);
    await using state = createStreamService("server-cron-stream-single-drain");

    await addSource(state, "single drain stream source");
    // cron.stop launches the asynchronous teardown; stopAndDrain must await
    // that same drain instead of queueing every owner a second shutdown stop.
    state.cron.stop();
    await state.cron.stopAndDrain?.();
    expect(cancel).toHaveBeenCalledWith("manual-cancel");
    expect(waitForExtinction).toHaveBeenCalledOnce();
  });

  it("retries stream teardown after a prior drain failure", async () => {
    const watched = createWatchedRun();
    const { cancel, waitForExtinction } = watched;
    waitForExtinction.mockRejectedValue(new Error("stream process extinction is unconfirmed"));
    mockCronSupervisor(watched);
    const state = createStreamService("server-cron-stream-retry-drain");

    try {
      await addSource(state, "retry drain stream source");

      await expect(state.cron.stopAndDrain?.()).rejects.toThrow(
        "stream process extinction is unconfirmed",
      );
      waitForExtinction.mockResolvedValue(undefined);
      await expect(state.cron.stopAndDrain?.()).resolves.toBeUndefined();
      expect(cancel).toHaveBeenCalledWith("manual-cancel");
      expect(waitForExtinction).toHaveBeenCalledTimes(2);
    } finally {
      waitForExtinction.mockResolvedValue(undefined);
      await state[Symbol.asyncDispose]();
    }
  });

  it("reports a committed stream update as successful when source teardown fails", async () => {
    vi.useFakeTimers();
    const watched = createWatchedRun();
    const { cancel, waitForExtinction } = watched;
    waitForExtinction.mockRejectedValue(new Error("stream process extinction is unconfirmed"));
    mockCronSupervisor(watched);
    const state = createStreamService("server-cron-stream-update-teardown-failure");
    const commitEntered = createDeferred();
    const commitReleased = createDeferred();
    const persist = cronStore.persistCronJobMutation;
    const mutation = vi
      .spyOn(cronStore, "persistCronJobMutation")
      .mockImplementation(async (params) => {
        if (params.method === "cron.update") {
          commitEntered.resolve();
          await commitReleased.promise;
        }
        await persist(params);
      });
    let updatePromise: ReturnType<typeof state.cron.update> | undefined;

    try {
      const streamJob = await addSource(state, "stubborn update stream source");
      // The durable disable commits before teardown settles; an extinction failure
      // must not surface as a failed update after the mutation persisted.
      updatePromise = state.cron.update(streamJob.id, { enabled: false });
      await commitEntered.promise;
      // Even while commit is delayed, no source interruption is permitted.
      expect(cancel).not.toHaveBeenCalled();
      commitReleased.resolve();
      const updated = await updatePromise;
      expect(updated).toMatchObject({
        enabled: false,
        state: {
          streamStatus: "error",
          streamError: expect.stringContaining("stream process extinction is unconfirmed"),
        },
      });
      expect(await state.cron.readJob(streamJob.id)).toMatchObject({
        enabled: false,
        state: {
          streamStatus: "error",
          streamError: expect.stringContaining("stream process extinction is unconfirmed"),
          streamRestartExhausted: true,
        },
      });
      expect(cancel).toHaveBeenCalledWith("manual-cancel");
    } finally {
      commitReleased.resolve();
      await updatePromise?.catch(() => undefined);
      mutation.mockRestore();
      waitForExtinction.mockResolvedValue(undefined);
      await state[Symbol.asyncDispose]();
      vi.useRealTimers();
    }
  });

  it.each(["rejected", "uncertain"] as const)(
    "retains %s stream removal and clears its error only after confirmed cleanup",
    async (outcome) => {
      const watched = createWatchedRun();
      const { cancel, detachOutput, waitForExtinction } = watched;
      if (outcome === "uncertain") {
        waitForExtinction.mockResolvedValue({ status: "uncertain", reason: "job-unavailable" });
      } else {
        waitForExtinction.mockRejectedValue(new Error("stream source extinction is unconfirmed"));
      }
      mockCronSupervisor(watched);
      const state = createStreamService("server-cron-stream-remove-failure");

      try {
        const streamJob = await addSource(state, "stubborn stream source");
        await expect(state.cron.remove(streamJob.id)).rejects.toThrow(
          "stream source extinction is unconfirmed",
        );
        expect(waitForExtinction).toHaveBeenCalledTimes(2);
        expect(cancel).toHaveBeenCalledWith("manual-cancel");
        expect(detachOutput).toHaveBeenCalled();
        expect(state.cron.getJob(streamJob.id)).toMatchObject({
          enabled: true,
          state: {
            streamStatus: "error",
            streamError: expect.stringContaining("stream source failed to stop"),
            streamRestartExhausted: true,
          },
        });

        waitForExtinction.mockResolvedValue(undefined);
        await state.stopStreamWatchers?.();
        expect(state.cron.getJob(streamJob.id)).toMatchObject({
          state: { streamStatus: "stopped" },
        });
        expect(state.cron.getJob(streamJob.id)?.state.streamError).toBeUndefined();
        expect(state.cron.getJob(streamJob.id)?.state.streamRestartExhausted).toBeUndefined();
      } finally {
        waitForExtinction.mockResolvedValue(undefined);
        await state[Symbol.asyncDispose]();
      }
    },
  );
});
