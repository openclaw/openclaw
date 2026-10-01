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
    await fs.writeFile(path.join(outside, "first", "main.ts"), "before linked edit");
    const alias = path.join(cwd, "src", "linked");
    await directoryLink(path.join(outside, "first"), alias);
    const subscriptions: observation.WatchSubscription[] = [];
    const targetReady = createDeferredCore<observation.WatchSubscription>();
    const original = observation.watch;
    vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
      const subscription = original(authority, options);
      subscriptions.push(subscription);
      if (authority.rootReal === outside) {
        targetReady.resolve(subscription);
      }
      return subscription;
    });
    const onChange = vi.fn();
    const onError = vi.fn();
    const onLog = vi.fn();
    const observer = createSourceObserver(["src"], {
      cwd,
      env: { CHOKIDAR_USEPOLLING: "1", CHOKIDAR_INTERVAL: "250" },
      ignored: (name) => name.endsWith(".test.ts") || name.split(path.sep).includes("node_modules"),
      onChange,
      onError,
      onLog,
    });
    observers.push(observer);
    await observer.ready;
    const repository = subscriptions[0]!;
    expect(onChange).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalledExactlyOnceWith("Watching sources (poll).");

    await fs.writeFile(path.join(cwd, "src", "first.ts"), "one");
    await fs.writeFile(path.join(cwd, "src", "second.ts"), "two");
    await repository.reconcile();
    expect(onChange).toHaveBeenCalledOnce();
    onChange.mockClear();
    await fs.writeFile(path.join(cwd, "src", "ignored.test.ts"), "test");
    await fs.writeFile(path.join(cwd, "src", "node_modules", "ignored.ts"), "dependency");
    await repository.reconcile();
    expect(onChange).not.toHaveBeenCalled();

    const target = await targetReady.promise;
    await fs.writeFile(path.join(outside, "first", "main.ts"), "linked source");
    await target.reconcile();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(path.join(alias, "main.ts"));

    const replaced = createDeferredCore();
    const setScopes = target.setScopes.bind(target);
    vi.spyOn(target, "setScopes").mockImplementation(async (scopes) => {
      await setScopes(scopes);
      replaced.resolve();
    });
    onChange.mockClear();
    await fs.unlink(alias);
    await directoryLink(path.join(outside, "second"), alias);
    await repository.reconcile();
    await replaced.promise;
    expect(onChange).toHaveBeenCalledExactlyOnceWith(alias);
    onChange.mockClear();
    await fs.writeFile(path.join(outside, "first", "retired.ts"), "old target");
    await fs.writeFile(path.join(outside, "second", "current.ts"), "new target");
    await target.reconcile();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(path.join(alias, "current.ts"));
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
    let subscription: observation.WatchSubscription | undefined;
    const original = observation.watch;
    vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
      subscription = original(authority, options);
      return subscription;
    });
    const onError = vi.fn();
    const observer = createSourceObserver(["src"], {
      cwd,
      env: { CHOKIDAR_USEPOLLING: "1" },
      ignored: () => false,
      onChange: vi.fn(),
      onError,
    });
    observers.push(observer);
    await observer.ready;
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
