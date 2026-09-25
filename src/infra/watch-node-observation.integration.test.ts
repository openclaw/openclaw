import fs from "node:fs/promises";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe/root";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import type { WatchOptions as BackendOptions, WatchSubscription } from "@openclaw/fs-safe/watch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceObserver } from "../../scripts/watch-node-observation.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";

// Instrument readiness only; both modes use the exact installed watch/Root and
// actual later filesystem edits. No synthetic dirty hints, sleeps, or reconcile.
const admission = vi.hoisted(() => ({
  notify: (_root: string) => {},
  subscriptions: [] as WatchSubscription[],
}));
vi.mock("@openclaw/fs-safe/watch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/watch")>();
  return {
    ...actual,
    watch(authority: Root, options: BackendOptions) {
      const subscription = actual.watch(authority, {
        ...options,
        // Native delivery, not the 30s fallback scan, must observe later edits.
        intervalMs: options.mode === "node" ? 2_147_483_647 : options.intervalMs,
      });
      admission.subscriptions.push(subscription);
      const report = (ready: Promise<void>) => {
        void ready.then(
          () => admission.notify(authority.rootReal),
          () => {},
        );
        return ready;
      };
      void report(subscription.ready);
      return {
        ...subscription,
        update(scopes: Parameters<typeof subscription.update>[0]) {
          return report(subscription.update(scopes));
        },
      };
    },
  };
});
const observers = new Set<ReturnType<typeof createSourceObserver>>();
const temp = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    admission.notify = () => {};
    admission.subscriptions.length = 0;
    __setFsSafeTestHooksForTest();
    // A test deadline can interrupt an awaited event before its finally runs.
    // Keep physical workers owned by the test lifecycle in that case too.
    await Promise.all([...observers].map((observer) => observer.close()));
    observers.clear();
    cleanup();
  });
});
async function linkDirectory(target: string, lexical: string) {
  await fs.symlink(target, lexical, process.platform === "win32" ? "junction" : "dir");
}

describe.each(["node", "poll"] as const)("developer source target edits (%s)", (mode) => {
  it.runIf(
    mode === "poll" ||
      (process.platform === "linux" && !process.versions.bun && !process.versions.deno),
  )(
    "observes later linked package/config edits and rebuilds added, retargeted, dangling links",
    async () => {
      const cwd = temp.make("source-live-");
      const outside = temp.make("source-live-target-");
      await fs.mkdir(path.join(cwd, "src"));
      await fs.mkdir(path.join(cwd, "packages"));
      await fs.mkdir(path.join(outside, "package", "src"), { recursive: true });
      await fs.mkdir(path.join(outside, "one"));
      await fs.mkdir(path.join(outside, "two"));
      const packageFile = path.join(outside, "package", "src", "main.ts");
      const configFile = path.join(outside, "config.json");
      await fs.writeFile(packageFile, "initial package");
      await fs.writeFile(configFile, "{}");
      await fs.writeFile(path.join(outside, "physical.test.ts"), "physical name is not policy");
      await fs.symlink(
        path.join(outside, "physical.test.ts"),
        path.join(cwd, "src", "imported.ts"),
        "file",
      );
      await fs.writeFile(path.join(outside, "one", "main.ts"), "one");
      await fs.writeFile(path.join(outside, "two", "main.ts"), "two");
      await linkDirectory(path.join(outside, "package"), path.join(cwd, "packages", "foo"));
      await fs.symlink(configFile, path.join(cwd, "tsconfig.json"), "file");
      let onPath: (name?: string) => void = () => {};
      let rejectPending: (error: unknown) => void = () => {};
      const errors: unknown[] = [];
      const observer = createSourceObserver(["src", "packages/foo/src", "tsconfig.json"], {
        cwd,
        env: { CHOKIDAR_USEPOLLING: mode === "poll" ? "true" : "false", CHOKIDAR_INTERVAL: "20" },
        ignored: (name) =>
          name.endsWith(".test.ts") || name.split(path.sep).includes("node_modules"),
        onChange: (name) => onPath(name),
        onError: (error) => {
          errors.push(error);
          rejectPending(error);
        },
      });
      observers.add(observer);
      const change = (lexical: string) => {
        const pending = createDeferredCore();
        onPath = (name) => {
          if (name === lexical) {
            pending.resolve();
          }
        };
        rejectPending = pending.reject;
        return pending.promise;
      };
      const nextAdmission = () => {
        const pending = createDeferredCore();
        admission.notify = (root) => {
          if (root === outside) {
            pending.resolve();
          }
        };
        rejectPending = pending.reject;
        return pending.promise;
      };
      try {
        await observer.ready;
        let changed = change(path.join(cwd, "packages", "foo", "src", "main.ts"));
        await fs.appendFile(packageFile, " later package edit");
        await changed;
        changed = change(path.join(cwd, "tsconfig.json"));
        await fs.writeFile(configFile, '{"compilerOptions":{}}');
        await changed;

        changed = change(path.join(cwd, "src", "imported.ts"));
        await fs.appendFile(path.join(outside, "physical.test.ts"), " lexical source edit");
        await changed;

        const alias = path.join(cwd, "src", "added");
        let admitted = nextAdmission();
        await linkDirectory(path.join(outside, "one"), alias);
        await admitted;
        changed = change(path.join(alias, "main.ts"));
        await fs.appendFile(path.join(outside, "one", "main.ts"), " actual later edit");
        await changed;

        admitted = nextAdmission();
        const replacement = path.join(cwd, "replacement-link");
        await linkDirectory(path.join(outside, "two"), replacement);
        // Unlink + rename also works for Windows junction targets.
        await fs.unlink(alias);
        await fs.rename(replacement, alias);
        await admitted;
        changed = change(path.join(alias, "main.ts"));
        await fs.appendFile(path.join(outside, "two", "main.ts"), " actual retarget edit");
        await changed;

        admitted = nextAdmission();
        const dangling = path.join(cwd, "src", "dangling");
        await linkDirectory(path.join(outside, "future", "deep"), dangling);
        await admitted;
        const future = path.join(outside, "future", "deep", "main.ts");
        changed = change(path.join(dangling, "main.ts"));
        await fs.mkdir(path.dirname(future), { recursive: true });
        await fs.writeFile(future, "created after admission");
        await changed;
        changed = change(path.join(dangling, "main.ts"));
        await fs.appendFile(future, " separate later edit");
        await changed;
        expect(errors).toEqual([]);
      } finally {
        await observer.close();
        observers.delete(observer);
      }
    },
  );
});

it.runIf(process.platform === "linux" && !process.versions.bun && !process.versions.deno)(
  "joins a held native development scan and never publishes stale restart hints",
  async ({ signal }) => {
    const cwd = temp.make("developer-held-scan-");
    await fs.mkdir(path.join(cwd, "src"));
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const abort = () => release.resolve();
    signal.addEventListener("abort", abort, { once: true });
    let held = false;
    __setFsSafeTestHooksForTest({
      async beforeWatchRegistration() {
        if (held) {
          return;
        }
        held = true;
        entered.resolve();
        await release.promise;
      },
    });
    const changed = vi.fn();
    const failed = vi.fn();
    const observer = createSourceObserver(["src"], {
      cwd,
      env: { CHOKIDAR_USEPOLLING: "false" },
      ignored: () => false,
      onChange: changed,
      onError: failed,
    });
    observers.add(observer);
    try {
      await entered.promise;
      let joined = false;
      const closing = observer.close().then(() => {
        joined = true;
      });
      await Promise.resolve();
      expect(joined).toBe(false);
      __setFsSafeTestHooksForTest();
      release.resolve();
      await closing;
      expect(admission.subscriptions.length).toBeGreaterThan(0);
      for (const subscription of admission.subscriptions) {
        expect(subscription.health()).toMatchObject({ state: "closed", workers: 0 });
      }
      expect(changed).not.toHaveBeenCalled();
      expect(failed).not.toHaveBeenCalled();
    } finally {
      __setFsSafeTestHooksForTest();
      release.resolve();
      signal.removeEventListener("abort", abort);
      await observer.close();
      observers.delete(observer);
    }
  },
);
