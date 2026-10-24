import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as observation from "@openclaw/fs-safe/watch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceObserver } from "../../scripts/watch-node-observation.mts";
import {
  createSourceTargetDiscovery,
  sourceTargetPaths,
  type SourceTargetGroup,
} from "../../scripts/watch-node-source-targets.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";

// Root and watch must share the external package's module registry.
vi.mock("@openclaw/fs-safe/watch", async () => {
  const { createRequire } = await import("node:module");
  return { ...createRequire(import.meta.url)("@openclaw/fs-safe/watch") };
});
const temp = useAutoCleanupTempDirTracker(afterEach);
const observers: Array<ReturnType<typeof createSourceObserver>> = [];
afterEach(async () => {
  await Promise.all(observers.splice(0).map((observer) => observer.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function directoryLink(target: string, link: string) {
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

describe("developer source observation", () => {
  it("batches edits and follows links without baseline restarts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { cwd, outside, src, target, alias, pointTo } = await sourceFixture();
    const first = src("first.ts"),
      second = src("second.ts"),
      pkg = path.join(cwd, "package.json");
    await fs.mkdir(src("node_modules"));
    await fs.mkdir(target("first"));
    await fs.mkdir(target("second"));
    await fs.writeFile(first, "before one");
    await fs.writeFile(second, "before two");
    await fs.writeFile(pkg, "{}");
    await fs.writeFile(target("first/main.ts"), "before linked edit");
    await pointTo(target("first"));
    const subscriptions: observation.WatchSubscription[] = [];
    const reads: string[] = [];
    const rereadStarted = createDeferredCore();
    const releaseReread = createDeferredCore();
    let holdReread = true;
    const targetReady = createDeferredCore<observation.WatchSubscription>();
    let invalidate: observation.WatchOptions["onInvalidate"];
    const original = observation.watch;
    vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
      const open = authority.open.bind(authority);
      vi.spyOn(authority, "open").mockImplementation(async (relative, settings) => {
        reads.push(path.resolve(authority.rootReal, relative));
        if (holdReread) {
          holdReread = false;
          rereadStarted.resolve();
          await releaseReread.promise;
        }
        return await open(relative, settings);
      });
      const subscription = original(authority, options);
      if (subscriptions.length === 0) {
        invalidate = options.onInvalidate;
        writeFileSync(first, "edit during admission");
      }
      subscriptions.push(subscription);
      if (authority.rootReal === outside) {
        targetReady.resolve(subscription);
      }
      return subscription;
    });
    let changed = createDeferredCore<string | undefined>();
    const onChange = vi.fn((name?: string) => changed.resolve(name));
    const resetChange = () => {
      onChange.mockClear();
      changed = createDeferredCore<string | undefined>();
    };
    const expectChange = async (name: string) => {
      await changed.promise;
      expect(onChange).toHaveBeenCalledExactlyOnceWith(name);
      resetChange();
    };
    const onError = vi.fn();
    const onLog = vi.fn();
    const observer = createSourceObserver(["src", "package.json"], {
      cwd,
      env: { CHOKIDAR_USEPOLLING: "1", CHOKIDAR_INTERVAL: "250" },
      ignored,
      onChange,
      onError,
      onLog,
    });
    observers.push(observer);
    const admitted = vi.fn();
    void observer.ready.then(admitted, () => {});
    try {
      await rereadStarted.promise;
      expect(admitted).toHaveBeenCalledOnce();
      expect(onLog).toHaveBeenCalledExactlyOnceWith("Watching sources (poll).");
    } finally {
      releaseReread.resolve();
    }
    await observer.ready;
    const repository = subscriptions[0]!;
    await expectChange(first);
    expect(onLog).toHaveBeenCalledExactlyOnceWith("Watching sources (poll).");
    reads.length = 0;

    await fs.writeFile(first, "one");
    await fs.writeFile(second, "two");
    await repository.reconcile();
    await changed.promise;
    expect(onChange).toHaveBeenCalledOnce();
    expect(reads.toSorted()).toEqual([first, second]);
    resetChange();
    await fs.writeFile(src("ignored.test.ts"), "test");
    await fs.writeFile(src("node_modules/ignored.ts"), "dependency");
    await repository.reconcile();
    expect(onChange).not.toHaveBeenCalled();

    const linked = await targetReady.promise;
    await fs.writeFile(target("first/main.ts"), "linked source");
    await linked.reconcile();
    await expectChange(path.join(alias, "main.ts"));

    const replaced = createDeferredCore();
    const setScopes = linked.setScopes.bind(linked);
    vi.spyOn(linked, "setScopes").mockImplementation(async (scopes) => {
      await setScopes(scopes);
      replaced.resolve();
    });
    await fs.unlink(alias);
    await pointTo(target("second"));
    await repository.reconcile();
    await replaced.promise;
    await expectChange(path.join(alias, "main.ts"));
    await fs.writeFile(target("first/retired.ts"), "old target");
    await fs.writeFile(target("second/current.ts"), "new target");
    await linked.reconcile();
    await expectChange(path.join(alias, "current.ts"));
    reads.length = 0;
    await fs.writeFile(pkg, "{}");
    invalidate!({ reason: "overflow" });
    await repository.reconcile();
    expect(onChange).not.toHaveBeenCalled();
    // Reconciliation does not join the observer's pending overflow read.
    const nextPackage = path.join(cwd, "package.json.next");
    await fs.writeFile(nextPackage, '{"private":true}');
    await fs.rename(nextPackage, pkg);
    invalidate!({ reason: "overflow" });
    await expectChange(pkg);
    expect(reads).toEqual(expect.arrayContaining([pkg, first]));
    await fs.writeFile(src("new.ts"), "new source");
    invalidate!({ reason: "event", changes: [{ path: "src/new.ts", type: "content" }] });
    await expectChange(src("new.ts"));
    expect(onError).not.toHaveBeenCalled();

    await observer.close();
    expect(subscriptions.every((subscription) => subscription.health().state === "closed")).toBe(
      true,
    );
  });

  it("retires observation after source authority loss", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { cwd, src } = await sourceFixture();
    const source = src("main.ts");
    await fs.writeFile(source, "before admission");
    const changed = createDeferredCore<string | undefined>();
    let subscription: observation.WatchSubscription | undefined;
    const original = observation.watch;
    vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
      writeFileSync(source, "during admission");
      subscription = original(authority, options);
      return subscription;
    });
    const onError = vi.fn();
    const observer = createSourceObserver(["src"], {
      cwd,
      env: { CHOKIDAR_USEPOLLING: "1" },
      ignored: () => false,
      onChange: (name) => changed.resolve(name),
      onError,
    });
    observers.push(observer);
    await observer.ready;
    expect(await changed.promise).toBe(source);
    await fs.rm(cwd, { recursive: true });
    await expect(subscription!.reconcile()).rejects.toThrow();
    await observer.close();
    expect(onError).toHaveBeenCalledOnce();
    expect(subscription!.health().state).toBe("closed");
  });
});

const signal = () => new AbortController().signal;
const ignored = (name: string) =>
  name.endsWith(".test.ts") || name.split(path.sep).includes("node_modules");
function mapped(groups: SourceTargetGroup[], physical: string) {
  return groups.flatMap((group) =>
    sourceTargetPaths(group, path.relative(group.authority.rootReal, physical)),
  );
}
const authorities = (groups: SourceTargetGroup[]) => groups.map((group) => group.authority);
const filesIn = (groups: SourceTargetGroup[]) => groups.flatMap((group) => [...group.files.keys()]);
async function sourceFixture() {
  const cwd = temp.make("source-repo-");
  const outside = temp.make("source-target-");
  const src = (relative: string) => path.join(cwd, "src", relative);
  const target = (relative: string) => path.join(outside, relative);
  const alias = src("linked");
  await fs.mkdir(src(""));
  const discovery = createSourceTargetDiscovery(cwd, ["src"], ignored);
  return {
    cwd,
    outside,
    src,
    target,
    alias,
    discover: () => discovery.discover(signal()),
    pointTo: (destination: string) => directoryLink(destination, alias),
  };
}

describe("developer source discovery", () => {
  it("rediscovers file-to-directory replacement during hashing", async () => {
    const { src, discover } = await sourceFixture();
    const source = src("main.ts");
    await fs.writeFile(source, "original source");
    const authority = (await discover())[0]!.authority;
    const open = authority.open.bind(authority);
    vi.spyOn(authority, "open").mockImplementationOnce(async (relative, settings) => {
      await fs.unlink(source);
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, "child.ts"), "replacement source");
      const opening = open(relative, settings);
      await expect(opening).rejects.toMatchObject({ code: "not-file" });
      return await opening;
    });

    const current = await discover();
    expect(current).toHaveLength(1);
    expect(filesIn(current)).toEqual([path.join(source, "child.ts")]);
  });

  it("pins Roots across link lifecycle changes", async () => {
    const { target, alias, discover, pointTo } = await sourceFixture();
    const initial = await discover();
    const destination = target("missing/deep");
    await pointTo(destination);
    const dangling = await discover();
    expect(dangling).toHaveLength(2);
    expect(mapped(dangling, path.join(destination, "main.ts"))).toContain(
      path.join(alias, "main.ts"),
    );
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, "main.ts"), "first");
    const created = await discover();
    expect(authorities(created)).toEqual(authorities(dangling));
    await fs.unlink(alias);
    await pointTo(target("second"));
    const retargeted = await discover();
    expect(retargeted[0]!.authority).toBe(initial[0]!.authority);
    expect(retargeted[1]!.authority).toBe(dangling[1]!.authority);
    expect(mapped(retargeted, path.join(destination, "main.ts"))).toEqual([]);
    expect(mapped(retargeted, target("second/main.ts"))).toContain(path.join(alias, "main.ts"));
    await fs.unlink(alias);
    expect(await discover()).toHaveLength(1);
  });

  it("rejects replaced authority after alias removal", async () => {
    const { target, alias, discover, pointTo } = await sourceFixture();
    const boundary = target("boundary");
    await fs.mkdir(path.join(boundary, "source"), { recursive: true });
    await pointTo(path.join(boundary, "source"));
    await discover();
    await fs.unlink(alias);
    await discover();
    await fs.rename(boundary, boundary + "-retired");
    await fs.mkdir(path.join(boundary, "source"), { recursive: true });
    await pointTo(path.join(boundary, "source"));
    await expect(discover()).rejects.toThrow();
  });

  it("bounds lifetime Root admission and reuses prior authority", async () => {
    const { target, alias, discover, pointTo } = await sourceFixture();
    let first: SourceTargetGroup[] | undefined;
    for (let index = 0; index < 128; index++) {
      const destination = target(`${index}/source`);
      await fs.mkdir(destination, { recursive: true });
      await pointTo(destination);
      if (index === 127) {
        await expect(discover()).rejects.toThrow("lifetime Root budget");
      } else {
        const groups = await discover();
        first ??= groups;
      }
      await fs.unlink(alias);
    }
    await pointTo(target("0/source"));
    const reused = await discover();
    expect(authorities(reused)).toEqual(authorities(first!));
  });

  // Windows junction creation normalizes parent components before storing the target.
  it.skipIf(process.platform === "win32")(
    "resolves symlink parents and retains dangling prefixes",
    async () => {
      const { target, alias, discover, pointTo } = await sourceFixture();
      await fs.mkdir(target("actual/child"), { recursive: true });
      await fs.mkdir(target("actual/source"));
      await fs.mkdir(target("source"));
      await fs.writeFile(target("actual/source/main.ts"), "actual");
      await fs.writeFile(target("source/wrong.ts"), "lexically collapsed");
      const intermediate = target("intermediate");
      await directoryLink(target("actual/child"), intermediate);
      await pointTo(intermediate + "/../source");
      const discovered = await discover();
      expect(await fs.readdir(alias)).toEqual(["main.ts"]);
      expect(filesIn(discovered)).toEqual([path.join(alias, "main.ts")]);
      expect(mapped(discovered, intermediate)).toContain(alias);
      await fs.unlink(intermediate);
      const dangling = await discover();
      expect(filesIn(dangling)).toEqual([]);
      expect(mapped(dangling, intermediate)).toContain(alias);
      await directoryLink(target("actual/child"), intermediate);
      const restored = await discover();
      expect(filesIn(restored)).toEqual([path.join(alias, "main.ts")]);
    },
  );

  it("observes symbolic destination parents", async () => {
    const { target, alias, discover, pointTo } = await sourceFixture();
    await fs.mkdir(target("actual/deep"), { recursive: true });
    await directoryLink(target("actual"), target("alias"));
    await pointTo(target("alias/deep"));
    const groups = await discover();
    expect(mapped(groups, target("alias"))).toContain(alias);
    expect(mapped(groups, target("actual/deep/main.ts"))).toContain(path.join(alias, "main.ts"));
  });
});
