import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { PluginHostCleanupTimeoutError } from "../plugins/host-hook-cleanup-timeout.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import {
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "../plugins/plugin-lifecycle-lease.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  createRecoveryChannelManager,
  type RecoveryFixtureFactory,
} from "./server-plugin-reload.recovery.test-support.js";
import { createReadinessChecker } from "./server/readiness.js";

export async function verifyLateActiveCallDrainObservation(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  const fixture = await createRecoveryFixture({ abortOnCandidateStart: false });
  const held = fixture.previousRegistry.plugins.map((record) => {
    const instance = getPluginInstance(record);
    assert(instance);
    const release = createDeferredCore();
    const call = instance.run(async () => {
      await release.promise;
      return record.id;
    });
    return { id: record.id, instance, release, call };
  });
  const [first, sibling] = held;
  assert(first && sibling);
  let siblingSettled = false;
  void sibling.call.then(() => {
    siblingSettled = true;
  });
  let reloading: Promise<unknown> | undefined;
  vi.useFakeTimers();
  try {
    reloading = fixture.reload(undefined, [first.id, sibling.id]).catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(fixture.owner.getReloadStatus()).toMatchObject({
        phase: "reloading",
        deadlineAtMs: expect.any(Number),
      }),
    );
    const deadlineAtMs = fixture.owner.getReloadStatus()?.deadlineAtMs;
    assert(deadlineAtMs);
    await vi.advanceTimersByTimeAsync(deadlineAtMs - Date.now());
    expect(await reloading).toMatchObject({
      details: { phase: "drain", committed: false, pluginIds: [first.id, sibling.id] },
      cause: { message: expect.stringContaining("admitted work did not settle within 60s") },
    });
    expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    expect(fixture.owner.getReloadStatus()).toBeUndefined();
    for (const { id, instance } of held) {
      expect(instance.acceptingCalls).toBe(true);
      expect(instance.run(() => id)).toBe(id);
    }

    await vi.advanceTimersByTimeAsync(1_000);
    first.release.resolve();
    await expect(first.call).resolves.toBe(first.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(siblingSettled).toBe(false);
    // A timed-out observation must not close a later plugin after rollback resumed it.
    for (const { id, instance } of held) {
      expect(instance.acceptingCalls).toBe(true);
      expect(instance.run(() => id)).toBe(id);
      expect(instance.disposing).toBe(false);
    }
    expect(fixture.firstStop).not.toHaveBeenCalled();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
    expect(fixture.candidates).toHaveLength(0);
    expect(fixture.rollbackConfigEffects).toHaveBeenCalledOnce();
    expect(fixture.owner.getReloadStatus()).toBeUndefined();
    sibling.release.resolve();
    await expect(sibling.call).resolves.toBe(sibling.id);
  } finally {
    for (const { release } of held) {
      release.resolve();
    }
    await Promise.all(held.map(({ call }) => call));
    await vi.advanceTimersByTimeAsync(10_000);
    await reloading;
    vi.useRealTimers();
  }
}

export async function verifyActiveCallDrainLease(
  createRecoveryFixture: RecoveryFixtureFactory,
  stateDir: string,
  holdMs = 5_000,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const channelStarted = createDeferredCore();
  const effectsPath = path.join(stateDir, "completed-call.txt");
  await fs.writeFile(effectsPath, "");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  let reloadLease: PluginLifecycleLeaseContext | undefined;
  let registrations = 0;
  const disposed: number[] = [];
  const signals: AbortSignal[] = [];
  const fixture = await createRecoveryFixture({
    env,
    abortOnCandidateStart: false,
    assertInvokerOwned: () => {
      assert(reloadLease);
      reloadLease.assertOwned();
    },
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
      api.registerChannel({
        plugin: {
          ...createChannelTestPluginBase({ id: "drain-channel" }),
          gateway: {
            startAccount: async ({ abortSignal }) => {
              signals.push(abortSignal);
              channelStarted.resolve();
              await new Promise<void>((resolve) => {
                abortSignal.addEventListener("abort", () => resolve(), { once: true });
              });
            },
          },
        },
      });
      const generation = ++registrations;
      assert(api.lifecycle.onDispose);
      api.lifecycle.onDispose(() => {
        disposed.push(generation);
      });
      api.registerGatewayMethod("first.call", async ({ params, respond }) => {
        if (params.hold) {
          entered.resolve();
          await release.promise;
          await fs.appendFile(effectsPath, "completed\n");
        }
        respond(true, { generation });
      });
    },
  });
  const manager = createRecoveryChannelManager(fixture);
  fixture.runtime.channelManager = manager;
  await manager.startChannel("drain-channel");
  await channelStarted.promise;
  expect(signals).toHaveLength(1);
  const readiness = createReadinessChecker({
    channelManager: manager,
    startedAt: Date.now(),
    getPluginReloadStatus: fixture.owner.getReloadStatus,
  });
  const record = fixture.previousRegistry.plugins.find((entry) => entry.id === "first");
  assert(record);
  const instance = getPluginInstance(record);
  assert(instance);
  const drainStarted = createDeferredCore();
  const drain = instance.drain.bind(instance);
  const drainObservation = vi.spyOn(instance, "drain").mockImplementation((options) => {
    drainStarted.resolve();
    return drain(options);
  });
  const handler = fixture.previousRegistry.gatewayHandlers["first.call"];
  assert(handler);
  const invoke = (hold: boolean, respond: GatewayRequestHandlerOptions["respond"]) =>
    handler({
      req: { type: "req", id: "active-call-drain", method: "first.call" },
      params: { hold },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as GatewayRequestHandlerOptions["context"],
    });
  const reloadOutcome = createDeferredCore<unknown>();
  const allowNativeCleanup = createDeferredCore();
  const reload = () =>
    withPluginLifecycleLease({ env, waitMs: 0 }, async (lease) => {
      reloadLease = lease;
      try {
        const result = await fixture.reload();
        reloadOutcome.resolve(result);
        return result;
      } catch (error) {
        reloadOutcome.resolve(error);
        throw error;
      } finally {
        // The drain uses simulated time; SQLite lease cleanup must run on real timers.
        await allowNativeCleanup.promise;
      }
    });
  const response = vi.fn();
  let callSettled = false;
  const originalCall = Promise.resolve(invoke(true, response)).then(
    () => {
      callSettled = true;
    },
    (error: unknown) => {
      callSettled = true;
      return error;
    },
  );
  let reloading: Promise<unknown> | undefined;
  let reloadSettled = false;
  try {
    await entered.promise;
    vi.useFakeTimers();
    reloading = reload().then(
      (result) => {
        reloadSettled = true;
        return result;
      },
      (error: unknown) => {
        reloadSettled = true;
        return error;
      },
    );
    await drainStarted.promise;
    expect(fixture.owner.getReloadStatus()).toMatchObject({
      phase: "reloading",
      deadlineAtMs: expect.any(Number),
      reason: expect.stringMatching(/admitted work.*first/),
    });
    const deadlineAtMs = fixture.owner.getReloadStatus()?.deadlineAtMs;
    assert(deadlineAtMs);
    await expect(
      withPluginLifecycleLease({ env, waitMs: 0 }, async () => "competing owner"),
    ).rejects.toMatchObject({ outcome: { kind: "held" } });
    await vi.advanceTimersByTimeAsync(
      deadlineAtMs - Date.now() - 60_000 + Math.min(holdMs, 59_999),
    );
    expect(reloadSettled).toBe(false);
    expect(callSettled).toBe(false);
    expect(readiness()).toMatchObject({
      ready: false,
      failing: ["plugin-reload"],
      pluginReload: {
        phase: "reloading",
        deadlineAtMs,
        reason: expect.stringMatching(/admitted work.*first/),
      },
    });
    expect(fixture.candidates).toHaveLength(0);
    expect(fixture.firstStop).not.toHaveBeenCalled();
    expect(disposed).toEqual([]);
    expect(response).not.toHaveBeenCalled();
    expect(await fs.readFile(effectsPath, "utf8")).toBe("");
    if (holdMs > 60_000) {
      await vi.advanceTimersByTimeAsync(1);
      const failure = await reloadOutcome.promise;
      expect(failure).toBeInstanceOf(PluginRuntimeApplicationError);
      expect(failure).toMatchObject({
        details: { phase: "drain", committed: false, pluginIds: ["first"] },
        message: expect.stringMatching(
          /plugin first admitted work.*previous plugin generation stays active/,
        ),
      });
      expect(failure).toMatchObject({
        cause: { cause: expect.any(PluginHostCleanupTimeoutError) },
      });
      expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
      expect(manager.getRuntimeSnapshot().reloadingChannels?.size).toBe(0);
      expect(instance.disposing).toBe(false);
      expect(instance.lifecycle.signal.aborted).toBe(false);
      expect(disposed).toEqual([]);
      expect(fixture.firstStart).toHaveBeenCalledOnce();
      expect(fixture.firstStop).not.toHaveBeenCalled();
      expect(fixture.candidates).toHaveLength(0);
      expect(fixture.rollbackConfigEffects).toHaveBeenCalledOnce();
      expect(readiness()).toMatchObject({ ready: true, failing: [] });
      expect(fixture.owner.getReloadStatus()).toBeUndefined();
      const freshResponse = vi.fn();
      await invoke(false, freshResponse);
      expect(freshResponse).toHaveBeenCalledExactlyOnceWith(
        true,
        { generation: 1 },
        undefined,
        undefined,
      );
      expect(fixture.siblingStart).toHaveBeenCalledOnce();
      expect(fixture.siblingStop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(holdMs - 60_000);
      expect(callSettled).toBe(false);
      expect(response).not.toHaveBeenCalled();
      expect(await fs.readFile(effectsPath, "utf8")).toBe("");
    }
    release.resolve();
    expect(await originalCall).toBeUndefined();
    expect(response).toHaveBeenCalledExactlyOnceWith(true, { generation: 1 }, undefined, undefined);
    expect(await fs.readFile(effectsPath, "utf8")).toBe("completed\n");
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    allowNativeCleanup.resolve();
    if (holdMs > 60_000) {
      expect(await reloading).toBe(await reloadOutcome.promise);
      await expect(reload()).resolves.toMatchObject({ runtime: { pluginIds: ["first"] } });
    } else {
      expect(await reloading).toMatchObject({ runtime: { pluginIds: ["first"] } });
      expect(fixture.rollbackConfigEffects).not.toHaveBeenCalled();
    }
    expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(manager.getRuntimeSnapshot().reloadingChannels?.size).toBe(0);
    expect(readiness()).toMatchObject({ ready: true, failing: [] });
    expect(fixture.owner.getReloadStatus()).toBeUndefined();
    expect(instance.disposing).toBe(true);
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(disposed).toEqual([1]);
    expect(callSettled).toBe(true);
    expect(fixture.candidates).toHaveLength(1);
    await expect(invoke(false, vi.fn())).rejects.toThrow("reloaded or disabled");
    const completedLease = reloadLease;
    assert(completedLease);
    expect(() => completedLease.assertOwned()).toThrowError(
      expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_LOST" }),
    );
    await expect(
      withPluginLifecycleLease({ env, waitMs: 0 }, async (lease) => {
        lease.assertOwned();
        return "reacquired";
      }),
    ).resolves.toBe("reacquired");
    expect(fixture.firstStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    try {
      await originalCall;
      vi.useRealTimers();
      allowNativeCleanup.resolve();
      await reloading;
    } finally {
      drainObservation.mockRestore();
      vi.useRealTimers();
      await manager.stopChannel("drain-channel");
    }
  }
}
