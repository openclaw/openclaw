import fs from "node:fs/promises";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe/root";
import type {
  WatchDirty,
  WatchFunction,
  WatchHealth,
  WatchOptions,
  WatchScope,
  WatchSubscription,
} from "@openclaw/fs-safe/watch";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";

export function waitForSkillsWatcherTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Domain seam only: real admitted Roots, no emulated scans or physical engine. */
export function createSkillsWatcherMock() {
  const subscriptions: Array<ReturnType<typeof createSubscription>> = [];
  const logicalPaths = new WeakMap<WatchScope, string>();
  function createSubscription(authority: Root, options: WatchOptions) {
    const ready = createDeferredCore();
    void ready.promise.catch(() => {});
    let state: WatchHealth["state"] = "starting";
    let failure: WatchHealth["failure"];
    let error: unknown;
    let closeBarrier = Promise.resolve();
    let closing: Promise<void> | undefined;
    const health = (): WatchHealth => ({
      state,
      generation: 1,
      mode: options.mode ?? "node",
      directories: 0,
      observedDirectories: 0,
      workers: 0,
      scannedEntries: 0,
      reconciliations: 0,
      pendingInvalidations: 0,
      error,
      failure,
    });
    const close = vi.fn(() => {
      if (closing) return closing;
      state = "closing";
      ready.reject(new DOMException("Retired", "AbortError"));
      closing = closeBarrier.then(() => {
        state = "closed";
      });
      return closing;
    });
    const subscription: WatchSubscription = {
      ready: ready.promise,
      update: vi.fn(async () => {}),
      reconcile: vi.fn(async () => {}),
      health,
      close,
      [Symbol.asyncDispose]: close,
    };
    return {
      authority,
      options,
      subscription,
      close,
      get closed() {
        return state === "closing" || state === "closed";
      },
      settleReady() {
        if (state !== "starting") return;
        options.onDirty({ generation: 1, scopes: options.scopes, reason: "reconcile" });
        state = "ready";
        ready.resolve();
      },
      dirty(changes?: WatchDirty["changes"], reason: WatchDirty["reason"] = "event") {
        // Deliberately deliver even after close: caller lifetime fencing is under test.
        options.onDirty({ generation: 1, scopes: options.scopes, reason, changes });
      },
      change(absolutePath: string, type: "content" | "structural" = "structural") {
        this.dirty([{ path: path.relative(authority.rootDir, absolutePath), type }]);
      },
      fail(cause: unknown, info: NonNullable<WatchHealth["failure"]> = { operation: "scan" }) {
        if (!closing) {
          error = cause;
          failure = info;
          state = "unavailable";
        }
        options.onHealth?.({ ...health(), state: "unavailable", error: cause, failure: info });
        ready.reject(cause);
      },
      holdClose(barrier: Promise<void>) {
        closeBarrier = barrier;
      },
    };
  }
  const watchMock = vi.fn<WatchFunction>((authority, options) => {
    const observed = createSubscription(authority, options);
    subscriptions.push(observed);
    return observed.subscription;
  });
  function forRoot(root: string, includeClosed = false) {
    const observed = subscriptions.findLast(
      (entry) =>
        (includeClosed || !entry.closed) &&
        entry.options.scopes.some(
          (scope) =>
            (logicalPaths.get(scope) ?? path.resolve(entry.authority.rootDir, scope.path)) ===
            path.resolve(root),
        ),
    );
    expect(observed, "observation for " + root).toBeDefined();
    return observed!;
  }
  const scopePlans: Promise<unknown>[] = [];
  async function trackPlanning() {
    scopePlans.length = 0;
    const owner = await import("./refresh-observation-source.js");
    const original = owner.skillsObservationScope;
    vi.spyOn(owner, "skillsObservationScope").mockImplementation((...args) => {
      const plan = original(...args).then((scope) => {
        // Several logical descendants can collapse to the same lexical link entry.
        logicalPaths.set(scope, path.resolve(args[1].path));
        return scope;
      });
      scopePlans.push(plan.catch(() => {}));
      return plan;
    });
  }
  async function started() {
    await Promise.resolve();
    const { pathWatchers } = await import("./refresh-watch-registry.js");
    await Promise.all([...pathWatchers.values()].map((state) => state.authority?.catch(() => {})));
    await Promise.resolve();
    await Promise.all(scopePlans.splice(0));
    await waitForSkillsWatcherTurn();
  }
  async function readyAll() {
    await started();
    for (const subscription of subscriptions) subscription.settleReady();
    await waitForSkillsWatcherTurn();
  }
  return { subscriptions, watchMock, forRoot, started, readyAll, trackPlanning };
}

export function useSkillsWatcherFixture(
  mock?: ReturnType<typeof createSkillsWatcherMock>,
  options: { expectedShutdownFailure?: boolean; resetModulesAfterCleanup?: boolean } = {},
) {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      const { closeSkillsWatchers } = await import("./refresh.js");
      try {
        if (options.expectedShutdownFailure) {
          await expect(closeSkillsWatchers(true)).rejects.toThrow("Skills watcher shutdown failed");
        } else {
          await closeSkillsWatchers(true);
        }
      } finally {
        vi.restoreAllMocks();
        vi.useRealTimers();
        vi.unstubAllEnvs();
        cleanup();
        if (options.resetModulesAfterCleanup) vi.resetModules();
      }
    }),
  );
  let fixtureRoot: string;
  let workspaceDir: string;
  async function createFixtureDirectory(relative: string) {
    const directory = path.join(fixtureRoot, relative);
    await fs.mkdir(directory, { recursive: true });
    return directory;
  }
  beforeEach(async () => {
    fixtureRoot = await fs.realpath(tempDirs.make("openclaw-watch-fixture-"));
    workspaceDir = await createFixtureDirectory("workspace");
    await createFixtureDirectory("workspace/skills");
    vi.stubEnv("OPENCLAW_STATE_DIR", await createFixtureDirectory("state"));
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    if (mock) {
      mock.watchMock.mockClear();
      mock.subscriptions.length = 0;
      await mock.trackPlanning();
    }
  });
  return {
    createFixtureDirectory,
    get workspaceDir() {
      return workspaceDir;
    },
    get root() {
      return fixtureRoot;
    },
  };
}
