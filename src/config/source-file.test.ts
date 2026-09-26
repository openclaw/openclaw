import chokidar, { FSWatcher } from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createConfigFileAdapter } from "./source-file.js";

describe("config file adapter", () => {
  const adapters = new Set<ReturnType<typeof createConfigFileAdapter>>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("CHOKIDAR_USEPOLLING", undefined);
  });

  afterEach(async () => {
    await Promise.all([...adapters].map((adapter) => adapter.stop()));
    adapters.clear();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function createHarness(includedPaths: string[] = [], forcedPolling?: boolean) {
    const watchers: FSWatcher[] = [];
    const watch = vi.spyOn(chokidar, "watch").mockImplementation((_paths, options) => {
      const watcher = new FSWatcher({
        ...options,
        ...(forcedPolling === undefined ? {} : { usePolling: forcedPolling }),
      });
      vi.spyOn(watcher, "close").mockResolvedValue();
      watchers.push(watcher);
      return watcher;
    });
    const onChange = vi.fn();
    const onReady = vi.fn();
    const log = { warn: vi.fn(), error: vi.fn() };
    const adapter = createConfigFileAdapter({
      path: "/tmp/openclaw.json",
      includedPaths,
      onChange,
      onReady,
      log,
    });
    adapters.add(adapter);
    const current = () => {
      const watcher = watchers.at(-1);
      if (!watcher) {
        throw new Error("adapter did not start watching");
      }
      return watcher;
    };
    return { adapter, watchers, watch, current, onChange, onReady, log };
  }

  it("starts explicitly, reconciles replacements, and ignores retired watcher events", async () => {
    const { adapter, current, watch, onReady, onChange } = createHarness();
    expect(watch).not.toHaveBeenCalled();
    adapter.start();
    adapter.start();
    expect(watch).toHaveBeenCalledOnce();
    const first = current();
    first.emit("ready");
    expect(onReady).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();

    await adapter.observePaths(["/tmp/hooks.json5"]);
    first.emit("change", "/tmp/openclaw.json");
    first.emit("ready");
    first.emit("error", new Error("retired watcher"));
    expect(onReady).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
    current().emit("ready");
    expect(onChange).toHaveBeenCalledOnce();

    await adapter.stop();
    current().emit("change", "/tmp/hooks.json5");
    current().emit("ready");
    adapter.start();
    await vi.runAllTimersAsync();
    expect(onChange).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it("retains accepted includes until acceptance and limits rejected includes to exact paths", async () => {
    const { adapter, current, onChange, watch } = createHarness(["/tmp/accepted.json5"]);
    adapter.start();
    await adapter.observePaths(["/tmp/first-invalid.json5"]);
    current().emit("change", "/tmp/accepted.json5");
    current().emit("change", "/tmp/first-invalid.json5");
    expect(onChange).toHaveBeenCalledTimes(2);

    await adapter.observePaths(["/tmp/rejected-directory"]);
    current().emit("change", "/tmp/first-invalid.json5");
    current().emit("change", "/tmp/rejected-directory/session.json");
    expect(onChange).toHaveBeenCalledTimes(2);
    current().emit("change", "/tmp/accepted.json5");
    current().emit("change", "/tmp/nested/../rejected-directory");
    expect(onChange).toHaveBeenCalledTimes(4);

    await adapter.acceptPaths(["/tmp/replacement.json5"]);
    current().emit("change", "/tmp/accepted.json5");
    current().emit("change", "/tmp/rejected-directory");
    expect(onChange).toHaveBeenCalledTimes(4);
    current().emit("unlink", "/tmp/replacement.json5");
    current().emit("add", "/tmp/replacement.json5");
    current().emit("change", "/tmp/openclaw.json");
    expect(onChange).toHaveBeenCalledTimes(7);
    const creations = watch.mock.calls.length;
    await adapter.observePaths(["/tmp/replacement.json5"]);
    await adapter.acceptPaths(["/tmp/replacement.json5"]);
    expect(watch).toHaveBeenCalledTimes(creations);
  });

  it.each([
    { setting: undefined, forced: undefined, modes: [false, true] },
    { setting: "1", forced: undefined, modes: [true] },
    { setting: "TrUe", forced: undefined, modes: [true] },
    { setting: "0", forced: undefined, modes: [false] },
    { setting: "FALSE", forced: undefined, modes: [false] },
    { setting: undefined, forced: true, modes: [true] },
  ])(
    "bounds recovery with polling setting $setting and platform override $forced",
    async (testCase) => {
      vi.stubEnv("CHOKIDAR_USEPOLLING", testCase.setting);
      const { adapter, current, watch, log, onChange } = createHarness([], testCase.forced);
      adapter.start();
      for (const [index, polling] of testCase.modes.entries()) {
        expect(current().options.usePolling).toBe(polling);
        for (const delay of [500, 2000, 5000]) {
          const previous = current();
          previous.emit("error", new Error("watch resources exhausted"));
          previous.emit("ready");
          expect(adapter.status()).toBe("active");
          await vi.advanceTimersByTimeAsync(delay - 1);
          expect(current()).toBe(previous);
          await vi.advanceTimersByTimeAsync(1);
          expect(current()).not.toBe(previous);
          expect(current().options.usePolling).toBe(polling);
          current().emit("ready");
        }
        current().emit("error", new Error("watch resources exhausted"));
        if (index < testCase.modes.length - 1) {
          expect(adapter.status()).toBe("active");
          await vi.advanceTimersByTimeAsync(500);
        }
      }
      expect(onChange).toHaveBeenCalledTimes(testCase.modes.length * 3);
      expect(adapter.status()).toBe("disabled");
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining("config hot-reload disabled"));
      const creations = watch.mock.calls.length;
      await vi.runAllTimersAsync();
      expect(watch).toHaveBeenCalledTimes(creations);
    },
  );

  it("resets the retry budget only after a current watched file event", async () => {
    const { adapter, current, watch, onChange } = createHarness();
    adapter.start();
    for (let round = 0; round < 5; round += 1) {
      const previous = current();
      previous.emit("error", new Error("transient watch failure"));
      await vi.advanceTimersByTimeAsync(500);
      expect(current()).not.toBe(previous);
      current().emit("change", "/tmp/openclaw.json");
    }
    expect(onChange).toHaveBeenCalledTimes(5);
    expect(adapter.status()).toBe("active");
    expect(current().options.usePolling).toBe(false);
    current().emit("error", new Error("stopping while retry is pending"));
    await adapter.stop();
    await vi.runAllTimersAsync();
    expect(watch).toHaveBeenCalledTimes(6);
  });

  it.each(["resolve", "reject"] as const)(
    "joins retired watcher cleanup after %s and never replaces it afterward",
    async (outcome) => {
      const { adapter, current, watch, onChange, onReady } = createHarness();
      adapter.start();
      const closing = createDeferred();
      const close = vi.spyOn(current(), "close").mockReturnValue(closing.promise);
      const updating = adapter.observePaths(["/tmp/next.json5"]);
      current().emit("ready");
      current().emit("change", "/tmp/openclaw.json");
      let stopped = false;
      const stopping = adapter.stop().then(() => {
        stopped = true;
      });
      try {
        await Promise.resolve();
        expect(stopped).toBe(false);
        expect(onReady).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
      } finally {
        if (outcome === "reject") {
          closing.reject(new Error("watcher close failed"));
        } else {
          closing.resolve();
        }
        await Promise.all([updating, stopping]);
      }
      expect(close).toHaveBeenCalledOnce();
      expect(watch).toHaveBeenCalledOnce();
    },
  );
});
