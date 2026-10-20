import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstance } from "./plugin-instance.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import {
  createRegistry,
  createServiceRegistration,
  startPluginServices,
} from "./services.test-support.js";
import { createPluginRecord } from "./status.test-helpers.js";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () =>
    Object.fromEntries(["info", "warn", "error", "debug"].map((method) => [method, vi.fn()])),
}));

it.each([
  { kind: "sync", managed: false },
  { kind: "promise", managed: false },
  { kind: "thenable", managed: false },
  { kind: "accessor", managed: false },
  { kind: "accessor", managed: true },
  { kind: "throwing getter", managed: false },
  { kind: "throwing getter", managed: true },
])("settles $kind cleanup exactly once (managed=$managed)", async ({ kind, managed }) => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const counts = { reads: 0, calls: 0 };
  const scopes: unknown[] = [];
  const accessor = kind === "accessor";
  const throwing = kind === "throwing getter";
  const failure = throwing ? "then getter failed" : new Error("callback rejected");
  const value = {
    // oxlint-disable-next-line unicorn/no-thenable -- Native resolution must read foreign accessors only once.
    get then() {
      counts.reads += 1;
      if (throwing) {
        // oxlint-disable-next-line typescript/only-throw-error -- Preserve primitive JS getter rejections.
        throw failure;
      }
      scopes.push(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
      if (counts.reads > 1) {
        return undefined;
      }
      return function (this: unknown, resolve: () => void) {
        expect(this).toBe(value);
        counts.calls += 1;
        scopes.push(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
        entered.resolve();
        void release.promise.then(resolve);
      };
    },
  };
  // oxlint-disable-next-line typescript/no-misused-promises -- The void SDK callback deliberately returns JS values for host assimilation.
  const stop = vi.fn<() => void>(() => {
    if (kind === "sync" || kind === "promise") {
      return kind === "sync" ? 42 : Promise.resolve();
    }
    if (kind === "thenable") {
      return {
        // oxlint-disable-next-line unicorn/no-thenable -- Exercise rejection by an ordinary thenable.
        then(_resolve: () => void, reject: (error: unknown) => void) {
          counts.calls += 1;
          reject(failure);
        },
      };
    }
    return value;
  });
  const registry = createRegistry([]);
  const id = "return-contract";
  const record = createPluginRecord({ id });
  if (accessor) {
    registry.plugins.push(record);
  }
  const instance =
    accessor || throwing
      ? new PluginInstance(id, accessor ? { record, registry } : undefined)
      : undefined;
  const service = { id, start() {}, stop };
  const admitted = managed ? instance!.wrap(service) : service;
  registry.services = accessor
    ? [createServiceRegistration(admitted, { pluginId: id })]
    : createRegistry([admitted]).services;
  const handle = await startPluginServices({ registry, config: {} });
  let stopping: ReturnType<typeof handle.stop> | undefined;
  try {
    if (accessor) {
      let settled = false;
      stopping = handle.stop().then((result) => {
        settled = true;
        return result;
      });
      await expect(
        Promise.race([entered.promise.then(() => "entered"), stopping.then(() => "stopped")]),
      ).resolves.toBe("entered");
      expect({ settled, ...counts }).toEqual({ settled: false, reads: 1, calls: 1 });
      if (managed) {
        expect(scopes).toEqual([registry, registry]);
      }
      release.resolve();
      await expect(stopping).resolves.toBeUndefined();
      await handle.stop();
      expect(counts).toEqual({ reads: 1, calls: 1 });
    } else {
      const expected = { reads: throwing ? 1 : 0, calls: kind === "thenable" ? 1 : 0 };
      if (kind === "sync" || kind === "promise") {
        // Already-complete values must win against an exhausted stop budget.
        await expect(
          handle.stop({ strict: true, deadlineAtMs: Date.now() }),
        ).resolves.toBeUndefined();
      } else {
        await expect(handle.stop()).resolves.toEqual({ errors: [failure] });
      }
      expect(stop).toHaveBeenCalledOnce();
      expect(counts).toEqual(expected);
      if (throwing) {
        await expect(handle.stop()).resolves.toEqual({ errors: [failure] });
      } else {
        await handle.stop();
      }
      expect(counts).toEqual(expected);
    }
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await stopping;
    await handle.stop();
    await instance?.dispose();
  }
});
