import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as observation from "@openclaw/fs-safe/watch";
import { expectDefined } from "@openclaw/normalization-core";
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
    const cwd = temp.make("source-owner-");
    const outside = temp.make("source-owner-target-");
    await fs.mkdir(path.join(cwd, "src", "node_modules"), { recursive: true });
    await fs.mkdir(path.join(outside, "first"));
    await fs.mkdir(path.join(outside, "second"));
    await fs.writeFile(path.join(cwd, "src", "first.ts"), "before one");
    await fs.writeFile(path.join(cwd, "src", "second.ts"), "before two");
    await fs.writeFile(path.join(cwd, "package.json"), "{}");
    await fs.writeFile(path.join(outside, "first", "main.ts"), "before linked edit");
    const alias = path.join(cwd, "src", "linked");
    await directoryLink(path.join(outside, "first"), alias);
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
        writeFileSync(path.join(cwd, "src", "first.ts"), "edit during admission");
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
    await expectChange(path.join(cwd, "src", "first.ts"));
    expect(onLog).toHaveBeenCalledExactlyOnceWith("Watching sources (poll).");
    resetChange();
    reads.length = 0;

    await fs.writeFile(path.join(cwd, "src", "first.ts"), "one");
    await fs.writeFile(path.join(cwd, "src", "second.ts"), "two");
    await repository.reconcile();
    await changed.promise;
    expect(onChange).toHaveBeenCalledOnce();
    expect(reads.toSorted()).toEqual([
      path.join(cwd, "src", "first.ts"),
      path.join(cwd, "src", "second.ts"),
    ]);
    resetChange();
    await fs.writeFile(path.join(cwd, "src", "ignored.test.ts"), "test");
    await fs.writeFile(path.join(cwd, "src", "node_modules", "ignored.ts"), "dependency");
    await repository.reconcile();
    expect(onChange).not.toHaveBeenCalled();

    const target = await targetReady.promise;
    await fs.writeFile(path.join(outside, "first", "main.ts"), "linked source");
    await target.reconcile();
    await expectChange(path.join(alias, "main.ts"));

    const replaced = createDeferredCore();
    const setScopes = target.setScopes.bind(target);
    vi.spyOn(target, "setScopes").mockImplementation(async (scopes) => {
      await setScopes(scopes);
      replaced.resolve();
    });
    resetChange();
    await fs.unlink(alias);
    await directoryLink(path.join(outside, "second"), alias);
    await repository.reconcile();
    await replaced.promise;
    await expectChange(path.join(alias, "main.ts"));
    resetChange();
    await fs.writeFile(path.join(outside, "first", "retired.ts"), "old target");
    await fs.writeFile(path.join(outside, "second", "current.ts"), "new target");
    await target.reconcile();
    await expectChange(path.join(alias, "current.ts"));
    resetChange();
    reads.length = 0;
    await fs.writeFile(path.join(cwd, "package.json"), "{}");
    invalidate!({ reason: "overflow" });
    await repository.reconcile();
    expect(onChange).not.toHaveBeenCalled();
    // Reconciliation does not join the observer's pending overflow read.
    const nextPackage = path.join(cwd, "package.json.next");
    await fs.writeFile(nextPackage, '{"private":true}');
    await fs.rename(nextPackage, path.join(cwd, "package.json"));
    invalidate!({ reason: "overflow" });
    await expectChange(path.join(cwd, "package.json"));
    expect(reads).toContain(path.join(cwd, "package.json"));
    expect(reads).toContain(path.join(cwd, "src", "first.ts"));
    resetChange();
    await fs.writeFile(path.join(cwd, "src", "new.ts"), "new source");
    invalidate!({ reason: "event", changes: [{ path: "src/new.ts", type: "content" }] });
    await expectChange(path.join(cwd, "src", "new.ts"));
    expect(onError).not.toHaveBeenCalled();

    await observer.close();
    expect(subscriptions.every((subscription) => subscription.health().state === "closed")).toBe(
      true,
    );
  });

  it("retires observation after source authority loss", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const cwd = temp.make("source-owner-loss-");
    await fs.mkdir(path.join(cwd, "src"));
    const source = path.join(cwd, "src", "main.ts");
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
async function discoveryFixture() {
  const cwd = temp.make("source-repo-");
  const outside = temp.make("source-target-");
  await fs.mkdir(path.join(cwd, "src"));
  const discovery = createSourceTargetDiscovery(cwd, ["src"], ignored);
  return {
    cwd,
    outside,
    alias: path.join(cwd, "src", "linked"),
    discover: () => discovery.discover(signal()),
  };
}

describe("developer source discovery", () => {
  it("rediscovers file-to-directory replacement during hashing", async () => {
    const { cwd, discover } = await discoveryFixture();
    const source = path.join(cwd, "src", "main.ts");
    await fs.writeFile(source, "original source");
    const initial = await discover();
    const authority = expectDefined(initial[0], "admitted observation").authority;
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
    const { outside, alias, discover } = await discoveryFixture();
    const initial = await discover();
    const destination = path.join(outside, "missing", "deep");
    await directoryLink(destination, alias);
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
    await directoryLink(path.join(outside, "second"), alias);
    const retargeted = await discover();
    expect(expectDefined(retargeted[0], "admitted observation").authority).toBe(
      expectDefined(initial[0], "admitted observation").authority,
    );
    expect(expectDefined(retargeted[1], "admitted observation").authority).toBe(
      expectDefined(dangling[1], "admitted observation").authority,
    );
    expect(mapped(retargeted, path.join(destination, "main.ts"))).toEqual([]);
    expect(mapped(retargeted, path.join(outside, "second", "main.ts"))).toContain(
      path.join(alias, "main.ts"),
    );
    await fs.unlink(alias);
    expect(await discover()).toHaveLength(1);
  });

  it("rejects replaced authority after alias removal", async () => {
    const { outside, alias, discover } = await discoveryFixture();
    const boundary = path.join(outside, "boundary");
    await fs.mkdir(path.join(boundary, "source"), { recursive: true });
    await directoryLink(path.join(boundary, "source"), alias);
    await discover();
    await fs.unlink(alias);
    await discover();
    await fs.rename(boundary, boundary + "-retired");
    await fs.mkdir(path.join(boundary, "source"), { recursive: true });
    await directoryLink(path.join(boundary, "source"), alias);
    await expect(discover()).rejects.toThrow();
  });

  it("bounds lifetime Root admission and reuses prior authority", async () => {
    const { outside, alias, discover } = await discoveryFixture();
    let first: SourceTargetGroup[] | undefined;
    for (let index = 0; index < 128; index++) {
      const destination = path.join(outside, String(index), "source");
      await fs.mkdir(destination, { recursive: true });
      await directoryLink(destination, alias);
      if (index === 127) {
        await expect(discover()).rejects.toThrow("lifetime Root budget");
      } else {
        const groups = await discover();
        first ??= groups;
      }
      await fs.unlink(alias);
    }
    await directoryLink(path.join(outside, "0", "source"), alias);
    const reused = await discover();
    expect(authorities(reused)).toEqual(authorities(first!));
  });

  // Windows junction creation normalizes parent components before storing the target.
  it.skipIf(process.platform === "win32")(
    "resolves symlink parents and retains dangling prefixes",
    async () => {
      const { outside, alias, discover } = await discoveryFixture();
      await fs.mkdir(path.join(outside, "actual", "child"), { recursive: true });
      await fs.mkdir(path.join(outside, "actual", "source"));
      await fs.mkdir(path.join(outside, "source"));
      await fs.writeFile(path.join(outside, "actual", "source", "main.ts"), "actual");
      await fs.writeFile(path.join(outside, "source", "wrong.ts"), "lexically collapsed");
      const intermediate = path.join(outside, "intermediate");
      await directoryLink(path.join(outside, "actual", "child"), intermediate);
      await directoryLink(intermediate + "/../source", alias);
      const discovered = await discover();
      expect(await fs.readdir(alias)).toEqual(["main.ts"]);
      expect(filesIn(discovered)).toEqual([path.join(alias, "main.ts")]);
      expect(mapped(discovered, intermediate)).toContain(alias);
      await fs.unlink(intermediate);
      const dangling = await discover();
      expect(filesIn(dangling)).toEqual([]);
      expect(mapped(dangling, intermediate)).toContain(alias);
      await directoryLink(path.join(outside, "actual", "child"), intermediate);
      const restored = await discover();
      expect(filesIn(restored)).toEqual([path.join(alias, "main.ts")]);
    },
  );

  it("observes symbolic destination parents", async () => {
    const { outside, alias, discover } = await discoveryFixture();
    await fs.mkdir(path.join(outside, "actual", "deep"), { recursive: true });
    await directoryLink(path.join(outside, "actual"), path.join(outside, "alias"));
    await directoryLink(path.join(outside, "alias", "deep"), alias);
    const groups = await discover();
    expect(mapped(groups, path.join(outside, "alias"))).toContain(alias);
    expect(mapped(groups, path.join(outside, "actual", "deep", "main.ts"))).toContain(
      path.join(alias, "main.ts"),
    );
  });
});
