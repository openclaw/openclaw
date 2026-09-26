import fs from "node:fs/promises";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe/root";
import type {
  WatchInvalidation,
  watch,
  WatchHealth,
  WatchOptions,
  WatchScope,
  WatchSubscription,
} from "@openclaw/fs-safe/watch";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { CONFIG_DIR } from "../../utils.js";

export function waitForSkillsWatcherTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
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
    let closeBarrier = Promise.resolve();
    let closing: Promise<void> | undefined;
    const health = (): WatchHealth => ({
      state,
      mode: options.mode === "poll" ? "poll" : "events",
      directories: 0,
      failure,
    });
    const close = vi.fn(() => {
      if (closing) {
        return closing;
      }
      ready.reject(new DOMException("Retired", "AbortError"));
      closing = closeBarrier.then(() => {
        state = "closed";
      });
      return closing;
    });
    const subscription: WatchSubscription = {
      ready: ready.promise,
      setScopes: vi.fn(async () => {}),
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
        return closing !== undefined;
      },
      settleReady() {
        if (state !== "starting") {
          return;
        }
        options.onInvalidate({ reason: "reconcile" });
        state = "ready";
        options.onHealth?.(health());
        ready.resolve();
      },
      dirty(changes?: WatchInvalidation["changes"], reason: WatchInvalidation["reason"] = "event") {
        // Deliberately deliver even after close: caller lifetime fencing is under test.
        options.onInvalidate({ reason, changes });
      },
      change(absolutePath: string, type: "content" | "structural" = "structural") {
        this.dirty([{ path: path.relative(authority.rootDir, absolutePath), type }]);
      },
      fail(
        cause: unknown,
        info: Omit<NonNullable<WatchHealth["failure"]>, "error"> = { operation: "scan" },
      ) {
        if (!closing) {
          failure = { ...info, error: cause };
          state = "unavailable";
        }
        options.onHealth?.({
          ...health(),
          state: "unavailable",
          failure: { ...info, error: cause },
        });
        ready.reject(cause);
      },
      holdClose(barrier: Promise<void>) {
        closeBarrier = barrier;
      },
    };
  }
  const watchMock = vi.fn<typeof watch>((authority, options) => {
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
    await Promise.all(
      [...pathWatchers.values()].flatMap((state) =>
        state.authority ? [state.authority.catch(() => {})] : [],
      ),
    );
    await Promise.resolve();
    await Promise.all(scopePlans.splice(0));
    await waitForSkillsWatcherTurn();
  }
  async function readyAll() {
    await started();
    const admitted = [...subscriptions];
    for (const subscription of admitted) {
      subscription.settleReady();
    }
    await Promise.allSettled(admitted.map((entry) => entry.subscription.ready));
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
        if (options.resetModulesAfterCleanup) {
          vi.resetModules();
        }
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
    // Runtime initialization must not move unrelated shared roots mid-case.
    await fs.mkdir(CONFIG_DIR, { recursive: true });
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
