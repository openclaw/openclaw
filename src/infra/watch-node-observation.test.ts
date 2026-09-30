import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as observation from "@openclaw/fs-safe/watch";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceObserver } from "../../scripts/watch-node-observation.mts";
import {
  createSourceTargetDiscovery,
  excludeSourceTarget,
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
  it("batches source edits, excludes outputs, and follows trusted links without restarting for scope baselines", async () => {
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
    const onError = vi.fn();
    const onLog = vi.fn();
    const observer = createSourceObserver(["src", "package.json"], {
      cwd,
      env: { CHOKIDAR_USEPOLLING: "1", CHOKIDAR_INTERVAL: "250" },
      ignored: (name) => name.endsWith(".test.ts") || name.split(path.sep).includes("node_modules"),
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
    await changed.promise;
    const repository = subscriptions[0]!;
    expect(onChange).toHaveBeenCalledExactlyOnceWith(path.join(cwd, "src", "first.ts"));
    expect(onLog).toHaveBeenCalledExactlyOnceWith("Watching sources (poll).");
    onChange.mockClear();
    changed = createDeferredCore<string | undefined>();
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
    onChange.mockClear();
    changed = createDeferredCore<string | undefined>();
    await fs.writeFile(path.join(cwd, "src", "ignored.test.ts"), "test");
    await fs.writeFile(path.join(cwd, "src", "node_modules", "ignored.ts"), "dependency");
    await repository.reconcile();
    expect(onChange).not.toHaveBeenCalled();
    // OS overflow can discard detail for excluded output activity. It must not
    // restart the child unless the selected bytes changed.
    invalidate!({ reason: "overflow" });
    invalidate!({ reason: "event" });
    invalidate!({
      reason: "event",
      changes: [
        { path: "src/node_modules/ignored.ts", type: "content" },
        { path: "dist/entry.js", type: "content" },
      ],
    });

    const target = await targetReady.promise;
    await fs.writeFile(path.join(outside, "first", "main.ts"), "linked source");
    await target.reconcile();
    await changed.promise;
    expect(onChange).toHaveBeenCalledExactlyOnceWith(path.join(alias, "main.ts"));
    expect(reads).toContain(path.join(cwd, "package.json"));
    expect(reads).toContain(path.join(cwd, "src", "first.ts"));

    const replaced = createDeferredCore();
    const setScopes = target.setScopes.bind(target);
    vi.spyOn(target, "setScopes").mockImplementation(async (scopes) => {
      await setScopes(scopes);
      replaced.resolve();
    });
    onChange.mockClear();
    changed = createDeferredCore<string | undefined>();
    await fs.unlink(alias);
    await directoryLink(path.join(outside, "second"), alias);
    await repository.reconcile();
    await replaced.promise;
    await changed.promise;
    expect(onChange).toHaveBeenCalledExactlyOnceWith(path.join(alias, "main.ts"));
    onChange.mockClear();
    changed = createDeferredCore<string | undefined>();
    await fs.writeFile(path.join(outside, "first", "retired.ts"), "old target");
    await fs.writeFile(path.join(outside, "second", "current.ts"), "new target");
    await target.reconcile();
    await changed.promise;
    expect(onChange).toHaveBeenCalledExactlyOnceWith(path.join(alias, "current.ts"));
    onChange.mockClear();
    changed = createDeferredCore<string | undefined>();
    await fs.writeFile(path.join(cwd, "src", "first.ts"), "one");
    await repository.reconcile();
    await fs.writeFile(path.join(cwd, "package.json"), '{"private":true}');
    invalidate!({ reason: "overflow" });
    await changed.promise;
    expect(onChange).toHaveBeenCalledExactlyOnceWith(path.join(cwd, "package.json"));
    onChange.mockClear();
    changed = createDeferredCore<string | undefined>();
    await fs.writeFile(path.join(cwd, "src", "new.ts"), "new source");
    invalidate!({ reason: "event", changes: [{ path: "src/new.ts", type: "content" }] });
    await changed.promise;
    expect(onChange).toHaveBeenCalledExactlyOnceWith(path.join(cwd, "src", "new.ts"));
    expect(onError).not.toHaveBeenCalled();

    await observer.close();
    expect(subscriptions.every((subscription) => subscription.health().state === "closed")).toBe(
      true,
    );
  });

  it("reports lost source authority and retires observation before close completes", async () => {
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

describe("developer linked-source admission", () => {
  it("follows an intermediate package alias, groups shared targets, and filters lexically", async () => {
    const cwd = temp.make("source-repo-");
    const outside = temp.make("source-target-");
    await fs.mkdir(path.join(cwd, "packages"));
    await fs.mkdir(path.join(outside, "foo", "src"), { recursive: true });
    await directoryLink(path.join(outside, "foo"), path.join(cwd, "packages", "foo"));
    await directoryLink(path.join(outside, "foo"), path.join(cwd, "packages", "bar"));
    const discovery = createSourceTargetDiscovery(
      cwd,
      ["packages/foo/src", "packages/bar/src"],
      ignored,
    );
    const groups = await discovery.discover(signal());
    expect(groups).toHaveLength(2);
    expect(expectDefined(groups[0], "admitted observation").scopes).toEqual([
      { path: "packages", kind: "tree", depth: 128 },
    ]);
    expect(mapped(groups, path.join(outside, "foo", "src", "main.ts"))).toEqual([
      path.join(cwd, "packages", "bar", "src", "main.ts"),
      path.join(cwd, "packages", "foo", "src", "main.ts"),
    ]);
    const external = groups.find((group) => group.authority.rootReal === outside)!;
    expect(
      excludeSourceTarget(
        external,
        { path: path.join("foo", "src", "skip.test.ts"), kind: "file" },
        ignored,
      ),
    ).toBe(true);
    expect(
      excludeSourceTarget(external, { path: path.join("foo", "other.ts"), kind: "file" }, ignored),
    ).toBe(true);
  });

  it("rebuilds link addition, retarget, removal, and dangling destination creation with pinned Roots", async () => {
    const cwd = temp.make("source-repo-");
    const outside = temp.make("source-target-");
    await fs.mkdir(path.join(cwd, "src"));
    const discovery = createSourceTargetDiscovery(cwd, ["src"], ignored);
    const initial = await discovery.discover(signal());
    const alias = path.join(cwd, "src", "linked");
    const destination = path.join(outside, "missing", "deep");
    await directoryLink(destination, alias);
    const dangling = await discovery.discover(signal());
    expect(dangling).toHaveLength(2);
    expect(mapped(dangling, path.join(destination, "main.ts"))).toContain(
      path.join(alias, "main.ts"),
    );
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, "main.ts"), "first");
    const created = await discovery.discover(signal());
    expect(created.map((group) => group.authority)).toEqual(
      dangling.map((group) => group.authority),
    );
    await fs.unlink(alias);
    await directoryLink(path.join(outside, "second"), alias);
    const retargeted = await discovery.discover(signal());
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
    expect(await discovery.discover(signal())).toHaveLength(1);
  });

  it("does not re-admit a replaced target authority, even after its last alias was removed", async () => {
    const cwd = temp.make("source-repo-");
    const outside = temp.make("source-target-");
    const boundary = path.join(outside, "boundary");
    await fs.mkdir(path.join(cwd, "src"));
    await fs.mkdir(path.join(boundary, "source"), { recursive: true });
    const alias = path.join(cwd, "src", "linked");
    await directoryLink(path.join(boundary, "source"), alias);
    const discovery = createSourceTargetDiscovery(cwd, ["src"], ignored);
    await discovery.discover(signal());
    await fs.unlink(alias);
    await discovery.discover(signal());
    await fs.rename(boundary, boundary + "-retired");
    await fs.mkdir(path.join(boundary, "source"), { recursive: true });
    await directoryLink(path.join(boundary, "source"), alias);
    await expect(discovery.discover(signal())).rejects.toThrow();
  });

  it("bounds lifetime Root admission across source retargets without discarding prior authority", async () => {
    const cwd = temp.make("source-repo-");
    const outside = temp.make("source-target-");
    await fs.mkdir(path.join(cwd, "src"));
    const alias = path.join(cwd, "src", "linked");
    const discovery = createSourceTargetDiscovery(cwd, ["src"], ignored);
    let first: SourceTargetGroup[] | undefined;
    for (let index = 0; index < 128; index++) {
      const destination = path.join(outside, String(index), "source");
      await fs.mkdir(destination, { recursive: true });
      await directoryLink(destination, alias);
      if (index === 127) {
        await expect(discovery.discover(signal())).rejects.toThrow("lifetime Root budget");
      } else {
        const groups = await discovery.discover(signal());
        first ??= groups;
      }
      await fs.unlink(alias);
    }
    await directoryLink(path.join(outside, "0", "source"), alias);
    const reused = await discovery.discover(signal());
    expect(reused.map((group) => group.authority)).toEqual(first!.map((group) => group.authority));
  });

  // Windows junction creation normalizes parent components before storing the target.
  it.skipIf(process.platform === "win32")(
    "resolves symlink targets before parent traversal and retains dangling prefixes",
    async () => {
      const cwd = temp.make("source-repo-");
      const outside = temp.make("source-target-");
      await fs.mkdir(path.join(cwd, "src"));
      await fs.mkdir(path.join(outside, "actual", "child"), { recursive: true });
      await fs.mkdir(path.join(outside, "actual", "source"));
      await fs.mkdir(path.join(outside, "source"));
      await fs.writeFile(path.join(outside, "actual", "source", "main.ts"), "actual");
      await fs.writeFile(path.join(outside, "source", "wrong.ts"), "lexically collapsed");
      const intermediate = path.join(outside, "intermediate");
      await directoryLink(path.join(outside, "actual", "child"), intermediate);
      const alias = path.join(cwd, "src", "linked");
      await directoryLink(intermediate + "/../source", alias);
      const discovery = createSourceTargetDiscovery(cwd, ["src"], ignored);
      const discovered = await discovery.discover(signal());
      expect(await fs.readdir(alias)).toEqual(["main.ts"]);
      expect(discovered.flatMap((group) => Array.from(group.files.keys()))).toEqual([
        path.join(alias, "main.ts"),
      ]);
      expect(mapped(discovered, intermediate)).toContain(alias);
      await fs.unlink(intermediate);
      const dangling = await discovery.discover(signal());
      expect(dangling.flatMap((group) => Array.from(group.files.keys()))).toEqual([]);
      expect(mapped(dangling, intermediate)).toContain(alias);
      await directoryLink(path.join(outside, "actual", "child"), intermediate);
      const restored = await discovery.discover(signal());
      expect(restored.flatMap((group) => Array.from(group.files.keys()))).toEqual([
        path.join(alias, "main.ts"),
      ]);
    },
  );

  it("keeps a symbolic parent of a declared destination observable", async () => {
    const cwd = temp.make("source-repo-");
    const outside = temp.make("source-target-");
    await fs.mkdir(path.join(cwd, "src"));
    await fs.mkdir(path.join(outside, "actual", "deep"), { recursive: true });
    await directoryLink(path.join(outside, "actual"), path.join(outside, "alias"));
    await directoryLink(path.join(outside, "alias", "deep"), path.join(cwd, "src", "linked"));
    const discovery = createSourceTargetDiscovery(cwd, ["src"], ignored);
    const groups = await discovery.discover(signal());
    expect(mapped(groups, path.join(outside, "alias"))).toContain(path.join(cwd, "src", "linked"));
    expect(mapped(groups, path.join(outside, "actual", "deep", "main.ts"))).toContain(
      path.join(cwd, "src", "linked", "main.ts"),
    );
  });
});
