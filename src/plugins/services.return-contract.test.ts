import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstance } from "./plugin-instance.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { startPluginServices } from "./services.js";
import { createRegistry, createServiceConfig } from "./services.test-support.js";
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

it.each([
  "sync void",
  "sync value",
  "fulfilled promise",
  "fulfilled thenable",
  "rejected promise",
  "rejected thenable",
] as const)("preserves the issued %s cleanup completion", async (kind) => {
  const failure = new Error("callback rejected");
  let assimilations = 0;
  const stop = vi.fn(() => {
    if (kind === "sync void") {
      return undefined;
    }
    if (kind === "sync value") {
      return 42;
    }
    if (kind === "fulfilled promise") {
      return Promise.resolve();
    }
    if (kind === "rejected promise") {
      return Promise.reject(failure);
    }
    return {
      // oxlint-disable-next-line unicorn/no-thenable -- A standard thenable is the shipped JS return contract under test.
      then(resolve: () => void, reject: (error: unknown) => void) {
        assimilations += 1;
        if (kind === "rejected thenable") {
          reject(failure);
        } else {
          resolve();
        }
      },
    };
  });
  const handle = await startPluginServices({
    registry: createRegistry([
      {
        id: "return-contract",
        start() {},
        // JavaScript plugin return values were accepted by the shipped Promise.resolve boundary.
        stop: stop as OpenClawPluginService["stop"],
      },
    ]),
    config: createServiceConfig(),
  });
  try {
    if (kind.startsWith("rejected")) {
      await expect(handle.stop()).resolves.toEqual({ errors: [failure] });
    } else {
      // Already-complete values win even when an earlier service consumed the whole budget.
      const deadlineAtMs = Date.now() + (kind === "fulfilled thenable" ? 5_000 : 0);
      await expect(handle.stop({ strict: true, deadlineAtMs })).resolves.toBeUndefined();
    }
    expect(stop).toHaveBeenCalledOnce();
    expect(assimilations).toBe(kind.endsWith("thenable") ? 1 : 0);
    await handle.stop();
    expect(stop).toHaveBeenCalledOnce();
    expect(assimilations).toBe(kind.endsWith("thenable") ? 1 : 0);
  } finally {
    await handle.stop().catch(() => {});
  }
});

it.each(["native", "plain service", "managed service"] as const)(
  "reads an accessor thenable once through %s",
  async (surface) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let reads = 0;
    let calls = 0;
    const scopes: unknown[] = [];
    const value = {
      // oxlint-disable-next-line unicorn/no-thenable -- Native assimilation reads this JS accessor once.
      get then() {
        reads += 1;
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
    const id = "accessor-return";
    const registry = createRegistry([]);
    const record = createPluginRecord({ id });
    registry.plugins.push(record);
    const instance = new PluginInstance(id, { record, registry });
    // oxlint-disable-next-line typescript/no-misused-promises -- The void SDK callback deliberately returns a JS thenable for host assimilation.
    const stop = vi.fn<() => void>(() => value);
    const service = { id, start() {}, stop };
    registry.services.push({
      pluginId: id,
      origin: "workspace",
      source: "test",
      service: surface === "managed service" ? instance.wrap(service) : service,
    });
    const handle =
      surface === "native" ? undefined : await startPluginServices({ registry, config: {} });
    const stopping = handle ? handle.stop() : Promise.resolve<unknown>(value);
    let settled = false;
    const observed = stopping.then((result) => {
      settled = true;
      return result;
    });
    try {
      const first = await Promise.race([
        entered.promise.then(() => "entered"),
        observed.then(() => "stopped"),
      ]);
      expect(first).toBe("entered");
      expect(settled).toBe(false);
      expect(reads).toBe(1);
      expect(calls).toBe(1);
      if (surface === "managed service") {
        expect(scopes).toEqual([registry, registry]);
      }
      release.resolve();
      await expect(observed).resolves.toBeUndefined();
      await handle?.stop();
      expect(reads).toBe(1);
      expect(calls).toBe(1);
      expect(stop).toHaveBeenCalledTimes(handle ? 1 : 0);
    } finally {
      release.resolve();
      await stopping;
      await handle?.stop();
      await instance.dispose();
    }
  },
);

it.each(
  (["native", "plain service", "managed service"] as const).flatMap((surface) => [
    { surface, kind: "Error", failure: new Error("then getter failed") },
    { surface, kind: "non-Error", failure: "then getter failed" },
  ]),
)("preserves a $kind then getter rejection through $surface", async ({ surface, failure }) => {
  let reads = 0;
  const value = {
    // oxlint-disable-next-line unicorn/no-thenable -- A throwing accessor is a native rejected completion.
    get then() {
      reads += 1;
      // oxlint-disable-next-line typescript/only-throw-error -- Native resolution preserves primitive JS getter rejections too.
      throw failure;
    },
  };
  const instance = new PluginInstance("throwing-return");
  // The void arm of the SDK callback contract ignores the returned JS value.
  const stop: () => void = () => value;
  const service = { id: "throwing-return", start() {}, stop };
  const registry = createRegistry([
    surface === "managed service" ? instance.wrap(service) : service,
  ]);
  const handle =
    surface === "native" ? undefined : await startPluginServices({ registry, config: {} });
  try {
    if (handle) {
      await expect(handle.stop()).resolves.toEqual({ errors: [failure] });
      await expect(handle.stop()).resolves.toEqual({ errors: [failure] });
    } else {
      await expect(Promise.resolve<unknown>(value)).rejects.toBe(failure);
    }
    expect(reads).toBe(1);
  } finally {
    await handle?.stop().catch(() => {});
    await instance.dispose();
  }
});
