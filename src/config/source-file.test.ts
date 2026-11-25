import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as observation from "@openclaw/fs-safe/watch";
import type { WatchOptions, WatchSubscription } from "@openclaw/fs-safe/watch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as snapshots from "../infra/fs-observation-snapshot.js";
import * as owned from "../infra/owned-directory-observation.js";
import * as configPaths from "./paths.js";
import { admitConfigObservationRoots, configObservationEntries } from "./source-file-roots.js";
import { createConfigFileAdapter } from "./source-file.js";

vi.mock("@openclaw/fs-safe/watch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/watch")>()),
}));

vi.mock("../infra/owned-directory-observation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/owned-directory-observation.js")>()),
  observeOwnedDirectory: vi.fn(() => ({ close: vi.fn(), isWatching: vi.fn(() => true) })),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
type Source = { subscription: WatchSubscription; options: WatchOptions };

function failSource({ options }: Source, operation: "scan" | "watch" = "scan") {
  const events = vi.mocked(owned.observeOwnedDirectory);
  const last = events.mock.results.at(-1);
  if (operation === "watch" && last?.type === "return") {
    vi.spyOn(last.value, "isWatching").mockReturnValueOnce(false);
    events.mock.calls.at(-1)![1]();
    return;
  }
  options.onHealth?.({
    state: "unavailable",
    mode: operation === "scan" || options.mode !== "poll" ? "events" : "poll",
    directories: 0,
    failure:
      operation === "scan"
        ? { operation, error: new Error("watch observation worker stopped") }
        : { operation, code: "watch-limit", error: new Error("watch limit reached") },
  });
}

const adapters = new Set<ReturnType<typeof createConfigFileAdapter>>();
afterEach(async () => {
  await Promise.all([...adapters].map((adapter) => adapter.stop()));
  adapters.clear();
  vi.restoreAllMocks();
  vi.mocked(owned.observeOwnedDirectory).mockClear();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture({
  realMode = false,
  includeRoots = [],
}: {
  realMode?: boolean;
  includeRoots?: readonly string[];
} = {}) {
  vi.spyOn(configPaths, "resolveIncludeRoots").mockReturnValue([...includeRoots]);
  const directory = await fs.realpath(dirs.make("config-observation-"));
  const p = (name: string) => path.join(directory, name);
  const write = (name: string, content = '{"changed":true}') => fs.writeFile(p(name), content);
  await Promise.all([write("openclaw.json", "{}"), write("accepted.json", "{}")]);
  vi.useFakeTimers();
  const sampling: Promise<unknown>[] = [];
  const readSnapshot = snapshots.readObservationSnapshot;
  vi.spyOn(snapshots, "readObservationSnapshot").mockImplementation((...args) => {
    const sample = readSnapshot(...args);
    sampling.push(sample);
    return sample;
  });
  const sources: Source[] = [];
  let installed: ((source: Source) => void) | undefined;
  const ready = createDeferred();
  const watch = observation.watch;
  vi.spyOn(observation, "watch").mockImplementation((root, options) => {
    // Most policy cases use deterministic polling; backend selection keeps the actual options.
    const subscription = watch(
      root,
      realMode ? options : { ...options, mode: "poll", pollIntervalMs: 30_000 },
    );
    void subscription.ready.catch(ready.reject);
    sources.push({ subscription, options });
    installed?.({ subscription, options });
    installed = undefined;
    return subscription;
  });
  const onChange = vi.fn();
  const failReady = (message: string) => ready.reject(new Error(message));
  const log = { warn: vi.fn(failReady), error: vi.fn(failReady) };
  const adapter = createConfigFileAdapter({
    path: p("openclaw.json"),
    includedPaths: [p("accepted.json")],
    onChange,
    onReady: () => ready.resolve(),
    log,
  });
  adapters.add(adapter);
  await adapter.start();
  await ready.promise;
  const reconcile = () =>
    Promise.all(
      sources
        .filter(({ subscription }) => subscription.health().state !== "closed")
        .map(({ subscription }) => subscription.reconcile()),
    );
  const settle = async (samples = 5) => {
    for (let sample = 0; sample < samples; sample += 1) {
      await vi.advanceTimersByTimeAsync(50);
      while (sampling.length) {
        await Promise.all(sampling.splice(0));
      }
    }
  };
  const nextSource = () =>
    new Promise<Source>((resolve) => {
      installed = resolve;
    });
  const expectChanges = async (count: number) => {
    await reconcile();
    await settle();
    expect(onChange).toHaveBeenCalledTimes(count);
  };
  const expectHealthy = () => {
    expect(adapter.status()).toBe("active");
    expect([log.warn.mock.calls, log.error.mock.calls]).toEqual([[], []]);
  };
  const recover = async (
    ms: number,
    operation: "scan" | "watch",
    duringDowntime?: () => Promise<unknown>,
  ) => {
    const previous = sources.at(-1)!;
    const replacement = nextSource();
    failSource(previous, operation);
    await previous.subscription.close();
    await duringDowntime?.();
    await vi.advanceTimersByTimeAsync(ms);
    const current = await replacement;
    await current.subscription.ready;
    await settle();
    return current;
  };
  return {
    adapter,
    p,
    write,
    sources,
    onChange,
    log,
    reconcile,
    settle,
    nextSource,
    expectChanges,
    expectHealthy,
    recover,
  };
}

describe("config file observation", () => {
  it("uses nonrecursive events beside config files without a recursive authority-root watch", async () => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", undefined);
    const h = await fixture({ realMode: true });
    expect(h.sources[0]!.options).toMatchObject({ mode: "poll", pollIntervalMs: 300_000 });
    const events = vi.mocked(owned.observeOwnedDirectory);
    expect(events).toHaveBeenCalledWith(path.dirname(h.p("openclaw.json")), expect.any(Function), {
      recursive: false,
      reconcileIntervalMs: 300_000,
    });
    expect(events).toHaveBeenCalledTimes(1);
    const reconcile = vi.spyOn(h.sources[0]!.subscription, "reconcile");
    await h.write("replacement.json");
    await fs.rename(h.p("replacement.json"), h.p("openclaw.json"));
    events.mock.calls[0]![1]("openclaw.json", "rename");
    await reconcile.mock.results.at(-1)!.value;
    await h.settle();
    expect(h.onChange).toHaveBeenCalledOnce();
    const close = events.mock.results[0]!.value.close;
    await h.adapter.stop();
    expect(close).toHaveBeenCalledOnce();
  });

  it("ignores inaccessible unused roots, then admits them when selected", async () => {
    const allowed = await fs.realpath(dirs.make("config-unused-include-root-"));
    const lstatSync = fsSync.lstatSync;
    const denied = vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      if (args[0] === allowed || args[0] === path.toNamespacedPath(allowed)) {
        throw Object.assign(new Error("EACCES: unused config include root"), { code: "EACCES" });
      }
      return Reflect.apply(lstatSync, fsSync, args);
    });
    const h = await fixture({ includeRoots: [allowed] });
    await h.write("openclaw.json");
    await h.expectChanges(1);
    h.expectHealthy();

    denied.mockRestore();
    const included = path.join(allowed, "selected.json");
    await fs.writeFile(included, "{}");
    await h.adapter.observePaths([included]);
    h.onChange.mockClear();
    await fs.writeFile(included, '{"included":true}');
    await h.expectChanges(1);
    h.expectHealthy();
  });

  it("settles edits, replacement, deletion and restore, and updates accepted scopes", async () => {
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    vi.stubEnv("CHOKIDAR_INTERVAL", undefined);
    const h = await fixture({ realMode: true });
    const subscription = h.sources[0]!.subscription;
    expect(subscription.health()).toMatchObject({ state: "ready", mode: "poll" });
    expect(h.onChange).not.toHaveBeenCalled();
    for (const name of ["openclaw.json", "accepted.json"]) {
      await h.write(name);
      await h.reconcile();
      const settled = vi.fn();
      const pending = h.adapter.whenSettled().then(settled);
      await h.settle(4);
      expect(h.onChange).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      await h.settle(1);
      await pending;
      expect(h.onChange).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledOnce();
      h.onChange.mockClear();
    }
    await h.write("atomic.tmp", '{"atomic":true}');
    await fs.rename(h.p("atomic.tmp"), h.p("openclaw.json"));
    await h.expectChanges(1);
    h.onChange.mockClear();
    await h.expectChanges(0);
    for (const restore of [false, true]) {
      if (restore) {
        await h.write("accepted.json", '{"restored":true}');
      } else {
        await fs.unlink(h.p("accepted.json"));
      }
      await h.expectChanges(1);
      h.onChange.mockClear();
    }
    await h.adapter.observePaths([h.p("candidate.json")]);
    h.onChange.mockClear();
    await h.write("candidate.json", "{}");
    await h.write("accepted.json", '{"retained":true}');
    await h.expectChanges(1);
    await h.adapter.acceptPaths([h.p("candidate.json")]);
    h.onChange.mockClear();
    await h.write("accepted.json", '{"retired":true}');
    await h.expectChanges(0);
    h.expectHealthy();
    await h.adapter.stop();
    expect(subscription.health().state).toBe("closed");
  });

  it.each(["stop", "read failure"])("releases a pending stability join on %s", async (reason) => {
    const h = await fixture();
    await h.write("openclaw.json");
    await h.reconcile();
    const settled = vi.fn();
    const pending = h.adapter.whenSettled().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    if (reason === "stop") {
      await h.adapter.stop();
      await pending;
    } else {
      vi.mocked(snapshots.readObservationSnapshot).mockRejectedValueOnce(
        new Error("file metadata unavailable"),
      );
      await h.settle(1);
      await pending;
      await h.adapter.whenSettled();
      expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining("file metadata unavailable"));
      adapters.delete(h.adapter);
      await expect(h.adapter.stop()).rejects.toThrow("Config watcher shutdown failed");
    }
    expect(settled).toHaveBeenCalledOnce();
    expect(h.onChange).not.toHaveBeenCalled();
  });

  it("observes repaired includes without following unadmitted links or directory children", async () => {
    const h = await fixture();
    const outside = await fs.realpath(dirs.make("config-unadmitted-"));
    await fs.writeFile(path.join(outside, "secret.json"), "private");
    await fs.symlink(outside, h.p("linked"), process.platform === "win32" ? "junction" : "dir");
    await fs.mkdir(h.p("rejected-directory"));
    await h.adapter.observePaths([
      h.p("linked/include.json"),
      h.p("rejected-directory"),
      h.p("a".repeat(256) + ".json"),
      path.join(outside, "secret.json"),
    ]);
    h.onChange.mockClear();
    await fs.writeFile(path.join(outside, "include.json"), "{}");
    await h.write("rejected-directory/child.json", "{}");
    await h.expectChanges(0);
    expect(h.adapter.status()).toBe("active");
    await fs.unlink(h.p("linked"));
    await fs.mkdir(h.p("linked"));
    await h.write("linked/include.json", "{}");
    await h.reconcile();
    // The link-to-directory transition replans the literal include scope.
    await h.adapter.observePaths([h.p("linked/include.json")]);
    expect(h.onChange).toHaveBeenCalled();
    h.onChange.mockClear();
    await h.write("linked/include.json", '{"repaired":true}');
    await h.expectChanges(1);
  });

  it.each([false, true])("notifies once after recovery (downtime edit: %s)", async (edit) => {
    const h = await fixture();
    await h.recover(500, "scan", edit ? () => h.write("openclaw.json") : undefined);
    expect(h.adapter.status()).toBe("active");
    expect(h.onChange).toHaveBeenCalledOnce();
    await h.expectChanges(1);
  });

  it.each([undefined, "false", "1"])(
    "bounds guarded-worker recovery and preserves polling override %s",
    async (setting) => {
      vi.stubEnv("CHOKIDAR_USEPOLLING", setting);
      vi.stubEnv("CHOKIDAR_INTERVAL", "250");
      const h = await fixture();
      expect(h.sources[0]!.options).toMatchObject({
        mode: "poll",
        intervalMs: 300_000,
        pollIntervalMs: setting === "1" ? 250 : 300_000,
      });
      const fail = () => failSource(h.sources.at(-1)!);
      for (const ms of [500, 2000, 5000]) {
        const current = await h.recover(ms, "scan");
        expect(current.options.mode).toBe("poll");
      }
      h.onChange.mockClear();
      fail();
      await h.sources.at(-1)!.subscription.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(h.adapter.status()).toBe("disabled");
      expect(h.onChange).toHaveBeenCalledOnce();
    },
  );

  it.each([undefined, "false"])(
    "preserves native notification fallback with override %s",
    async (setting) => {
      vi.stubEnv("CHOKIDAR_USEPOLLING", setting);
      vi.stubEnv("CHOKIDAR_INTERVAL", "250");
      const h = await fixture();
      for (const ms of [500, 2000, 5000]) {
        await h.recover(ms, "watch");
      }
      const fallback = setting === undefined ? h.nextSource() : undefined;
      failSource(h.sources.at(-1)!, "watch");
      await h.sources.at(-1)!.subscription.close();
      await vi.advanceTimersByTimeAsync(500);
      if (fallback) {
        const current = await fallback;
        await current.subscription.ready;
        expect(current.options).toMatchObject({ mode: "poll", pollIntervalMs: 250 });
        expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining("degrading to polling"));
      } else {
        expect(h.adapter.status()).toBe("disabled");
      }
    },
  );

  it("reconciles once when a failed watcher cannot retire", async () => {
    const h = await fixture();
    const previous = h.sources[0]!;
    vi.spyOn(previous.subscription, "close").mockRejectedValue(new Error("retirement failed"));
    failSource(previous);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.adapter.status()).toBe("disabled");
    expect(h.onChange).toHaveBeenCalledOnce();
    adapters.delete(h.adapter);
    await expect(h.adapter.stop()).rejects.toThrow("Config watcher shutdown failed");
  });

  it("admits a root-level config directory from its stable volume root", async () => {
    const directory = await fs.realpath(dirs.make("config-volume-root-"));
    const volumeRoot = path.parse(directory).root;
    const firstDirectory = path.relative(volumeRoot, directory).split(path.sep)[0]!;
    const configPath = path.join(volumeRoot, firstDirectory, `${path.basename(directory)}.json`);
    const admitted = await admitConfigObservationRoots(configPath, []);

    expect(admitted.find((entry) => entry.primary)?.authority.rootDir).toBe(volumeRoot);
  });

  it("pins configured alias boundaries and the identity of admitted Roots", async () => {
    const directory = await fs.realpath(dirs.make("config-root-admission-"));
    const first = path.join(directory, "first");
    const second = path.join(directory, "second");
    const config = path.join(directory, "config");
    await Promise.all([first, second, config].map((dir) => fs.mkdir(dir)));
    const alias = path.join(directory, "allowed");
    await fs.symlink(first, alias, process.platform === "win32" ? "junction" : "dir");
    const cache: Parameters<typeof admitConfigObservationRoots>[2] = {
      roots: new Map(),
      canonicalBoundaries: new Map(),
    };
    const configPath = path.join(config, "openclaw.json");
    const before = await admitConfigObservationRoots(configPath, [alias], cache);
    await fs.unlink(alias);
    await fs.symlink(second, alias, process.platform === "win32" ? "junction" : "dir");
    const after = await admitConfigObservationRoots(configPath, [alias], cache);
    const candidates = new Set([first, second].map((dir) => path.join(dir, "include.json")));
    expect(
      after.flatMap((owner) => [...configObservationEntries(owner, candidates).values()]),
    ).toEqual([path.join(first, "include.json")]);
    expect(after.map((owner) => owner.authority)).toEqual(before.map((owner) => owner.authority));
    const missing = path.join(directory, "stable", "missing", "openclaw.json");
    await fs.mkdir(path.dirname(path.dirname(missing)));
    const [owner] = await admitConfigObservationRoots(missing, [], cache);
    await fs.rename(owner!.authority.rootDir, `${owner!.authority.rootDir}-old`);
    await fs.mkdir(owner!.authority.rootDir);
    const [replacement] = await admitConfigObservationRoots(missing, [], cache);
    expect(replacement!.authority).toBe(owner!.authority);
  });
});
