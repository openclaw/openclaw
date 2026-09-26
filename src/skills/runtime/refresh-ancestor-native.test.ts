import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import {
  createNativeSkillsAncestorWatcher,
  SkillsNativeWatchInvalidatedError,
} from "./refresh-ancestor-native.js";
import { joinSkillsWatcherCloses } from "./refresh-watch-close.js";
import { createSkillsWatchPathFilter } from "./refresh-watch-path.js";
import { shouldUseNativeSkillsWatcher } from "./refresh-watch-transport.js";

const lifetimes: ReturnType<typeof createFixtureLifetime>[] = [];
afterEach(async () => {
  await Promise.all(lifetimes.splice(0).map((lifetime) => lifetime.cleanup()));
  vi.restoreAllMocks();
});

function runFixture(
  body: (
    root: string,
    observe: (target?: string) => ReturnType<typeof observeRoot>,
  ) => Promise<void>,
) {
  const lifetime = createFixtureLifetime();
  lifetimes.push(lifetime);
  return lifetime.run(async () => {
    const root = path.join(lifetime.createTempDir("skills-native-root-"), "state");
    fs.mkdirSync(root);
    const watchers: ReturnType<typeof createNativeSkillsAncestorWatcher>[] = [];
    try {
      await body(root, (target = path.join(root, "skills")) => {
        return observeRoot(root, target, watchers);
      });
    } finally {
      await lifetime.verifyCleanup(async () => {
        await Promise.all(watchers.map((watcher) => watcher.close()));
        await joinSkillsWatcherCloses();
      });
    }
  });
}

function observeRoot(
  root: string,
  target: string,
  watchers: ReturnType<typeof createNativeSkillsAncestorWatcher>[],
) {
  const watch = vi.spyOn(fs, "watch");
  const rearm = vi.fn();
  const watcher = createNativeSkillsAncestorWatcher(
    root,
    createSkillsWatchPathFilter(target, false).ignored,
    rearm,
  );
  watchers.push(watcher);
  const all = vi.fn();
  const raw = vi.fn();
  const error = vi.fn();
  const reconcile = vi.fn();
  watcher.on("all", all).on("raw", raw).on("error", error).on("reconcile", reconcile);
  const result = watch.mock.results[0];
  const deliver = watch.mock.calls[0]?.[1];
  if (result?.type !== "return" || typeof deliver !== "function") {
    throw new Error("Native watcher registration did not complete");
  }
  return { watcher, native: result.value, deliver, all, raw, error, rearm, reconcile };
}

function deliverWindowsNotification(deliver: () => void) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    // Inject only the Windows callback boundary; native acquisition and close
    // still use the real host. This is not a Windows filesystem proof.
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    deliver();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
}

function deliverWindowsError(native: fs.FSWatcher, error: Error) {
  deliverWindowsNotification(() => native.emit("error", error));
}

describe.runIf(process.platform === "linux" && !process.versions.bun)(
  "native ancestor root identity",
  () => {
    it.for([false, true])(
      "filters a real same-name child with relevant=%s",
      async (relevant, ctx) => {
        await runFixture(async (root, observe) => {
          const child = path.join(root, "state");
          fs.mkdirSync(child);
          const before = fs.lstatSync(root, { bigint: true });
          const observed = observe(relevant ? path.join(child, "skills") : undefined);
          const delivered = once(observed.native, "change", { signal: ctx.signal });
          ctx.signal.throwIfAborted();
          fs.chmodSync(child, fs.statSync(child).mode & 0o7777);
          const [, filename] = await delivered;
          expect(String(filename)).toBe("state");
          expect(fs.lstatSync(root, { bigint: true })).toMatchObject({
            dev: before.dev,
            ino: before.ino,
            ctimeNs: before.ctimeNs,
          });
          if (relevant) {
            expect(observed.all).toHaveBeenCalledWith(expect.any(String), child);
            expect(observed.raw).toHaveBeenCalled();
          } else {
            expect(observed.all).not.toHaveBeenCalled();
            expect(observed.raw).not.toHaveBeenCalled();
          }
          expect(observed.rearm).not.toHaveBeenCalled();
          expect(observed.error).not.toHaveBeenCalled();
        });
      },
    );

    it("retains recovery for real same-inode root permission changes", async (ctx) => {
      await runFixture(async (root, observe) => {
        const observed = observe();
        const before = fs.lstatSync(root, { bigint: true });
        const delivered = once(observed.native, "change", { signal: ctx.signal });
        ctx.signal.throwIfAborted();
        fs.chmodSync(root, Number(before.mode & 0o7777n) ^ 0o100);
        await delivered;
        expect(fs.lstatSync(root, { bigint: true }).ino).toBe(before.ino);
        expect(observed.all).toHaveBeenCalledWith("ancestor", root);
        expect(observed.rearm).toHaveBeenCalled();
        expect(observed.error).not.toHaveBeenCalled();
        fs.chmodSync(root, Number(before.mode & 0o7777n));
      });
    });

    it.for([false, true])(
      "does not rearm for child ctime changes with registration metadata changed=%s",
      async (duringRegistration, ctx) => {
        await runFixture(async (root, observe) => {
          const before = fs.lstatSync(root, { bigint: true });
          const child = path.join(root, "irrelevant");
          const read = fs.lstatSync;
          let reads = 0;
          let childCreated = false;
          const createChild = () => {
            fs.mkdirSync(child);
            childCreated = true;
          };
          vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
            const isRoot = String(args[0]) === root;
            if (isRoot && ++reads === 3 && duringRegistration) {
              createChild();
            }
            const stats = read(...args);
            // Same-turn mkdir can share a filesystem clock tick. Inject only
            // the changed ctime fact; identity and native delivery stay real.
            if (isRoot && childCreated && stats && "ctimeNs" in stats) {
              stats.ctimeNs = before.ctimeNs + 1n;
            }
            return stats;
          });
          const observed = observe();
          const delivered = once(observed.native, "change", { signal: ctx.signal });
          if (!duringRegistration) {
            createChild();
          }
          const [, filename] = await delivered;
          const after = fs.lstatSync(root, { bigint: true });
          expect(String(filename)).toBe("irrelevant");
          expect(after.ino).toBe(before.ino);
          expect(after.ctimeNs).not.toBe(before.ctimeNs);
          expect(observed.all).not.toHaveBeenCalled();
          expect(observed.raw).not.toHaveBeenCalled();
          expect(observed.rearm).not.toHaveBeenCalled();
          expect(observed.error).not.toHaveBeenCalled();
        });
      },
    );

    it("preserves sub-millisecond root metadata changes without adopting them", async () => {
      await runFixture(async (root, observe) => {
        const observed = observe();
        const changed = fs.lstatSync(root, { bigint: true });
        changed.ctimeNs += 1n;
        vi.spyOn(fs, "lstatSync").mockReturnValue(changed);
        for (const event of ["rename", "change"] as const) {
          observed.deliver(event, "state");
        }
        expect(observed.all.mock.calls).toEqual([
          ["ancestor", root],
          ["ancestor", root],
        ]);
        expect(observed.rearm).toHaveBeenCalledTimes(2);
      });
    });

    it.each(["directory", "symlink", "unreadable-before", "unreadable-after"] as const)(
      "keeps registration with %s facts conservative after later successful reads",
      async (change) => {
        await runFixture(async (root, observe) => {
          const lstat = fs.lstatSync;
          const sample = () => lstat(root, { bigint: true });
          const unreadable = () => {
            throw Object.assign(new Error("Root metadata unavailable"), { code: "EACCES" });
          };
          vi.spyOn(fs, "lstatSync")
            .mockImplementationOnce(sample)
            .mockImplementationOnce(change === "unreadable-before" ? unreadable : sample)
            .mockImplementationOnce(() => {
              if (change === "unreadable-after") {
                return unreadable();
              }
              if (change === "directory" || change === "symlink") {
                fs.renameSync(root, `${root}-retired`);
                if (change === "directory") {
                  fs.mkdirSync(root);
                } else {
                  fs.symlinkSync(`${root}-retired`, root, "dir");
                }
              }
              return sample();
            });
          const observed = observe();
          if (change === "symlink") {
            fs.unlinkSync(root);
            fs.mkdirSync(root);
          }
          observed.deliver("rename", "state");
          observed.deliver("rename", "state");
          expect(observed.all.mock.calls).toEqual([
            ["ancestor", root],
            ["ancestor", root],
          ]);
          expect(observed.rearm).toHaveBeenCalledTimes(2);
        });
      },
    );

    it.each(["missing", "symlink"] as const)(
      "retains recovery for a %s root at delivery",
      async (kind) => {
        await runFixture(async (root, observe) => {
          const observed = observe();
          fs.renameSync(root, `${root}-retired`);
          if (kind === "symlink") {
            fs.symlinkSync(`${root}-retired`, root, "dir");
          }
          observed.deliver("change", "state");
          expect(observed.all).toHaveBeenCalledWith("ancestor", root);
          expect(observed.rearm).toHaveBeenCalledOnce();
        });
      },
    );
  },
);

describe.runIf(shouldUseNativeSkillsWatcher(false))("native ancestor lifecycle", () => {
  it.each(["rename", "change"] as const)(
    "reconciles a Windows short-name %s before lexical filtering",
    async (event) => {
      await runFixture(async (root, observe) => {
        const target = path.join(root, "long-skills-root");
        const realTarget = path.join(path.dirname(root), "real-skills-root");
        fs.mkdirSync(realTarget);
        fs.symlinkSync(realTarget, target, process.platform === "win32" ? "junction" : "dir");
        const observed = observe(target);
        let nativeClosed = false;
        observed.native.once("close", () => {
          nativeClosed = true;
        });
        fs.unlinkSync(target);
        deliverWindowsNotification(() => observed.deliver(event, "LONG-S~1"));
        expect(observed.reconcile).toHaveBeenCalledExactlyOnceWith(
          path.join(root, "LONG-S~1"),
          true,
        );
        expect(observed.all).not.toHaveBeenCalled();
        expect(observed.raw).not.toHaveBeenCalled();
        expect(observed.rearm).not.toHaveBeenCalled();
        expect(observed.error).not.toHaveBeenCalled();
        expect(await observed.watcher.close()).toEqual({ ok: true, value: undefined });
        expect(nativeClosed).toBe(true);
      });
    },
  );

  it("fences raw delivery after a Windows reconciliation callback closes its observer", async () => {
    await runFixture(async (root, observe) => {
      const observed = observe(root);
      observed.watcher.on("reconcile", () => {
        void observed.watcher.close();
      });
      deliverWindowsNotification(() => observed.deliver("rename", "LONG-S~1"));
      expect(observed.reconcile).toHaveBeenCalledOnce();
      expect(observed.all).not.toHaveBeenCalled();
      expect(observed.raw).not.toHaveBeenCalled();
      expect(observed.rearm).not.toHaveBeenCalled();
      const probe = vi.spyOn(fs, "lstatSync");
      deliverWindowsNotification(() => observed.deliver("change", "LONG-S~1"));
      expect(probe).not.toHaveBeenCalled();
      expect(observed.reconcile).toHaveBeenCalledOnce();
      expect(await observed.watcher.close()).toEqual({ ok: true, value: undefined });
    });
  });

  it("rearms before ready when the requested observer returns before fallback registration", async () => {
    await runFixture(async (root) => {
      const parent = path.dirname(root);
      const retired = `${root}-retired`;
      const target = path.join(root, "missing");
      fs.renameSync(root, retired);
      const ignored = createSkillsWatchPathFilter(target, false).ignored;
      const watchers: ReturnType<typeof createNativeSkillsAncestorWatcher>[] = [];
      const handles: Array<{ directory: string; closed: boolean }> = [];
      const originalWatch = fs.watch;
      vi.spyOn(fs, "watch").mockImplementation((...args) => {
        const directory = path.resolve(String(args[0]));
        if (directory === parent && handles.length === 0) {
          // Restore before the actual parent watch starts: no creation event
          // is owed, and the logical target remains missing through readiness.
          fs.renameSync(retired, root);
        }
        const native = originalWatch(...args);
        const handle = { directory, closed: false };
        handles.push(handle);
        native.once("close", () => {
          handle.closed = true;
        });
        return native;
      });
      const events = vi.fn();
      const errors = vi.fn();
      const initialReady = vi.fn();
      let initial: ReturnType<typeof createNativeSkillsAncestorWatcher>;
      let replacement: ReturnType<typeof createNativeSkillsAncestorWatcher> | undefined;
      let replacementReady = false;
      const create = () => {
        const watcher = createNativeSkillsAncestorWatcher(root, ignored, () => {
          void initial.close();
          replacement = create();
          replacement.on("ready", () => {
            replacementReady = true;
          });
        });
        watchers.push(watcher);
        watcher.on("all", events).on("error", errors);
        watcher.on("reconcile", (changedPath: string, structural: boolean) => {
          if (structural) {
            events("reconcile", changedPath);
          }
        });
        return watcher;
      };
      try {
        initial = create();
        initial.on("ready", initialReady);
        await vi.waitFor(() => expect(replacementReady).toBe(true));
        expect(initialReady).not.toHaveBeenCalled();
        expect(handles.map(({ directory }) => directory)).toEqual([parent, root]);
        expect(handles[0]?.closed).toBe(true);
        expect(replacement?.admitted).toBe(true);
        expect(fs.existsSync(target)).toBe(false);
        fs.mkdirSync(target);
        await vi.waitFor(() =>
          expect(events).toHaveBeenCalledWith(
            process.platform === "win32" ? "reconcile" : "ancestor",
            target,
          ),
        );
        expect(errors).not.toHaveBeenCalled();
      } finally {
        expect(await Promise.all(watchers.map((watcher) => watcher.close()))).toEqual(
          watchers.map(() => ({ ok: true, value: undefined })),
        );
        expect(handles.every(({ closed }) => closed)).toBe(true);
      }
    });
  });

  it.each([false, true])(
    "rearms a replaced root from its full native path with callback close=%s",
    async (closeInCallback) => {
      await runFixture(async (root) => {
        const observationRoot = root;
        const target = path.join(observationRoot, "skills");
        const ignored = createSkillsWatchPathFilter(target, false).ignored;
        const watchers: ReturnType<typeof createNativeSkillsAncestorWatcher>[] = [];
        const handles: Array<{ closed: boolean }> = [];
        const nativeWatch = fs.watch;
        const acquire = vi.spyOn(fs, "watch").mockImplementation((...args) => {
          // Hold only the retired generation's real delivery. Its replacement
          // must observe the later filesystem mutation through a live callback.
          const native =
            handles.length === 0 ? nativeWatch(args[0], () => {}) : nativeWatch(...args);
          const handle = { closed: false };
          handles.push(handle);
          native.once("close", () => {
            handle.closed = true;
          });
          return native;
        });
        const events = vi.fn();
        const errors = vi.fn();
        let initial: ReturnType<typeof createNativeSkillsAncestorWatcher>;
        let replacement: ReturnType<typeof createNativeSkillsAncestorWatcher> | undefined;
        const rearm = vi.fn(() => {
          void initial.close();
          replacement = create();
        });
        const create = () => {
          const watcher = createNativeSkillsAncestorWatcher(observationRoot, ignored, rearm);
          watchers.push(watcher);
          watcher.on("all", events).on("error", errors);
          watcher.on("reconcile", (changedPath: string, structural: boolean) => {
            if (structural) {
              events("reconcile", changedPath);
            }
          });
          return watcher;
        };
        try {
          initial = create();
          expect(initial.admitted).toBe(true);
          const raw = vi.fn();
          initial.on("raw", raw);
          const identity = fs.statSync(observationRoot, { bigint: true });
          await once(initial, "ready");
          fs.renameSync(root, `${root}-retired`);
          fs.mkdirSync(root);
          expect(fs.statSync(observationRoot, { bigint: true }).ino).not.toBe(identity.ino);
          expect(fs.existsSync(target)).toBe(false);
          const read = vi.spyOn(fs, "lstatSync");
          initial.on("all", () => {
            expect(read).not.toHaveBeenCalled();
            if (closeInCallback) {
              void initial.close();
            }
          });
          const filename = path.toNamespacedPath(observationRoot);
          const deliver = acquire.mock.calls[0]?.[1];
          expect(typeof deliver).toBe("function");
          if (typeof deliver !== "function") {
            throw new Error("Missing native callback");
          }
          deliver("rename", filename);
          expect(events.mock.calls).toEqual([["ancestor", observationRoot]]);
          expect(raw).toHaveBeenCalledTimes(closeInCallback ? 0 : 1);
          expect(rearm).toHaveBeenCalledTimes(closeInCallback ? 0 : 1);
          expect(acquire).toHaveBeenCalledTimes(closeInCallback ? 1 : 2);
          if (replacement) {
            await once(replacement, "ready");
            fs.mkdirSync(target);
            await vi.waitFor(() =>
              expect(events).toHaveBeenCalledWith(
                process.platform === "win32" ? "reconcile" : "ancestor",
                target,
              ),
            );
          }
          expect(errors).not.toHaveBeenCalled();
        } finally {
          expect(await Promise.all(watchers.map((watcher) => watcher.close()))).toEqual(
            watchers.map(() => ({ ok: true, value: undefined })),
          );
          expect(handles.every(({ closed }) => closed)).toBe(true);
        }
      });
    },
  );

  it.each([false, true])(
    "reconciles a terminal Windows deletion with callback close=%s",
    async (closeInCallback) => {
      await runFixture(async (root, observe) => {
        const observed = observe();
        const retired = once(observed.native, "close");
        observed.native.close();
        await retired;
        fs.rmdirSync(root);
        let closing: ReturnType<typeof observed.watcher.close> | undefined;
        observed.watcher.on("all", () => {
          // The terminal generation must already reject reentrant delivery.
          observed.deliver("rename", "state");
          if (closeInCallback) {
            closing = observed.watcher.close();
          }
        });
        deliverWindowsError(
          observed.native,
          Object.assign(new Error("watched directory deleted"), { code: "EPERM" }),
        );
        expect(observed.all.mock.calls).toEqual([["ancestor", root]]);
        expect(observed.raw).not.toHaveBeenCalled();
        expect(observed.error).not.toHaveBeenCalled();
        expect(observed.rearm).toHaveBeenCalledTimes(closeInCallback ? 0 : 1);
        expect(await (closing ?? observed.watcher.close())).toEqual({ ok: true, value: undefined });
      });
    },
  );

  it.each(["missing descendant", "unreadable observer", "other error"] as const)(
    "preserves a terminal native error for %s",
    async (state) => {
      await runFixture(async (root) => {
        const requested = state === "missing descendant" ? path.join(root, "missing") : root;
        const watchers: ReturnType<typeof createNativeSkillsAncestorWatcher>[] = [];
        const observed = observeRoot(requested, path.join(requested, "skills"), watchers);
        try {
          const retired = once(observed.native, "close");
          observed.native.close();
          await retired;
          if (state === "unreadable observer") {
            vi.spyOn(fs, "lstatSync").mockImplementationOnce(() => {
              throw Object.assign(new Error("metadata inaccessible"), { code: "EACCES" });
            });
          } else if (state === "other error") {
            fs.rmdirSync(root);
          }
          const failure = Object.assign(new Error("native watch failed"), {
            code: state === "other error" ? "EIO" : "EPERM",
          });
          deliverWindowsError(observed.native, failure);
          expect(observed.error.mock.calls).toEqual([[failure]]);
          expect(observed.all).not.toHaveBeenCalled();
          expect(observed.rearm).not.toHaveBeenCalled();
          expect(await observed.watcher.close()).toEqual({ ok: true, value: undefined });
        } finally {
          await observed.watcher.close();
        }
      });
    },
  );

  it("does not certify inaccessible roots as missing paths", async () => {
    await runFixture(async (root) => {
      const failure = Object.assign(new Error("Root metadata unavailable"), { code: "EACCES" });
      const acquire = vi.spyOn(fs, "watch");
      vi.spyOn(fs, "lstatSync").mockImplementationOnce(() => {
        throw failure;
      });
      const watcher = createNativeSkillsAncestorWatcher(
        root,
        () => false,
        () => {},
      );
      const errors: unknown[] = [];
      const ready = vi.fn();
      watcher.on("error", (error) => errors.push(error));
      watcher.on("ready", ready);
      try {
        await vi.waitFor(() => expect(errors).toEqual([failure]));
        expect(acquire).not.toHaveBeenCalled();
        expect(ready).not.toHaveBeenCalled();
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
      } finally {
        await watcher.close();
      }
    });
  });

  it.each(["directory", "entry-parent"] as const)(
    "retires a %s registration whose inode changed inside the bracket",
    async (admission) => {
      await runFixture(async (root) => {
        const acquire = vi.spyOn(fs, "watch");
        const actual = fs.lstatSync(root, { bigint: true });
        const replaced = Object.assign(Object.create(Object.getPrototypeOf(actual)), actual, {
          ino: actual.ino + 1n,
        });
        vi.spyOn(fs, admission === "directory" ? "lstatSync" : "statSync")
          .mockReturnValueOnce(actual)
          .mockReturnValueOnce(actual)
          .mockReturnValueOnce(replaced);
        const watcher = createNativeSkillsAncestorWatcher(
          root,
          () => false,
          () => {},
          admission,
        );
        const errors: unknown[] = [];
        const ready = vi.fn();
        watcher.on("error", (error) => errors.push(error));
        watcher.on("ready", ready);
        const result = acquire.mock.results[0];
        expect(result?.type).toBe("return");
        const native = result!.value as fs.FSWatcher;
        const retired = once(native, "close");
        try {
          await vi.waitFor(() => expect(errors).toHaveLength(1));
          expect(errors[0]).toBeInstanceOf(SkillsNativeWatchInvalidatedError);
          expect(watcher.admittedIdentity).toBeUndefined();
          expect(ready).not.toHaveBeenCalled();
          expect(await watcher.close()).toEqual({ ok: true, value: undefined });
          await retired;
        } finally {
          await watcher.close();
        }
      });
    },
  );

  it.each([
    ["directory", "before", "EACCES"],
    ["directory", "after", "EIO"],
    ["entry-parent", "before", "EACCES"],
    ["entry-parent", "after", "EIO"],
  ] as const)("preserves a %s %s-registration %s error", async (admission, phase, code) => {
    await runFixture(async (root) => {
      const failure = Object.assign(new Error("Root metadata unavailable"), { code });
      const method = admission === "directory" ? "lstatSync" : "statSync";
      const read = fs[method];
      let reads = 0;
      vi.spyOn(fs, method).mockImplementation((...args) => {
        if (path.resolve(String(args[0])) === root && ++reads === (phase === "before" ? 2 : 3)) {
          throw failure;
        }
        return read(...args);
      });
      const acquire = vi.spyOn(fs, "watch");
      const watcher = createNativeSkillsAncestorWatcher(
        root,
        () => false,
        () => {},
        admission,
      );
      const errors: unknown[] = [];
      const ready = vi.fn();
      watcher.on("error", (error) => errors.push(error));
      watcher.on("ready", ready);
      let retired = false;
      const acquired = acquire.mock.results[0];
      if (acquired?.type === "return") {
        acquired.value.once("close", () => {
          retired = true;
        });
      }
      try {
        await vi.waitFor(() => expect(errors).toEqual([failure]));
        expect(errors[0]).not.toBeInstanceOf(SkillsNativeWatchInvalidatedError);
        expect(watcher.admittedIdentity).toBeUndefined();
        expect(ready).not.toHaveBeenCalled();
        expect(acquire).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
        expect(await watcher.close()).toEqual({ ok: true, value: undefined });
        expect(retired).toBe(phase === "after");
      } finally {
        await watcher.close();
      }
    });
  });

  it("keeps nameless events conservative without a metadata read", async () => {
    await runFixture(async (root, observe) => {
      const observed = observe();
      const lstat = vi.spyOn(fs, "lstatSync");
      observed.deliver("change", null);
      expect(lstat).not.toHaveBeenCalled();
      expect(observed.all).toHaveBeenCalledWith("ancestor", root);
      expect(observed.rearm).toHaveBeenCalledOnce();
    });
  });

  it.each(["closed", "failed"] as const)(
    "ignores delivery after the generation is %s",
    async (state) => {
      await runFixture(async (root, observe) => {
        const observed = observe();
        const identity = fs.lstatSync(root, { bigint: true });
        expect(observed.watcher.admittedIdentity).toMatchObject({
          dev: identity.dev,
          ino: identity.ino,
        });
        if (state === "closed") {
          await observed.watcher.close();
        } else {
          const closed = once(observed.native, "close");
          observed.native.close();
          await closed;
          observed.native.emit("error", new Error("Native watch failed"));
          expect(observed.error).toHaveBeenCalledOnce();
        }
        expect(observed.watcher.admittedIdentity).toBeUndefined();
        const lstat = vi.spyOn(fs, "lstatSync");
        observed.deliver("rename", "state");
        expect(lstat).not.toHaveBeenCalled();
        expect(observed.all).not.toHaveBeenCalled();
        expect(observed.raw).not.toHaveBeenCalled();
        expect(observed.rearm).not.toHaveBeenCalled();
      });
    },
  );
});
