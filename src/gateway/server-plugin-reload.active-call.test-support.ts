import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import {
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "../plugins/plugin-lifecycle-lease.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import type { RecoveryFixtureFactory } from "./server-plugin-reload.recovery.test-support.js";

export async function verifyActiveCallDrainLease(
  createRecoveryFixture: RecoveryFixtureFactory,
  stateDir: string,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const serviceStopped = createDeferredCore();
  const effectsPath = path.join(stateDir, "completed-call.txt");
  await fs.writeFile(effectsPath, "");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  let reloadLease: PluginLifecycleLeaseContext | undefined;
  let registrations = 0;
  const disposed: number[] = [];
  const fixture = await createRecoveryFixture({
    env,
    abortOnCandidateStart: false,
    initialStop: async () => {
      serviceStopped.resolve();
    },
    assertInvokerOwned: () => {
      assert(reloadLease);
      reloadLease.assertOwned();
    },
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
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
  const record = fixture.previousRegistry.plugins.find((entry) => entry.id === "first");
  assert(record);
  const instance = getPluginInstance(record);
  assert(instance);
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
  const reload = () =>
    withPluginLifecycleLease({ env, waitMs: 0 }, async (lease) => {
      reloadLease = lease;
      return fixture.reload();
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
  try {
    await entered.promise;
    vi.useFakeTimers();
    let reloadSettled = false;
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
    await serviceStopped.promise;
    await vi.advanceTimersByTimeAsync(0);
    await expect(
      withPluginLifecycleLease({ env, waitMs: 0 }, async () => "competing owner"),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(reloadSettled).toBe(false);
    expect(callSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // Disposal has its existing separate deadline; the held native continuation
    // may remain, while its retired registration must stop accepting new calls.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await reloading).toMatchObject({
      runtime: {
        operationId: "service-recovery",
        pluginIds: ["first"],
        warnings: expect.arrayContaining([expect.stringContaining("active calls")]),
      },
    });
    expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
    expect(instance.disposing).toBe(true);
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(disposed).toEqual([1]);
    expect(callSettled).toBe(false);
    expect(response).not.toHaveBeenCalled();
    expect(await fs.readFile(effectsPath, "utf8")).toBe("");
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
    await expect(reload()).resolves.toMatchObject({ runtime: { pluginIds: ["first"] } });
    expect(disposed).toEqual([1, 2]);
    await expect(invoke(false, vi.fn())).rejects.toThrow("reloaded or disabled");
    expect(await fs.readFile(effectsPath, "utf8")).toBe("");
    release.resolve();
    expect(await originalCall).toBeUndefined();
    expect(response).toHaveBeenCalledExactlyOnceWith(true, { generation: 1 }, undefined, undefined);
    expect(await fs.readFile(effectsPath, "utf8")).toBe("completed\n");
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(disposed).toEqual([1, 2]);
    await expect(invoke(false, vi.fn())).rejects.toThrow("reloaded or disabled");
    expect(await fs.readFile(effectsPath, "utf8")).toBe("completed\n");
    expect(fixture.siblingStop).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await Promise.allSettled([originalCall, reloading]);
    vi.useRealTimers();
  }
}
