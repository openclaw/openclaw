import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  ContextEngineFactoryResources,
  disposeContextEngineSources,
} from "../context-engine/registry.resources.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  PluginHostCleanupTimeoutError,
  withPluginHostCleanupTimeout,
} from "./host-hook-cleanup-timeout.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { PluginInstanceDrainTimeoutError } from "./plugin-instance-error.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { getPluginValueInstance, runPluginCleanup } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { PluginInvocationScope } from "./plugin-invocation-scope.js";
import { getPluginSetupModuleLoader } from "./plugin-setup-module.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const nativeRequire = createRequire(import.meta.url);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(kind: "runtime" | "setup", native = false) {
  const rootDir = temp.make("plugin-artifact-disposal-");
  const source = path.join(rootDir, "index.cjs");
  fs.writeFileSync(
    source,
    'exports.filename = __filename; exports.read = () => require("./value.cjs");' +
      (native
        ? 'exports.nativeFile = require("node:fs").realpathSync(require("node:path").join(__dirname, "native.so"));'
        : ""),
  );
  fs.writeFileSync(path.join(rootDir, "value.cjs"), 'module.exports = "retained";');
  if (native) {
    fs.writeFileSync(path.join(rootDir, "native.so"), "retained native bytes");
  }
  const cache = createPluginCache();
  const value = withPluginCache(cache, () => {
    if (kind === "runtime") {
      const instance = new PluginInstance("disposal-runtime");
      bindPluginInstanceModuleLoader({ instance, origin: "config", source, rootDir });
      return instance.loadModule(source);
    }
    const record: PluginManifestRecord = {
      id: "disposal-setup",
      origin: "config",
      rootDir,
      source,
      manifestPath: path.join(rootDir, "openclaw.plugin.json"),
      channels: [],
      providers: [],
      cliBackends: [],
      hooks: [],
      skills: [],
    };
    const load = getPluginSetupModuleLoader(record, source, rootDir);
    return load.initialize(() => load(source));
  }) as { filename: string; nativeFile?: string; read(): string };
  const instance = expectDefined(getPluginValueInstance(value), "bound module owner");
  const retire = async () =>
    kind === "setup"
      ? (await retirePluginCache(cache)).failures.map((failure) => failure.error)
      : (await instance.dispose()).errors;
  return { value, instance, retire, cache };
}

function forcedRetirement(errors: readonly unknown[]) {
  const timeout = errors[0];
  expect(timeout).toBeInstanceOf(PluginInstanceDrainTimeoutError);
  if (!(timeout instanceof PluginInstanceDrainTimeoutError)) {
    throw new Error("Expected forced retirement");
  }
  return timeout;
}

function gateRemoval(filename: string, events: string[], failure?: Error, nativeFile?: string) {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const nativeRemoved = createDeferredCore();
  const remove = fsPromises.rm;
  let directory: string | undefined;
  vi.spyOn(fsPromises, "rm").mockImplementation(async (...args) => {
    if (typeof args[0] === "string" && filename.startsWith(args[0] + path.sep)) {
      directory = args[0];
      events.push("remove");
      entered.resolve();
      await resume.promise;
      if (failure) {
        throw failure;
      }
    }
    await remove(...args);
    if (nativeFile && typeof args[0] === "string" && nativeFile.startsWith(args[0] + path.sep)) {
      nativeRemoved.resolve();
    }
  });
  return {
    entered: entered.promise,
    resume,
    nativeRemoved: nativeRemoved.promise,
    directory: () => directory,
  };
}

it.each(["runtime", "setup"] as const)(
  "joins %s artifact removal after consumers and callbacks without blocking foreground work",
  async (kind) => {
    const { value, instance, retire, cache } = fixture(kind, true);
    const nativeFile = expectDefined(value.nativeFile, "captured native asset");
    const events: string[] = [];
    const consumer = instance.retainConsumer();
    const retained = consumer.wrap(value);
    instance.lifecycle.onDispose(() => {
      events.push("plugin");
    });
    const gate = gateRemoval(value.filename, events, undefined, nativeFile);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const retirement = retire().finally(() => {
      settled = true;
    });
    try {
      await nextTurn();
      expect(events).toEqual([]);
      expect(retained.read()).toBe("retained");
      expect(fs.existsSync(value.filename)).toBe(true);
      await consumer.close(() => {
        events.push("consumer");
      });
      await Promise.race([gate.entered, retirement]);
      expect(events).toEqual(["consumer", "plugin", "remove"]);
      expect(nativeRequire.cache[value.filename]).toBeUndefined();
      expect(() => value.read()).toThrow("reloaded or disabled");
      await vi.advanceTimersByTimeAsync(5_001);
      await nextTurn();
      expect(settled).toBe(true);
      const timeout = forcedRetirement(await retirement);
      expect(fs.existsSync(value.filename)).toBe(true);
      expect(fs.readFileSync(nativeFile, "utf8")).toBe("retained native bytes");
      gate.resume.resolve();
      await expect(timeout.settled).resolves.toBeUndefined();
      await retirePluginCache(cache);
      await gate.nativeRemoved;
      expect(fs.existsSync(nativeFile)).toBe(false);
      expect(fs.existsSync(expectDefined(gate.directory(), "retired artifact"))).toBe(false);
    } finally {
      consumer.release();
      gate.resume.resolve();
      await retirement;
      await retirePluginCache(cache);
    }
  },
);

it("reports asynchronous artifact removal failure through setup cache retirement", async () => {
  const { value, retire } = fixture("setup");
  const failure = new Error("artifact removal failed");
  const gate = gateRemoval(value.filename, [], failure);
  const retirement = retire();
  try {
    await Promise.race([gate.entered, retirement]);
    expect(gate.directory()).toBeDefined();
    gate.resume.resolve();
    await expect(retirement).resolves.toEqual([failure]);
    expect(nativeRequire.cache[value.filename]).toBeUndefined();
    expect(() => value.read()).toThrow("reloaded or disabled");
  } finally {
    gate.resume.resolve();
    await retirement;
    vi.restoreAllMocks();
    if (gate.directory()) {
      await fsPromises.rm(gate.directory()!, { recursive: true, force: true });
    }
  }
});

it("retains captured bytes for a consumer derived while retirement waits on its parent", async () => {
  const { value, instance, retire } = fixture("runtime");
  const parent = instance.retainConsumer();
  let child: ReturnType<PluginInstance["retainConsumer"]> | undefined;
  const events: string[] = [];
  const gate = gateRemoval(value.filename, events);
  const retirement = retire();
  try {
    await nextTurn();
    child = parent.run(() => instance.retainConsumer());
    parent.release();
    await nextTurn();
    expect(events).toEqual([]);
    expect(fs.existsSync(value.filename)).toBe(true);
    expect(child.run(() => value.read())).toBe("retained");
    child.release();
    await Promise.race([gate.entered, retirement]);
    expect(events).toEqual(["remove"]);
    gate.resume.resolve();
    await expect(retirement).resolves.toEqual([]);
    expect(fs.existsSync(value.filename)).toBe(false);
  } finally {
    parent.release();
    child?.release();
    gate.resume.resolve();
    await retirement;
  }
});

it.each(["plugin callback", "host prelude"] as const)(
  "retains captured bytes until a timed-out %s actually settles",
  async (kind) => {
    const { value, instance, retire } = fixture("runtime");
    const capturedBytes = fs.readFileSync(value.filename, "utf8");
    const callback = createDeferredCore();
    const entered = createDeferredCore();
    const events: string[] = [];
    const cleanup = async () => {
      entered.resolve();
      await callback.promise;
      expect(fs.readFileSync(value.filename, "utf8")).toBe(capturedBytes);
      events.push("callback");
    };
    instance.lifecycle.onDispose(() => {
      events.push("sibling");
    });
    if (kind === "plugin callback") {
      instance.lifecycle.onDispose(cleanup);
    }
    const gate = gateRemoval(value.filename, events);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    let hostTimeout: unknown;
    const retirement = (
      kind === "plugin callback"
        ? retire()
        : instance
            .dispose(async () => {
              try {
                await withPluginHostCleanupTimeout("fixture", () => instance.runCleanup(cleanup));
              } catch (error) {
                hostTimeout = error;
              }
            })
            .then((result) => result.errors)
    ).finally(() => {
      settled = true;
    });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(5_001);
      expect(instance.lifecycle.signal.aborted).toBe(true);
      expect(events).toEqual(["sibling"]);
      expect(gate.directory()).toBeUndefined();
      expect(fs.existsSync(value.filename)).toBe(true);
      expect(settled).toBe(true);
      const timeout = forcedRetirement(await retirement);
      callback.resolve();
      await Promise.race([gate.entered, timeout.settled]);
      expect(events).toEqual(["sibling", "callback", "remove"]);
      gate.resume.resolve();
      await expect(timeout.settled).resolves.toBeUndefined();
      if (kind === "host prelude") {
        expect(hostTimeout).toBeInstanceOf(PluginHostCleanupTimeoutError);
      }
      expect(fs.existsSync(value.filename)).toBe(false);
    } finally {
      callback.resolve();
      gate.resume.resolve();
      await retirement;
    }
  },
);

it.each(["plugin callback", "host hook", "abort descendant"] as const)(
  "records the terminal failure of a timed-out %s before handing off resources",
  async (kind) => {
    const { value, instance } = fixture("runtime");
    const gate = createDeferredCore();
    const failure = new Error("late cleanup failed");
    const failCleanup = async () => {
      await gate.promise;
      expect(fs.existsSync(value.filename)).toBe(true);
      throw failure;
    };
    const cleanup = instance.wrap(failCleanup);
    if (kind === "plugin callback") {
      instance.lifecycle.onDispose(cleanup);
    } else if (kind === "abort descendant") {
      instance.lifecycle.signal.addEventListener("abort", () => {
        void trackAsyncWork(failCleanup).catch(() => {});
      });
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const retirement = instance.dispose(
      kind === "host hook"
        ? async () => {
            try {
              await withPluginHostCleanupTimeout("fixture", () =>
                runPluginCleanup(cleanup, cleanup),
              );
            } catch (error) {
              expect(error).toBeInstanceOf(PluginHostCleanupTimeoutError);
            }
          }
        : undefined,
    );
    try {
      await vi.advanceTimersByTimeAsync(5_001);
      const timeout = forcedRetirement((await retirement).errors);
      const settlement = expect(timeout.settled).rejects.toMatchObject({ errors: [failure] });
      gate.resolve();
      await settlement;
      expect(fs.existsSync(value.filename)).toBe(false);
    } finally {
      gate.resolve();
      await retirement;
    }
  },
);

it("retains an admitted consumer through the retirement deadline until its owner closes it", async () => {
  const { value, instance } = fixture("runtime");
  const consumer = instance.retainConsumer();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const retirement = instance.dispose();
  await vi.advanceTimersByTimeAsync(5_000);
  const timeout = forcedRetirement((await retirement).errors);
  expect(timeout.forcedRetirement).toEqual({ activeCallCount: 0, retainedConsumerCount: 1 });
  expect(consumer.run(() => value.read())).toBe("retained");
  expect(fs.existsSync(value.filename)).toBe(true);
  await consumer.close(() => {
    expect(value.read()).toBe("retained");
  });
  expect(() => consumer.run(() => value.read())).toThrow("consumer is closed");
  await timeout.settled;
  expect(fs.existsSync(value.filename)).toBe(false);
});

it("lets the context-engine owner finish cleanup after forced retirement", async () => {
  const { value, instance } = fixture("runtime");
  const scope = new PluginInvocationScope(createEmptyPluginRegistry(), [instance], {
    retained: true,
  });
  const source = new ContextEngineFactoryResources([], scope);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const retirement = instance.dispose();
  await vi.advanceTimersByTimeAsync(5_000);
  const timeout = forcedRetirement((await retirement).errors);
  expect(scope.run(() => value.read())).toBe("retained");
  const cleanup = vi.fn(() => {
    expect(value.read()).toBe("retained");
  });
  try {
    await disposeContextEngineSources(undefined, [source], cleanup);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(() => scope.run(() => value.read())).toThrow("invocation scope is closed");
    await timeout.settled;
    expect(fs.existsSync(value.filename)).toBe(false);
  } finally {
    await source.release();
    await timeout.settled;
  }
});
