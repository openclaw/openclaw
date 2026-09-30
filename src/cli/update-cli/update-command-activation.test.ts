import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  const temporary = dirs.make("update-activation-tmp-");
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
});
afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "records an activation timeout while settlement remains pending (retained A: %s)",
  async (retained) => {
    const root = fs.realpathSync(dirs.make("update-activation-"));
    const serviceRoot = retained
      ? fs.realpathSync(dirs.make("update-retained-activation-"))
      : undefined;
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const entered = createDeferred();
    const release = createDeferred();
    let childWork: Promise<unknown> | undefined;
    let outcome: unknown;
    let assertCurrent: (() => void) | undefined;
    const budget = 10 * 60_000;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const running = withUpdateCommandTerminalResult(
      async (registerRun) => {
        registerRun(run);
        await withUpdateCommandExecutor(run.runId, async (executor) => {
          const fence = await executor.enter(root, { serviceRoot, activationTimeoutMs: budget });
          assertCurrent = fence.assertCurrent;
          recordUpdateRunPhase(run.runId, "activating", undefined, { env });
          childWork = withUpdateCommandExecutorChild(fence, root, async () => {
            entered.resolve();
            await release.promise;
          });
          void childWork.catch(() => {});
          await entered.promise;
          // Returning does not settle the admitted child's outstanding work.
        });
      },
      { json: true },
    ).catch((error: unknown) => {
      outcome = error;
    });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(budget - 1);
      expect(getUpdateRun(run.runId, { env })?.status).toBe("running");
      expect(assertCurrent).toBeDefined();
      await vi.advanceTimersByTimeAsync(budget + 1);
      await running;
      expect(outcome).toMatchObject({ result: { reason: "update-activation-timeout" } });
      expect(assertCurrent).toThrow("activation");
      expect(getUpdateRun(run.runId, { env })).toMatchObject({
        phase: "finished",
        status: "failed",
        reason: "update-activation-timeout",
      });
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "update-activation-timeout",
          status: "error",
        }),
      );
      expect(createManagedHandoffLeaseStore().read(root).kind).toBe("current");
      if (serviceRoot) {
        expect(createManagedHandoffLeaseStore().read(serviceRoot).kind).toBe("current");
        await expect(
          withUpdateCommandExecutor("competing-retained-owner", (other) =>
            other.enter(serviceRoot),
          ),
        ).rejects.toThrow("Another update executor");
      }
      await expect(
        withUpdateCommandExecutor(run.runId, (other) => other.enter(root)),
      ).rejects.toThrow("Another update executor");
    } finally {
      release.resolve();
      await childWork?.catch(() => {});
      await running;
    }
  },
);

it.each([false, true])(
  "checks the activation deadline after synchronous work (expired: %s)",
  async (expired) => {
    const root = fs.realpathSync(dirs.make("update-activation-clock-"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const work = withUpdateCommandExecutor("clock-probe", async (executor) => {
      await executor.enter(root, { activationTimeoutMs: 60_000 });
      // Move the clock without dispatching timers, as a blocking native probe can.
      vi.setSystemTime(Date.now() + (expired ? 60_001 : 59_999));
      return "completed";
    });
    if (expired) {
      await expect(work).rejects.toMatchObject({ reason: "update-activation-timeout" });
    } else {
      await expect(work).resolves.toBe("completed");
    }
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([undefined, 48 * 60 * 60_000])(
  "keeps activation alive for measured state and caller allowance %s",
  async (callerTimeoutMs) => {
    const { resolveUpdateFinalizationTimeoutMs } =
      await import("../../infra/update-finalization-budget.js");
    const root = fs.realpathSync(dirs.make("update-activation-size-"));
    const database = path.join(root, "agent.sqlite");
    const descriptor = fs.openSync(database, "w");
    fs.ftruncateSync(descriptor, 2 * 1024 ** 3);
    fs.closeSync(descriptor);
    const budget = await resolveUpdateFinalizationTimeoutMs(callerTimeoutMs, {
      databases: [{ path: database }],
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    });
    const legacyBudget = Math.max(30 * 60_000, (callerTimeoutMs ?? 0) * 6);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await expect(
      withUpdateCommandExecutor("measured-activation", async (executor) => {
        const fence = await executor.enter(root, { activationTimeoutMs: budget });
        vi.setSystemTime(Date.now() + (callerTimeoutMs ?? legacyBudget + 1));
        fence.assertCurrent();
        return "completed";
      }),
    ).resolves.toBe("completed");
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
  },
);

it("preserves retained ownership when preflight starts a measured activation deadline", async () => {
  const root = fs.realpathSync(dirs.make("update-preflight-activation-"));
  const serviceRoot = fs.realpathSync(dirs.make("update-preflight-retained-"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await expect(
    withUpdateCommandExecutor("retained-preflight", async (executor) => {
      const preflight = await executor.enter(root, { preflight: true, serviceRoot });
      vi.setSystemTime(Date.now() + 3_600_000);
      preflight.assertCurrent();
      const activation = await executor.enter(root, { serviceRoot, activationTimeoutMs: 60_000 });
      expect(activation).toBe(preflight);
      expect(createManagedHandoffLeaseStore().read(serviceRoot).kind).toBe("current");
      vi.setSystemTime(Date.now() + 60_001);
      activation.assertCurrent();
    }),
  ).rejects.toMatchObject({ reason: "update-activation-timeout" });
  expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
  expect(createManagedHandoffLeaseStore().read(serviceRoot)).toEqual({ kind: "absent" });
  expect(vi.getTimerCount()).toBe(0);
});
