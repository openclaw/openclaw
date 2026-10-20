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
import type { OpenClawPluginService } from "./types.js";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

it.each(["sync value", "fulfilled promise", "rejected thenable"] as const)(
  "preserves the issued %s cleanup completion",
  async (kind) => {
    const failure = new Error("callback rejected");
    let assimilations = 0;
    const stop = vi.fn(() => {
      if (kind === "sync value") {
        return 42;
      }
      if (kind === "fulfilled promise") {
        return Promise.resolve();
      }
      return {
        // oxlint-disable-next-line unicorn/no-thenable -- Exercise the shipped JS return contract.
        then(_resolve: () => void, reject: (error: unknown) => void) {
          assimilations += 1;
          reject(failure);
        },
      };
    });
    const handle = await startPluginServices({
      registry: createRegistry([
        {
          id: "return-contract",
          start() {},
          stop: stop as OpenClawPluginService["stop"],
        },
      ]),
      config: {},
    });
    try {
      if (kind === "rejected thenable") {
        await expect(handle.stop()).resolves.toEqual({ errors: [failure] });
      } else {
        // An already-complete value wins even with no remaining stop budget.
        await expect(
          handle.stop({ strict: true, deadlineAtMs: Date.now() }),
        ).resolves.toBeUndefined();
      }
      expect(stop).toHaveBeenCalledOnce();
      expect(assimilations).toBe(kind === "rejected thenable" ? 1 : 0);
      await handle.stop();
      expect(stop).toHaveBeenCalledOnce();
      expect(assimilations).toBe(kind === "rejected thenable" ? 1 : 0);
    } finally {
      await handle.stop().catch(() => {});
    }
  },
);

it.each([
  { managed: false, rejects: false },
  { managed: true, rejects: false },
  { managed: false, rejects: true },
  { managed: true, rejects: true },
])(
  "assimilates an accessor once (managed=$managed, rejects=$rejects)",
  async ({ managed, rejects }) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const failure = "then getter failed";
    let reads = 0;
    let calls = 0;
    let settled = false;
    const scopes: unknown[] = [];
    const value = {
      // oxlint-disable-next-line unicorn/no-thenable -- Test native accessor assimilation, including primitive rejection.
      get then() {
        reads += 1;
        if (rejects) {
          // oxlint-disable-next-line typescript/only-throw-error -- Native resolution must preserve primitive rejections.
          throw failure;
        }
        scopes.push(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
        if (reads > 1) {
          return undefined;
        }
        return function (this: unknown, resolve: () => void) {
          expect(this).toBe(value);
          calls += 1;
          scopes.push(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
          entered.resolve();
          void release.promise.then(resolve);
        };
      },
    };
    const id = rejects ? "throwing-return" : "accessor-return";
    const registry = createRegistry([]);
    const record = createPluginRecord({ id });
    if (!rejects) {
      registry.plugins.push(record);
    }
    const instance = new PluginInstance(id, rejects ? undefined : { record, registry });
    // oxlint-disable-next-line typescript/no-misused-promises -- The void SDK callback deliberately returns a JS thenable.
    const stop = vi.fn<() => void>(() => value);
    const service = { id, start() {}, stop };
    const admitted = managed ? instance.wrap(service) : service;
    registry.services = rejects
      ? createRegistry([admitted]).services
      : [createServiceRegistration(admitted, { pluginId: id })];
    const handle = await startPluginServices({ registry, config: {} });
    let stopping: ReturnType<typeof handle.stop> | undefined;
    try {
      if (rejects) {
        await expect(handle.stop()).resolves.toEqual({ errors: [failure] });
        await expect(handle.stop()).resolves.toEqual({ errors: [failure] });
        expect(reads).toBe(1);
      } else {
        stopping = handle.stop().then((result) => {
          settled = true;
          return result;
        });
        await expect(
          Promise.race([entered.promise.then(() => "entered"), stopping.then(() => "stopped")]),
        ).resolves.toBe("entered");
        expect({ settled, reads, calls }).toEqual({ settled: false, reads: 1, calls: 1 });
        if (managed) {
          expect(scopes).toEqual([registry, registry]);
        }
        release.resolve();
        await expect(stopping).resolves.toBeUndefined();
        await handle.stop();
        expect({ reads, calls }).toEqual({ reads: 1, calls: 1 });
        expect(stop).toHaveBeenCalledOnce();
      }
    } finally {
      release.resolve();
      await stopping;
      await handle.stop();
      await instance.dispose();
    }
  },
);
