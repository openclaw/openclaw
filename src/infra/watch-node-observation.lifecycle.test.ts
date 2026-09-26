import fs from "node:fs/promises";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe/root";
import type { WatchOptions as BackendOptions, WatchSubscription } from "@openclaw/fs-safe/watch";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSourceObserver } from "../../scripts/watch-node-observation.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";

const backend = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: backend.watch }));
const temp = useAutoCleanupTempDirTracker(afterEach);
const observers: Array<ReturnType<typeof createSourceObserver>> = [];
afterEach(async () => {
  // Individual rejection tests assert the retained failure before this cleanup.
  await Promise.allSettled(observers.splice(0).map((observer) => observer.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
type Installed = {
  authority: Root;
  options: BackendOptions;
  subscription: WatchSubscription;
  close: import("vitest").Mock<() => Promise<void>>;
};
let installed: Installed[];
beforeEach(() => {
  installed = [];
  backend.watch.mockReset();
  backend.watch.mockImplementation((authority: Root, options: BackendOptions) => {
    const close = vi.fn(async () => {});
    const subscription: WatchSubscription = {
      ready: Promise.resolve(),
      close,
      [Symbol.asyncDispose]: close,
      setScopes: vi.fn(async () => {}),
      reconcile: vi.fn(async () => {}),
      health: () => ({
        state: "ready",
        mode: "events",
        directories: 1,
      }),
    };
    installed.push({ authority, options, subscription, close });
    return subscription;
  });
});
function start(cwd: string, onChange = vi.fn(), onError = vi.fn(), env: NodeJS.ProcessEnv = {}) {
  const observer = createSourceObserver(["src"], {
    cwd,
    env,
    ignored: (name) => name.endsWith(".test.ts"),
    onChange,
    onError,
  });
  observers.push(observer);
  return observer;
}
function dirty(
  entry: Installed,
  changes?: Array<{ path: string; type: "content" | "structural" }>,
) {
  entry.options.onInvalidate({ reason: "event", changes });
}
async function linkedFixture() {
  const cwd = temp.make("source-owner-");
  const outside = temp.make("source-owner-target-");
  await fs.mkdir(path.join(cwd, "src"));
  await fs.mkdir(path.join(outside, "source"));
  await fs.symlink(
    path.join(outside, "source"),
    path.join(cwd, "src", "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return { cwd, outside };
}

describe("developer source observer lifetime", () => {
  it.each(["false", "0", ""])(
    "reports explicit event source refusal without polling (%s)",
    async (setting) => {
      const cwd = temp.make("source-owner-mode-");
      await fs.mkdir(path.join(cwd, "src"));
      const unavailable = new Error("event backend unavailable");
      const original = backend.watch.getMockImplementation()!;
      backend.watch.mockImplementation((authority: Root, options: BackendOptions) => {
        const subscription = original(authority, options);
        const ready = createDeferredCore();
        queueMicrotask(() => {
          // fs-safe publishes unavailable health in the same turn as ready rejection.
          ready.reject(unavailable);
          options.onHealth?.({
            ...subscription.health(),
            state: "unavailable",
            failure: { operation: "watch", error: unavailable },
          });
        });
        return { ...subscription, ready: ready.promise };
      });
      const onError = vi.fn();
      const observer = start(cwd, vi.fn(), onError, { CHOKIDAR_USEPOLLING: setting });
      await expect(observer.ready).rejects.toBe(unavailable);
      await observer.close();
      expect(onError).toHaveBeenCalledExactlyOnceWith(unavailable);
      expect(installed).toHaveLength(1);
      expect(expectDefined(installed[0], "admitted observation").options.mode).toBe("events");
      expect(expectDefined(installed[0], "admitted observation").close).toHaveBeenCalledOnce();
    },
  );

  it("forwards explicit source polling cadence", async () => {
    const cwd = temp.make("source-owner-mode-");
    await fs.mkdir(path.join(cwd, "src"));
    const observer = start(cwd, vi.fn(), vi.fn(), {
      CHOKIDAR_USEPOLLING: "TrUe",
      CHOKIDAR_INTERVAL: "250",
    });
    await observer.ready;
    expect(installed).toHaveLength(1);
    expect(expectDefined(installed[0], "admitted observation").options).toMatchObject({
      mode: "poll",
      intervalMs: 250,
    });
  });

  it("ignores the initial snapshot and preserves later unknown invalidation", async () => {
    const cwd = temp.make("source-owner-bootstrap-");
    await fs.mkdir(path.join(cwd, "src"));
    const original = backend.watch.getMockImplementation()!;
    backend.watch.mockImplementation((authority: Root, options: BackendOptions) => {
      const subscription = original(authority, options);
      options.onInvalidate({ reason: "reconcile" });
      return subscription;
    });
    const onChange = vi.fn();
    const observer = start(cwd, onChange);
    await observer.ready;
    expect(onChange).not.toHaveBeenCalled();
    const entry = expectDefined(installed[0], "admitted observation");
    entry.options.onInvalidate({ reason: "reconcile" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(["addition", "retarget"] as const)(
    "observes a target link %s between discovery and initial watch admission",
    async (change) => {
      const cwd = temp.make("source-owner-admission-gap-");
      const outside = temp.make("source-target-admission-gap-");
      const alias = path.join(cwd, "src", "alias");
      await fs.mkdir(path.dirname(alias));
      await fs.mkdir(path.join(outside, "first"));
      await fs.mkdir(path.join(outside, "second"));
      const linkType = process.platform === "win32" ? "junction" : "dir";
      if (change === "retarget") {
        await fs.symlink(path.join(outside, "first"), alias, linkType);
      }
      const original = backend.watch.getMockImplementation()!;
      let changed = false;
      backend.watch.mockImplementation((authority: Root, options: BackendOptions) => {
        const subscription = original(authority, options);
        if (authority.rootReal !== cwd || changed) {
          return subscription;
        }
        changed = true;
        return {
          ...subscription,
          ready: (async () => {
            if (change === "retarget") {
              await fs.unlink(alias);
            }
            await fs.symlink(path.join(outside, "second"), alias, linkType);
            options.onInvalidate({ reason: "reconcile" });
          })(),
        };
      });
      const onChange = vi.fn();
      const observer = start(cwd, onChange);
      await observer.ready;
      const target = expectDefined(
        installed.find((entry) => entry.authority.rootReal === outside),
        "target admitted before source readiness",
      );
      onChange.mockClear();
      dirty(target, [{ path: "first/retired.ts", type: "content" }]);
      dirty(target, [{ path: "second/current.ts", type: "content" }]);
      expect(onChange.mock.calls).toEqual([[path.join(alias, "current.ts")]]);
    },
  );

  it("maps target notifications lexically and never reads advisory filenames", async () => {
    const { cwd, outside } = await linkedFixture();
    const onChange = vi.fn();
    const observer = start(cwd, onChange);
    await observer.ready;
    const target = installed.find((entry) => entry.authority.rootReal === outside)!;
    const readlink = vi.spyOn(fs, "readlink");
    dirty(target, [{ path: "source/main.ts", type: "content" }]);
    dirty(target, [{ path: "source/skip.test.ts", type: "content" }]);
    dirty(target, [{ path: "../../arbitrary-link", type: "content" }]);
    expect(onChange.mock.calls).toEqual([[path.join(cwd, "src", "alias", "main.ts")]]);
    expect(readlink).not.toHaveBeenCalled();
    expect(installed).toHaveLength(2);
  });

  it("publishes one close promise before backend reentry and joins every physical close", async () => {
    const { cwd } = await linkedFixture();
    const observer = start(cwd);
    await observer.ready;
    const joins = installed.map(() => createDeferredCore());
    const reentrant: Promise<void>[] = [];
    installed.forEach((entry, index) => {
      vi.mocked(entry.close).mockImplementation(() => {
        reentrant.push(observer.close());
        return expectDefined(joins[index], "physical close join").promise;
      });
    });
    const closing = observer.close();
    expect(observer.close()).toBe(closing);
    expect(reentrant).toEqual([closing, closing]);
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    expectDefined(joins[0], "physical close join").resolve();
    await expectDefined(joins[0], "physical close join").promise;
    expect(settled).toBe(false);
    expectDefined(joins[1], "physical close join").resolve();
    await closing;
    for (const entry of installed) {
      expect(entry.close).toHaveBeenCalledTimes(1);
    }
  });

  it("joins startup when close precedes asynchronous source admission", async () => {
    const cwd = temp.make("source-owner-");
    const gate = createDeferredCore<string>();
    const entered = createDeferredCore();
    vi.spyOn(fs, "realpath").mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    const observer = start(cwd);
    await entered.promise;
    const closing = observer.close();
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(backend.watch).not.toHaveBeenCalled();
    gate.resolve(cwd);
    await closing;
    await expect(observer.ready).rejects.toMatchObject({ name: "AbortError" });
    expect(backend.watch).not.toHaveBeenCalled();
  });

  it("joins in-flight link discovery and fences new subscriptions on close", async () => {
    const cwd = temp.make("source-owner-");
    const outside = temp.make("source-owner-target-");
    await fs.mkdir(path.join(cwd, "src"));
    const observer = start(cwd);
    await observer.ready;
    await fs.symlink(
      path.join(outside, "missing"),
      path.join(cwd, "src", "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const gate = createDeferredCore<string>();
    const entered = createDeferredCore();
    vi.spyOn(fs, "readlink").mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    dirty(expectDefined(installed[0], "admitted observation"), [
      { path: "src/alias", type: "structural" },
    ]);
    await entered.promise;
    const closing = observer.close();
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(expectDefined(installed[0], "admitted observation").close).toHaveBeenCalledTimes(1);
    gate.resolve(path.join(outside, "missing"));
    await closing;
    expect(installed).toHaveLength(1);
  });

  it("retains a distinct owned discovery failure racing terminal cancellation", async () => {
    const cwd = temp.make("source-owner-");
    const gate = createDeferredCore<string>();
    const entered = createDeferredCore();
    vi.spyOn(fs, "realpath").mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    const observer = start(cwd);
    await entered.promise;
    const failure = new Error("owned discovery failed while closing");
    const closing = observer.close();
    const rejected = expect(closing).rejects.toBe(failure);
    gate.reject(failure);
    await rejected;
    expect(backend.watch).not.toHaveBeenCalled();
    expect(observer.close()).toBe(closing);
  });

  it("retires a removed target before reusing its lifetime-pinned Root", async () => {
    const { cwd, outside } = await linkedFixture();
    const observer = start(cwd);
    await observer.ready;
    const repository = installed.find((entry) => entry.authority.rootReal === cwd)!;
    const target = installed.find((entry) => entry.authority.rootReal === outside)!;
    const retiring = createDeferredCore();
    const retired = createDeferredCore();
    vi.mocked(target.close).mockImplementation(() => {
      retiring.resolve();
      return retired.promise;
    });
    await fs.unlink(path.join(cwd, "src", "alias"));
    dirty(repository, [{ path: "src/alias", type: "structural" }]);
    await retiring.promise;
    const readmitted = createDeferredCore();
    const original = backend.watch.getMockImplementation()!;
    backend.watch.mockImplementation((authority: Root, options: BackendOptions) => {
      const result = original(authority, options);
      if (authority === target.authority) {
        readmitted.resolve();
      }
      return result;
    });
    await fs.symlink(
      path.join(outside, "source"),
      path.join(cwd, "src", "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    dirty(repository, [{ path: "src/alias", type: "structural" }]);
    expect(installed).toHaveLength(2);
    retired.resolve();
    await readmitted.promise;
    expect(installed).toHaveLength(3);
    expect(expectDefined(installed[2], "admitted observation").authority).toBe(target.authority);
    expect(target.close).toHaveBeenCalledTimes(1);
  });

  it("updates scopes and lexical mappings when a linked target moves within its admitted Root", async () => {
    const { cwd, outside } = await linkedFixture();
    await fs.mkdir(path.join(outside, "second"));
    const onChange = vi.fn();
    const observer = start(cwd, onChange);
    await observer.ready;
    const repository = installed.find((entry) => entry.authority.rootReal === cwd)!;
    const target = installed.find((entry) => entry.authority.rootReal === outside)!;
    const updated = createDeferredCore();
    vi.spyOn(target.subscription, "setScopes").mockImplementation(async () => updated.resolve());
    const alias = path.join(cwd, "src", "alias");
    await fs.unlink(alias);
    await fs.symlink(
      path.join(outside, "second"),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    dirty(repository, [{ path: "src/alias", type: "structural" }]);
    await updated.promise;
    onChange.mockClear();
    dirty(target, [{ path: "source/retired.ts", type: "content" }]);
    dirty(target, [{ path: "second/current.ts", type: "content" }]);
    expect(onChange.mock.calls).toEqual([[path.join(alias, "current.ts")]]);
    expect(installed).toHaveLength(2);
    expect(target.close).not.toHaveBeenCalled();
  });

  it("reports observation loss separately when physical retirement succeeds", async () => {
    const { cwd } = await linkedFixture();
    const onError = vi.fn();
    const observer = start(cwd, vi.fn(), onError);
    await observer.ready;
    const failure = new Error("source observation lost");
    expectDefined(installed[0], "admitted observation").options.onHealth?.({
      ...expectDefined(installed[0], "admitted observation").subscription.health(),
      state: "unavailable",
      failure: { operation: "watch", error: failure },
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    await expect(observer.close()).resolves.toBeUndefined();
    expect(installed.every((entry) => entry.close.mock.calls.length === 1)).toBe(true);
  });

  it("retains all reported retirement errors after observation becomes unavailable", async () => {
    const { cwd } = await linkedFixture();
    const onError = vi.fn();
    const observer = start(cwd, vi.fn(), onError);
    await observer.ready;
    const observationError = new Error("source authority lost");
    const closeError = new Error("subscription retirement failed");
    vi.mocked(expectDefined(installed[0], "admitted observation").close).mockRejectedValue(
      observationError,
    );
    vi.mocked(expectDefined(installed[1], "admitted observation").close).mockRejectedValue(
      closeError,
    );
    expectDefined(installed[0], "admitted observation").options.onHealth?.({
      ...expectDefined(installed[0], "admitted observation").subscription.health(),
      state: "unavailable",
      failure: { operation: "watch", error: observationError },
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(observationError);
    const closing = observer.close();
    await expect(closing).rejects.toMatchObject({ errors: [observationError, closeError] });
    expect(observer.close()).toBe(closing);
    await expect(observer.close()).rejects.toMatchObject({
      errors: [observationError, closeError],
    });
  });

  it.each(["structural", "whole-scope"] as const)(
    "rediscovers added links after %s invalidation",
    async (reason) => {
      const cwd = temp.make("source-owner-");
      const outside = temp.make("source-owner-target-");
      await fs.mkdir(path.join(cwd, "src"));
      await fs.mkdir(path.join(outside, "target"));
      const onChange = vi.fn();
      const observer = start(cwd, onChange);
      await observer.ready;
      const admitted = createDeferredCore();
      const original = backend.watch.getMockImplementation()!;
      backend.watch.mockImplementation((authority: Root, options: BackendOptions) => {
        const result = original(authority, options);
        if (authority.rootReal === outside) {
          admitted.resolve();
        }
        return result;
      });
      await fs.symlink(
        path.join(outside, "target"),
        path.join(cwd, "src", "alias"),
        process.platform === "win32" ? "junction" : "dir",
      );
      dirty(
        expectDefined(installed[0], "admitted observation"),
        reason === "structural" ? [{ path: "src/alias", type: "structural" }] : undefined,
      );
      await admitted.promise;
      expect(installed).toHaveLength(2);
      if (reason === "whole-scope") {
        expect(onChange).toHaveBeenCalledWith();
      }
      const target = expectDefined(installed[1], "admitted observation");
      dirty(target, [{ path: "target/later.ts", type: "content" }]);
      expect(onChange).toHaveBeenCalledWith(path.join(cwd, "src", "alias", "later.ts"));
    },
  );
});
