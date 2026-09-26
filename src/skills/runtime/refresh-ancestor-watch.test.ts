import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createSkillsWatcherMock,
  useSkillsWatcherFixture,
  waitForSkillsWatcherTurn,
} from "./refresh.watcher.test-support.js";

const {
  createdWatchers,
  watchMock,
  nativeWatchMock,
  nativeContentWatchMock,
  watchForSkillRoot,
  readyAll,
} = createSkillsWatcherMock();
vi.mock("chokidar", () => ({ default: { watch: watchMock } }));
vi.mock("./refresh-ancestor-native.js", () => ({
  createNativeSkillsAncestorWatcher: nativeWatchMock,
}));
vi.mock("./refresh-content-native.js", () => ({
  createNativeSkillsContentWatcher: nativeContentWatchMock,
}));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

let refresh: typeof import("./refresh.js");
let ancestor: typeof import("./refresh-ancestor-watch.js");
describe("skills ancestor observation scope", () => {
  const fixture = useSkillsWatcherFixture();
  beforeAll(async () => {
    refresh = await import("./refresh.js");
    ancestor = await import("./refresh-ancestor-watch.js");
  });
  beforeEach(() => {
    watchMock.mockClear();
    createdWatchers.length = 0;
  });

  it.each([false, true])(
    "retains observation scope through live, replayed and retirement errors (polling: %s)",
    async (usePolling) => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const releaseClose = createDeferredCore();
      const releases: Array<() => Promise<unknown>> = [];
      try {
        // This exercises transport ownership on every host, not native macOS delivery.
        Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
        const root = await fixture.createFixtureDirectory("parent/observed");
        const observationRoot = usePolling ? root : path.dirname(root);
        const subscription = () => ({
          path: path.join(root, "skills"),
          ignored: () => false,
          ready: vi.fn(),
          unavailable: vi.fn(),
          reconcile: vi.fn(),
          changed: vi.fn(),
          raw: vi.fn(),
          error: vi.fn<(error: Error, observedRoot: string) => void>(),
        });
        const first = subscription();
        const retained = ancestor.acquireSkillsAncestorWatcher(root, usePolling, first);
        releases.push(retained.release);
        const watcher = expectDefined(createdWatchers.at(-1), "ancestor watcher");
        if (usePolling) {
          expect(watcher.add).not.toHaveBeenCalled();
        } else {
          expect(watcher.add).toHaveBeenCalledExactlyOnceWith(observationRoot);
        }
        watcher.emit("ready");
        const loss = Object.assign(new Error("aggregate observer lost"), { code: "EIO" });
        watcher.emit("error", loss);
        expect(first.error).toHaveBeenCalledExactlyOnceWith(loss, observationRoot);
        expect(first.error.mock.calls[0]?.[0]).toBe(loss);

        const retirementError = new Error("aggregate retirement failed");
        const close = watcher.close.getMockImplementation()!;
        watcher.close.mockImplementationOnce(async () => {
          await close();
          await releaseClose.promise;
          throw retirementError;
        });
        const late = subscription();
        releases.push(ancestor.acquireSkillsAncestorWatcher(root, usePolling, late).release);
        await waitForSkillsWatcherTurn();
        expect(watcher.closed).toBe(true);
        expect(late.error).toHaveBeenCalledExactlyOnceWith(loss, observationRoot);
        expect(late.error.mock.calls[0]?.[0]).toBe(loss);
        releaseClose.resolve();
        await waitForSkillsWatcherTurn();
        for (const current of [first, late]) {
          expect(current.error).toHaveBeenCalledTimes(2);
          expect(current.error).toHaveBeenLastCalledWith(retirementError, observationRoot);
          expect(current.error.mock.lastCall?.[0]).toBe(retirementError);
        }
        const quarantined = subscription();
        releases.push(ancestor.acquireSkillsAncestorWatcher(root, usePolling, quarantined).release);
        await waitForSkillsWatcherTurn();
        expect(quarantined.error).toHaveBeenCalledExactlyOnceWith(retirementError, observationRoot);
        expect(quarantined.error.mock.calls[0]?.[0]).toBe(retirementError);
        expect(watchMock).toHaveBeenCalledOnce();
        expect(watcher.close).toHaveBeenCalledOnce();
        const result = await retained.release();
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBe(retirementError);
        }
      } finally {
        releaseClose.resolve();
        try {
          await Promise.all(releases.map((release) => release()));
        } finally {
          Object.defineProperty(process, "platform", platform);
        }
      }
    },
  );

  it("retains parent observation loss for a later sibling after release and shutdown", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    let peer: ReturnType<typeof watchMock> | undefined;
    try {
      // The independent mock models a peer retaining the stock parent's native pool.
      // Real macOS filesystem delivery is qualified separately by integration CI.
      Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
      vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
      const firstRoot = await fixture.createFixtureDirectory("pooled-parent/first");
      const laterRoot = await fixture.createFixtureDirectory("pooled-parent/later");
      const parent = path.dirname(firstRoot.replaceAll("\\", "/"));
      const first = {
        workspaceDir: fixture.workspaceDir,
        config: { skills: { load: { extraDirs: [path.join(firstRoot, "skills")] } } },
      };
      refresh.ensureSkillsWatcher(first);
      await readyAll();
      expect(refresh.reconcileSkillsWatcherCoverage(first)).toBe(true);
      const active = watchForSkillRoot(path.join(firstRoot, "skills"));
      expect(active.watchRoot).toBe(firstRoot.replaceAll("\\", "/"));
      expect(active.watcher.add).toHaveBeenCalledExactlyOnceWith(parent);
      peer = watchMock(parent, { ...active.options, ignored: () => false });
      peer.emit("ready");
      active.watcher.emit(
        "error",
        Object.assign(new Error("shared parent observer lost"), { code: "EIO" }),
      );
      await readyAll();
      expect(refresh.reconcileSkillsWatcherCoverage(first)).toBe(false);
      refresh.ensureSkillsWatcher({
        ...first,
        config: { skills: { load: { watch: false } } },
      });
      await waitForSkillsWatcherTurn();
      await refresh.closeSkillsWatchers();
      expect(peer.closed).toBe(false);

      const later = {
        workspaceDir: await fixture.createFixtureDirectory("later-workspace"),
        config: { skills: { load: { extraDirs: [path.join(laterRoot, "skills")] } } },
      };
      const changed = vi.fn();
      refresh.registerSkillsChangeListener(changed);
      refresh.ensureSkillsWatcher(later);
      await readyAll();
      const current = watchForSkillRoot(path.join(laterRoot, "skills"));
      expect(current.watchRoot).toBe(laterRoot.replaceAll("\\", "/"));
      expect(current.watcher.add).toHaveBeenCalledExactlyOnceWith(parent);
      expect(refresh.reconcileSkillsWatcherCoverage(later)).toBe(false);
      const admissions = watchMock.mock.calls.length;
      refresh.ensureSkillsWatcher(later);
      refresh.ensureSkillsWatcher(later);
      expect(watchMock).toHaveBeenCalledTimes(admissions);
      expect(
        changed.mock.calls.some(
          ([event]) =>
            event.workspaceDir === later.workspaceDir && event.reason === "watch-available",
        ),
      ).toBe(false);
      const healthy = { workspaceDir: fixture.workspaceDir };
      refresh.ensureSkillsWatcher(healthy);
      await readyAll();
      expect(refresh.reconcileSkillsWatcherCoverage(healthy)).toBe(true);
      expect(peer.closed).toBe(false);
    } finally {
      try {
        await refresh.closeSkillsWatchers();
      } finally {
        try {
          await peer?.close();
        } finally {
          Object.defineProperty(process, "platform", platform);
        }
      }
    }
  });
});
