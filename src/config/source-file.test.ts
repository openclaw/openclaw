import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as observation from "@openclaw/fs-safe/watch";
import type { WatchOptions, WatchSubscription } from "@openclaw/fs-safe/watch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as snapshots from "../infra/fs-observation-snapshot.js";
import { admitConfigObservationRoots, configObservationEntries } from "./source-file-roots.js";
import { createConfigFileAdapter } from "./source-file.js";

vi.mock("@openclaw/fs-safe/watch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/watch")>()),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const adapters = new Set<ReturnType<typeof createConfigFileAdapter>>();
afterEach(async () => {
  await Promise.all([...adapters].map((adapter) => adapter.stop()));
  adapters.clear();
  vi.restoreAllMocks();
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
  const directory = await fs.realpath(dirs.make("config-observation-"));
  const p = (name: string) => path.join(directory, name);
  await fs.writeFile(p("openclaw.json"), "{}");
  await fs.writeFile(p("accepted.json"), "{}");
  vi.useFakeTimers();
  const sampling: Promise<unknown>[] = [];
  const readSnapshot = snapshots.readObservationSnapshot;
  vi.spyOn(snapshots, "readObservationSnapshot").mockImplementation((...args) => {
    const sample = readSnapshot(...args);
    sampling.push(sample);
    return sample;
  });
  const sources: Array<{ subscription: WatchSubscription; options: WatchOptions }> = [];
  let installed: ((source: (typeof sources)[number]) => void) | undefined;
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
    includeRoots,
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
    new Promise<(typeof sources)[number]>((resolve) => {
      installed = resolve;
    });
  const expectChanges = async (count: number) => {
    await reconcile();
    await settle();
    expect(onChange).toHaveBeenCalledTimes(count);
  };
  const expectHealthy = () => {
    expect(adapter.status()).toBe("active");
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  };
  return {
    adapter,
    p,
    sources,
    onChange,
    log,
    reconcile,
    settle,
    nextSource,
    expectChanges,
    expectHealthy,
  };
}

describe("config file observation", () => {
  it("keeps primary edits observable when an unused include root is inaccessible and admits it on selection", async () => {
    const allowed = await fs.realpath(dirs.make("config-unused-include-root-"));
    const inaccessible = Object.assign(new Error("EACCES: unused config include root"), {
      code: "EACCES",
    });
    const lstatSync = fsSync.lstatSync;
    const denied = vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      if (args[0] === allowed || args[0] === path.toNamespacedPath(allowed)) {
        throw inaccessible;
      }
      return Reflect.apply(lstatSync, fsSync, args);
    });
    const h = await fixture({ includeRoots: [allowed] });
    await fs.writeFile(h.p("openclaw.json"), '{"primary":true}');
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

  it("settles primary/includes, atomic replacements, deletion and restore, and updates accepted scopes in place", async () => {
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    vi.stubEnv("CHOKIDAR_INTERVAL", undefined);
    const h = await fixture({ realMode: true });
    expect(h.sources).toHaveLength(1);
    const subscription = h.sources[0]!.subscription;
    expect(subscription.health()).toMatchObject({ state: "ready", mode: "poll" });
    expect(h.onChange).not.toHaveBeenCalled();
    for (const name of ["openclaw.json", "accepted.json"]) {
      await fs.writeFile(h.p(name), '{"changed":true}');
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
    await fs.writeFile(h.p("atomic.tmp"), '{"atomic":true}');
    await fs.rename(h.p("atomic.tmp"), h.p("openclaw.json"));
    await h.expectChanges(1);
    h.onChange.mockClear();
    await h.expectChanges(0);
    for (const restore of [false, true]) {
      if (restore) {
        await fs.writeFile(h.p("accepted.json"), '{"restored":true}');
      } else {
        await fs.unlink(h.p("accepted.json"));
      }
      await h.expectChanges(1);
      h.onChange.mockClear();
    }
    const setScopes = vi.spyOn(subscription, "setScopes");
    await h.adapter.observePaths([h.p("candidate.json")]);
    expect(setScopes).toHaveBeenCalledOnce();
    expect(h.sources).toHaveLength(1);
    h.onChange.mockClear();
    await fs.writeFile(h.p("candidate.json"), "{}");
    await fs.writeFile(h.p("accepted.json"), '{"retained":true}');
    await h.expectChanges(1);
    await h.adapter.acceptPaths([h.p("candidate.json")]);
    h.onChange.mockClear();
    await fs.writeFile(h.p("accepted.json"), '{"retired":true}');
    await h.expectChanges(0);
    expect(h.sources).toHaveLength(1);
    h.expectHealthy();
    await h.adapter.stop();
    expect(subscription.health().state).toBe("closed");
  });

  it.each(["stop", "read failure"])("releases a pending stability join on %s", async (reason) => {
    const h = await fixture();
    await fs.writeFile(h.p("openclaw.json"), '{"changed":true}');
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

  it("observes repairable rejected includes without following unadmitted links or directory children", async () => {
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
    await fs.writeFile(h.p("rejected-directory/child.json"), "{}");
    await h.expectChanges(0);
    expect(h.adapter.status()).toBe("active");
    await fs.unlink(h.p("linked"));
    await fs.mkdir(h.p("linked"));
    await fs.writeFile(h.p("linked/include.json"), "{}");
    await h.reconcile();
    // The link-to-directory transition replans the literal include scope.
    await h.adapter.observePaths([h.p("linked/include.json")]);
    expect(h.onChange).toHaveBeenCalled();
    h.onChange.mockClear();
    await fs.writeFile(h.p("linked/include.json"), '{"repaired":true}');
    await h.expectChanges(1);
  });

  it.each([undefined, "false", "1"])(
    "bounds watch-limit recovery and preserves polling override %s",
    async (setting) => {
      vi.stubEnv("CHOKIDAR_USEPOLLING", setting);
      vi.stubEnv("CHOKIDAR_INTERVAL", "250");
      const h = await fixture();
      const initialMode = setting === "1" ? "poll" : "auto";
      expect(h.sources[0]!.options).toMatchObject({
        mode: initialMode,
        intervalMs: 300_000,
        pollIntervalMs: 250,
      });
      const fail = () => {
        const { options } = h.sources.at(-1)!;
        options.onHealth?.({
          state: "unavailable",
          mode: options.mode === "poll" ? "poll" : "events",
          directories: 0,
          failure: {
            operation: "watch",
            code: "watch-limit",
            error: new Error("watch limit reached"),
          },
        });
      };
      for (const ms of [500, 2000, 5000]) {
        const previous = h.sources.at(-1)!;
        const installed = h.nextSource();
        fail();
        await previous.subscription.close();
        await vi.advanceTimersByTimeAsync(ms);
        const current = await installed;
        await current.subscription.ready;
        expect(current.options.mode).toBe(initialMode);
      }
      const fallback = setting === undefined ? h.nextSource() : undefined;
      vi.stubEnv("CHOKIDAR_USEPOLLING", setting === undefined ? "false" : undefined);
      fail();
      await h.sources.at(-1)!.subscription.close();
      await vi.advanceTimersByTimeAsync(500);
      if (setting === undefined) {
        const current = await fallback!;
        await current.subscription.ready;
        expect(current.options.mode).toBe("poll");
        expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining("degrading to polling"));
      } else {
        expect(h.adapter.status()).toBe("disabled");
        expect(h.sources).toHaveLength(4);
        expect(h.log.warn).not.toHaveBeenCalledWith(
          expect.stringContaining("degrading to polling"),
        );
      }
    },
  );

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
