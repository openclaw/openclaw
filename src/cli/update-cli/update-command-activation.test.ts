import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readRestartSentinelReadOnly } from "../../infra/restart-sentinel.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import * as ledger from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import * as state from "../../state/openclaw-state-db.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { useExecutorFixture } from "./update-command-executor.test-support.js";
import {
  reportUpdateCommandPendingRecovery,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";

const fixture = useExecutorFixture("update-activation-", { splitRoots: true });
function useActivationClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
}
afterEach(async () => {
  try {
    await state.closeOpenClawStateDatabaseAsync();
  } finally {
    vi.useRealTimers();
    state.closeOpenClawStateDatabaseForTest();
  }
});

it.each([false, true])("keeps custody after timeout (retained: %s)", async (retained) => {
  const { root, serviceRoot: retainedRoot } = fixture();
  const serviceRoot = retained ? retainedRoot : undefined;
  const roots = serviceRoot ? [root, serviceRoot] : [root];
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: ledger.createUpdateRun({ trigger: "cli" }, { env }).runId,
    env,
  };
  const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  const onResult = vi.fn();
  const entered = createDeferred();
  const release = createDeferred();
  let childWork: Promise<unknown> | undefined;
  let assertCurrent: (() => void) | undefined;
  const budget = 10 * 60_000;
  useActivationClock();
  const running = withUpdateCommandTerminalResult(
    async (registerRun) => {
      registerRun(run);
      await withUpdateCommandExecutor(run.runId, async (executor) => {
        const fence = await executor.enter(root, { serviceRoot, activationTimeoutMs: budget });
        run.executorFence = fence;
        assertCurrent = fence.assertCurrent;
        ledger.recordUpdateRunPhase(run.runId, "activating", undefined, { env });
        childWork = withUpdateCommandExecutorChild(fence, root, async () => {
          entered.resolve();
          await release.promise;
        });
        void childWork.catch(() => {});
        await entered.promise;
      });
    },
    { json: true, onResult },
  ).catch((error: unknown) => error);
  try {
    await entered.promise;
    const before = ledger.getUpdateRun(run.runId, { env });
    await vi.advanceTimersByTimeAsync(budget - 1);
    expect(ledger.getUpdateRun(run.runId, { env })?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(budget + 1);
    const outcome = await running;
    expect(outcome).toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
    expect(outcome).toMatchObject({ result: { reason: "update-activation-timeout" } });
    expect(assertCurrent).toThrow("activation");
    // Detached reporting must leave custody/history unsettled until the child exits.
    expect(ledger.getUpdateRun(run.runId, { env })).toEqual(before);
    await expect(
      reportUpdateCommandPendingRecovery(outcome as UpdateCommandPendingRecoveryFailure, {
        json: true,
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "update-activation-timeout", status: "error" }),
    );
    expect(onResult).not.toHaveBeenCalled();
    expect(ledger.getUpdateRun(run.runId, { env })).toEqual(before);
    expect(await readRestartSentinelReadOnly(env)).toBeNull();
    expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "update-reports"))).toBe(false);
    for (const ownedRoot of roots) {
      expect(createManagedHandoffLeaseStore().read(ownedRoot)).toMatchObject({
        kind: "current",
        lease: { version: 4 },
      });
      await expect(
        withUpdateCommandExecutor(
          ownedRoot === root ? run.runId : "competing-retained-owner",
          (other) => other.enter(ownedRoot),
        ),
      ).rejects.toThrow("Another update executor");
    }
  } finally {
    release.resolve();
    await childWork?.catch(() => {});
    await running;
    await setImmediate();
  }
  for (const ownedRoot of roots) {
    expect(createManagedHandoffLeaseStore().read(ownedRoot)).toEqual({ kind: "absent" });
  }
  // Retire the sentinel reader's idle timer before judging executor cleanup.
  expect(vi.getTimerCount()).toBe(1);
  await state.closeOpenClawStateDatabaseAsync();
  expect(vi.getTimerCount()).toBe(0);
});

it("checks expiry after synchronous work without dispatching timers", async () => {
  const { root } = fixture();
  useActivationClock();
  const work = withUpdateCommandExecutor("clock-probe", async (executor) => {
    await executor.enter(root, { activationTimeoutMs: 60_000 });
    // Move the clock without dispatching timers, as a blocking native probe can.
    vi.setSystemTime(Date.now() + 60_001);
    return "completed";
  });
  await expect(work).rejects.toMatchObject({ reason: "update-activation-timeout" });
  expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([undefined, 48 * 60 * 60_000])(
  "honors measured activation budgets (%s)",
  async (callerTimeoutMs) => {
    const { resolveUpdateFinalizationTimeoutMs } =
      await import("../../infra/update-finalization-budget.js");
    const { root } = fixture();
    const database = path.join(root, "agent.sqlite");
    const descriptor = fs.openSync(database, "w");
    fs.ftruncateSync(descriptor, 2 * 1024 ** 3);
    fs.closeSync(descriptor);
    const budget = await resolveUpdateFinalizationTimeoutMs(callerTimeoutMs, {
      databases: [{ path: database }],
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    });
    const legacyBudget = Math.max(30 * 60_000, (callerTimeoutMs ?? 0) * 6);
    useActivationClock();
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

it("keeps preflight custody through activation expiry", async () => {
  const { root, serviceRoot } = fixture();
  useActivationClock();
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
