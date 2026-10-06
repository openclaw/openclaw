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

it.each([
  { kind: "plugin callback", rejects: false },
  { kind: "host hook", rejects: false },
  { kind: "plugin callback", rejects: true },
  { kind: "host hook", rejects: true },
  { kind: "abort descendant", rejects: true },
])("retains bytes until timed-out $kind settles (rejects: $rejects)", async ({ kind, rejects }) => {
  const { value, instance } = fixture("runtime");
  const capturedBytes = fs.readFileSync(value.filename, "utf8");
  const release = createDeferredCore();
  const entered = createDeferredCore();
  const events: string[] = [];
  const failure = new Error("late cleanup failed");
  const operation = async () => {
    entered.resolve();
    await release.promise;
    expect(fs.existsSync(value.filename)).toBe(true);
    expect(fs.readFileSync(value.filename, "utf8")).toBe(capturedBytes);
    if (rejects) {
      throw failure;
    }
    events.push("callback");
  };
  const cleanup = rejects ? instance.wrap(operation) : operation;
  if (!rejects) {
    instance.lifecycle.onDispose(() => {
      events.push("sibling");
    });
  }
  if (kind === "plugin callback") {
    instance.lifecycle.onDispose(cleanup);
  } else if (kind === "abort descendant") {
    instance.lifecycle.signal.addEventListener("abort", () => {
      void trackAsyncWork(operation).catch(() => {});
    });
  }
  const removal = rejects ? undefined : gateRemoval(value.filename, events);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let settled = false;
  let hostTimeout: unknown;
  const retirement = instance
    .dispose(
      kind === "host hook"
        ? async () => {
            try {
              await withPluginHostCleanupTimeout("fixture", () =>
                rejects ? runPluginCleanup(cleanup, cleanup) : instance.runCleanup(cleanup),
              );
            } catch (error) {
              hostTimeout = error;
            }
          }
        : undefined,
    )
    .finally(() => {
      settled = true;
    });
  try {
    if (!rejects) {
      await entered.promise;
    }
    await vi.advanceTimersByTimeAsync(5_001);
    const timeout = forcedRetirement((await retirement).errors);
    if (kind === "host hook") {
      expect(hostTimeout).toBeInstanceOf(PluginHostCleanupTimeoutError);
    }
    if (rejects) {
      const settlement = expect(timeout.settled).rejects.toMatchObject({ errors: [failure] });
      release.resolve();
      await settlement;
    } else {
      expect(instance.lifecycle.signal.aborted).toBe(true);
      expect(events).toEqual(["sibling"]);
      expect(removal?.directory()).toBeUndefined();
      expect(fs.existsSync(value.filename)).toBe(true);
      expect(settled).toBe(true);
      release.resolve();
      await Promise.race([removal!.entered, timeout.settled]);
      expect(events).toEqual(["sibling", "callback", "remove"]);
      removal!.resume.resolve();
      await expect(timeout.settled).resolves.toBeUndefined();
    }
    expect(fs.existsSync(value.filename)).toBe(false);
  } finally {
    release.resolve();
    removal?.resume.resolve();
    await retirement;
  }
});

it.each(["consumer", "context engine"])(
  "retains an admitted %s through the retirement deadline until its owner closes it",
  async (kind) => {
    const { value, instance } = fixture("runtime");
    const scope =
      kind === "context engine"
        ? new PluginInvocationScope(createEmptyPluginRegistry(), [instance], { retained: true })
        : undefined;
    const source = scope ? new ContextEngineFactoryResources([], scope) : undefined;
    const consumer = scope ? undefined : instance.retainConsumer();
    const run = <T>(operation: () => T) =>
      scope ? scope.run(operation) : consumer!.run(operation);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const retirement = instance.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    const timeout = forcedRetirement((await retirement).errors);
    expect(timeout.forcedRetirement).toEqual({ activeCallCount: 0, retainedConsumerCount: 1 });
    expect(run(() => value.read())).toBe("retained");
    expect(fs.existsSync(value.filename)).toBe(true);
    const cleanup = vi.fn(() => {
      expect(value.read()).toBe("retained");
    });
    try {
      if (source) {
        await disposeContextEngineSources(undefined, [source], cleanup);
      } else {
        await consumer!.close(cleanup);
      }
      expect(cleanup).toHaveBeenCalledOnce();
      expect(() => run(() => value.read())).toThrow(
        scope ? "invocation scope is closed" : "consumer is closed",
      );
      await timeout.settled;
      expect(fs.existsSync(value.filename)).toBe(false);
    } finally {
      await source?.release();
      consumer?.release();
      await timeout.settled;
    }
  },
);
