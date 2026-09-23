import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { createNativeSkillsAncestorWatcher } from "./refresh-ancestor-native.js";
import { joinSkillsWatcherCloses } from "./refresh-watch-close.js";
import { createSkillsWatchPathFilter } from "./refresh-watch-path.js";

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
  watcher.on("all", all).on("raw", raw).on("error", error);
  const result = watch.mock.results[0];
  const deliver = watch.mock.calls[0]?.[1];
  if (result?.type !== "return" || typeof deliver !== "function") {
    throw new Error("Native watcher registration did not complete");
  }
  return { watcher, native: result.value, deliver, all, raw, error, rearm };
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
        await runFixture(async (_root, observe) => {
          const observed = observe();
          if (state === "closed") {
            await observed.watcher.close();
          } else {
            const closed = once(observed.native, "close");
            observed.native.close();
            await closed;
            observed.native.emit("error", new Error("Native watch failed"));
            expect(observed.error).toHaveBeenCalledOnce();
          }
          const lstat = vi.spyOn(fs, "lstatSync");
          observed.deliver("rename", "state");
          expect(lstat).not.toHaveBeenCalled();
          expect(observed.all).not.toHaveBeenCalled();
          expect(observed.raw).not.toHaveBeenCalled();
          expect(observed.rearm).not.toHaveBeenCalled();
        });
      },
    );
  },
);
