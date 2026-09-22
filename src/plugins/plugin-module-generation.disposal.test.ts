import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { getPluginSetupModuleLoader } from "./plugin-setup-module.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const nativeRequire = createRequire(import.meta.url);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(kind: "runtime" | "setup") {
  const rootDir = temp.make("plugin-artifact-disposal-");
  const source = path.join(rootDir, "index.cjs");
  fs.writeFileSync(
    source,
    'exports.filename = __filename; exports.read = () => require("./value.cjs");',
  );
  fs.writeFileSync(path.join(rootDir, "value.cjs"), 'module.exports = "retained";');
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
  }) as { filename: string; read(): string };
  const instance = expectDefined(getPluginValueInstance(value), "bound module owner");
  const retire = async () =>
    kind === "setup"
      ? (await retirePluginCache(cache)).failures.map((failure) => failure.error)
      : (await instance.dispose()).errors;
  return { value, instance, retire };
}

function gateRemoval(filename: string, events: string[], failure?: Error) {
  const entered = createDeferredCore();
  const resume = createDeferredCore();
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
    return remove(...args);
  });
  return { entered: entered.promise, resume, directory: () => directory };
}

it.each(["runtime", "setup"] as const)(
  "joins %s artifact removal after consumers and callbacks without blocking foreground work",
  async (kind) => {
    const { value, instance, retire } = fixture(kind);
    const events: string[] = [];
    const consumer = instance.retainConsumer();
    const retained = consumer.wrap(value);
    instance.lifecycle.onDispose(() => {
      events.push("plugin");
    });
    const gate = gateRemoval(value.filename, events);
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
      expect(settled).toBe(false);
      expect(fs.existsSync(value.filename)).toBe(true);
      gate.resume.resolve();
      await expect(retirement).resolves.toEqual([]);
      expect(fs.existsSync(expectDefined(gate.directory(), "retired artifact"))).toBe(false);
    } finally {
      consumer.release();
      gate.resume.resolve();
      await retirement;
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

it("keeps plugin callback deadlines while joining subsequent physical removal", async () => {
  const { value, instance, retire } = fixture("runtime");
  const callback = createDeferredCore();
  instance.lifecycle.onDispose(() => callback.promise);
  const gate = gateRemoval(value.filename, []);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let settled = false;
  const retirement = retire().finally(() => {
    settled = true;
  });
  try {
    await nextTurn();
    await vi.advanceTimersByTimeAsync(5_001);
    await Promise.race([gate.entered, retirement]);
    expect(gate.directory()).toBeDefined();
    expect(settled).toBe(false);
    gate.resume.resolve();
    await expect(retirement).resolves.toEqual([
      new Error("Plugin disposal-runtime cleanup did not settle"),
    ]);
  } finally {
    callback.resolve();
    gate.resume.resolve();
    await retirement;
  }
});
