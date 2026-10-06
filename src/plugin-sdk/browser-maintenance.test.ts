/**
 * Tests browser maintenance facade loading and cleanup behavior.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const closeTrackedBrowserTabsForSessionsImpl = vi.hoisted(() => vi.fn());
const tryLoadActivatedBundledPluginPublicSurfaceModule = vi.hoisted(() => vi.fn());
const runExec = vi.hoisted(() => vi.fn());
const realMkdirSync = fs.mkdirSync.bind(fs);
const realMkdtempSync = fs.mkdtempSync.bind(fs);
const realRmSync = fs.rmSync.bind(fs);
const realWriteFileSync = fs.writeFileSync.bind(fs);
const realRealpathSyncNative = fs.realpathSync.native.bind(fs.realpathSync);
const realCpSync = fs.cpSync.bind(fs);

vi.mock("./facade-runtime.js", () => ({
  tryLoadActivatedBundledPluginPublicSurfaceModule,
}));

vi.mock("../process/exec.js", () => ({
  runExec,
}));

describe("browser maintenance", () => {
  let testRoot = "";
  let homeDir = "";
  let tmpDir = "";

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    testRoot = realRealpathSyncNative(
      realMkdtempSync(path.join(os.tmpdir(), "openclaw-browser-maintenance-")),
    );
    homeDir = path.join(testRoot, "home", "test");
    tmpDir = path.join(testRoot, "tmp");
    realMkdirSync(path.join(homeDir, ".Trash"), { recursive: true, mode: 0o700 });
    realMkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    closeTrackedBrowserTabsForSessionsImpl.mockReset();
    tryLoadActivatedBundledPluginPublicSurfaceModule.mockReset();
    runExec.mockReset();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.spyOn(os, "tmpdir").mockReturnValue(tmpDir);
    vi.spyOn(fs.realpathSync, "native").mockImplementation((candidate) =>
      realRealpathSyncNative(candidate),
    );
    tryLoadActivatedBundledPluginPublicSurfaceModule.mockResolvedValue({
      supportsSessionEntryCurrent: true,
      closeTrackedBrowserTabsForSessions: closeTrackedBrowserTabsForSessionsImpl,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (testRoot) {
      realRmSync(testRoot, { recursive: true, force: true });
    }
  });

  function writeTrashTarget(name = "demo"): string {
    const target = path.join(tmpDir, name);
    realWriteFileSync(target, "demo");
    return target;
  }

  function expectTrashDestination(
    destination: string,
    target: string,
    trashDir = path.join(homeDir, ".Trash"),
  ) {
    expect(destination.startsWith(`${trashDir}${path.sep}`)).toBe(true);
    expect(path.basename(destination)).toBe(path.basename(target));
    expect(fs.realpathSync.native(destination)).toBe(destination);
    const reservation = path.dirname(destination);
    expect(reservation).not.toBe(trashDir);
    const stat = fs.lstatSync(reservation);
    expect(stat.isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o700);
    }
  }

  function expectMovedTarget(target: string, destination: string, trashDir?: string) {
    expectTrashDestination(destination, target, trashDir);
    expect(fs.readFileSync(destination, "utf8")).toBe("demo");
    expect(fs.lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
  }

  it("skips browser cleanup when no session keys are provided", async () => {
    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");

    await expect(closeTrackedBrowserTabsForSessions({ sessionKeys: [] })).resolves.toBe(0);
    expect(tryLoadActivatedBundledPluginPublicSurfaceModule).not.toHaveBeenCalled();
  });

  it("reports unavailable browser cleanup when async activation fails", async () => {
    tryLoadActivatedBundledPluginPublicSurfaceModule.mockRejectedValue(
      new Error("activation unavailable"),
    );
    const onWarn = vi.fn();
    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");

    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:test"], onWarn }),
    ).resolves.toBe(0);
    expect(onWarn).toHaveBeenCalledWith(
      "browser cleanup unavailable: Error: activation unavailable",
    );
    expect(closeTrackedBrowserTabsForSessionsImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, () => true])(
    "delegates with owner guard %s and rechecks plugin activation before reuse",
    async (isCurrent) => {
      closeTrackedBrowserTabsForSessionsImpl.mockResolvedValue(2);
      const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");
      const params = { sessionKeys: ["agent:main:test"], isCurrent };
      await expect(closeTrackedBrowserTabsForSessions(params)).resolves.toBe(2);
      expect(tryLoadActivatedBundledPluginPublicSurfaceModule).toHaveBeenCalledWith({
        dirName: "browser",
        artifactBasename: "browser-maintenance.js",
      });
      expect(closeTrackedBrowserTabsForSessionsImpl).toHaveBeenCalledWith(params);
      tryLoadActivatedBundledPluginPublicSurfaceModule.mockResolvedValue(null);
      await expect(closeTrackedBrowserTabsForSessions(params)).resolves.toBe(0);
      expect(closeTrackedBrowserTabsForSessionsImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["activation", "preparation"] as const)(
    "does not dispatch after its owner changes during %s",
    async (phase) => {
      const entered = createDeferred();
      const release = createDeferred();
      const wait = async () => {
        entered.resolve();
        await release.promise;
        return true;
      };
      const prepareCurrent = vi.fn(wait);
      if (phase === "activation") {
        tryLoadActivatedBundledPluginPublicSurfaceModule.mockImplementationOnce(async () => {
          await wait();
          return { closeTrackedBrowserTabsForSessions: closeTrackedBrowserTabsForSessionsImpl };
        });
      }
      const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");
      let current = true;
      const cleanup = closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:test"],
        isCurrent: () => current,
        ...(phase === "preparation" ? { prepareCurrent } : {}),
      });
      try {
        await Promise.race([entered.promise, cleanup]);
        expect(tryLoadActivatedBundledPluginPublicSurfaceModule).toHaveBeenCalledOnce();
        expect(prepareCurrent).toHaveBeenCalledTimes(phase === "preparation" ? 1 : 0);
        expect(closeTrackedBrowserTabsForSessionsImpl).not.toHaveBeenCalled();
        current = false;
        release.resolve();
        await expect(cleanup).resolves.toBe(0);
        expect(closeTrackedBrowserTabsForSessionsImpl).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await cleanup;
      }
    },
  );

  it.each(["prepared", "native"] as const)(
    "keeps legacy cleanup usable but refuses an unsupported %s session check",
    async (kind) => {
      closeTrackedBrowserTabsForSessionsImpl.mockResolvedValue(2);
      tryLoadActivatedBundledPluginPublicSurfaceModule.mockResolvedValue({
        closeTrackedBrowserTabsForSessions: closeTrackedBrowserTabsForSessionsImpl,
      });
      const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");
      const sessionKeys = ["agent:main:test"];
      await expect(closeTrackedBrowserTabsForSessions({ sessionKeys })).resolves.toBe(2);
      const prepareCurrent = vi.fn(async () => true);
      const assertCurrent = vi.fn();
      const onWarn = vi.fn();
      await expect(
        closeTrackedBrowserTabsForSessions({
          sessionKeys,
          ...(kind === "prepared"
            ? { prepareCurrent }
            : {
                prepareCurrent,
                sessionEntryCurrent: {
                  source: {
                    agentId: "main",
                    path: "/synthetic/agent.sqlite",
                    sessionKey: sessionKeys[0]!,
                    databaseIdentity: "synthetic-source",
                  },
                  assertCurrent,
                },
              }),
          onWarn,
        }),
      ).resolves.toBe(0);
      expect(closeTrackedBrowserTabsForSessionsImpl).toHaveBeenCalledOnce();
      expect(prepareCurrent).not.toHaveBeenCalled();
      expect(assertCurrent).not.toHaveBeenCalled();
      expect(onWarn).toHaveBeenCalledExactlyOnceWith(
        "browser cleanup unavailable: update the Browser plugin to support session-current cleanup",
      );
    },
  );

  it("refuses an unpaired native session check from an untyped caller", async () => {
    const { closeTrackedBrowserTabsForSessions } = await import("./browser-maintenance.js");
    const onWarn = vi.fn();
    await expect(
      Reflect.apply(closeTrackedBrowserTabsForSessions, undefined, [
        {
          sessionKeys: ["agent:main:test"],
          sessionEntryCurrent: {
            source: {
              agentId: "main",
              path: "/synthetic/agent.sqlite",
              sessionKey: "agent:main:test",
              databaseIdentity: "synthetic-source",
            },
            assertCurrent: vi.fn(),
          },
          onWarn,
        },
      ]),
    ).resolves.toBe(0);
    expect(tryLoadActivatedBundledPluginPublicSurfaceModule).not.toHaveBeenCalled();
    expect(closeTrackedBrowserTabsForSessionsImpl).not.toHaveBeenCalled();
    expect(onWarn).toHaveBeenCalledExactlyOnceWith(
      "browser cleanup unavailable: sessionEntryCurrent requires prepareCurrent",
    );
  });

  it.each(["direct", "symlinked"] as const)(
    "reserves a private trash destination under a %s home without PATH commands",
    async (home) => {
      let trashDir = path.join(homeDir, ".Trash");
      if (home === "symlinked") {
        const resolvedHome = path.join(testRoot, "real", "home", "test");
        trashDir = path.join(resolvedHome, ".Trash");
        realMkdirSync(trashDir, { recursive: true, mode: 0o700 });
        realRmSync(homeDir, { recursive: true });
        fs.symlinkSync(resolvedHome, homeDir, process.platform === "win32" ? "junction" : "dir");
      } else {
        realRmSync(trashDir, { recursive: true });
      }
      const renameSync = vi.spyOn(fs, "renameSync");
      const cpSync = vi.spyOn(fs, "cpSync");
      const rmSync = vi.spyOn(fs, "rmSync");
      const { movePathToTrash } = await import("./browser-maintenance.js");
      const target = writeTrashTarget();
      const original = fs.lstatSync(target, { bigint: true });
      const moved = await movePathToTrash(target);
      expectMovedTarget(target, moved, trashDir);
      expect(runExec).not.toHaveBeenCalled();
      if (process.platform !== "win32") {
        expect(fs.lstatSync(trashDir).mode & 0o777).toBe(0o700);
      }
      expect(fs.lstatSync(moved, { bigint: true }).ino).toBe(original.ino);
      expect(renameSync).toHaveBeenCalledWith(target, moved);
      expect(cpSync).not.toHaveBeenCalled();
      expect(rmSync).not.toHaveBeenCalled();
      expect(fs.readdirSync(path.join(homeDir, ".Trash"))).toEqual([
        path.basename(path.dirname(moved)),
      ]);
    },
  );

  it.each([
    ["root", "Refusing to trash root path"],
    ["outside", "Refusing to trash path outside allowed roots"],
    ["symlink", "Refusing to use non-directory/symlink trash directory"],
  ] as const)("rejects unsafe trash %s", async (kind, message) => {
    let target = "/";
    if (kind === "outside") {
      const outsideDir = path.join(testRoot, "outside");
      realMkdirSync(outsideDir, { recursive: true });
      target = path.join(outsideDir, "openclaw-demo");
      realWriteFileSync(target, "outside");
    } else if (kind === "symlink") {
      const realTrashDir = path.join(testRoot, "real-trash");
      realRmSync(path.join(homeDir, ".Trash"), { recursive: true, force: true });
      realMkdirSync(realTrashDir, { recursive: true, mode: 0o700 });
      fs.symlinkSync(realTrashDir, path.join(homeDir, ".Trash"), "dir");
      vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
      target = writeTrashTarget();
    }
    const { movePathToTrash } = await import("./browser-maintenance.js");
    await expect(movePathToTrash(target)).rejects.toThrow(message);
  });

  it.each(["rename", "copy"] as const)(
    "retries a concurrent %s destination collision without replacing its occupant",
    async (kind) => {
      let first = "";
      let firstInode: bigint | undefined;
      const occupy = (source: fs.PathLike, destination: fs.PathLike) => {
        first = String(destination);
        realWriteFileSync(destination, "occupied");
        firstInode = fs.lstatSync(destination, { bigint: true }).ino;
        expect(fs.readFileSync(source, "utf8")).toBe("demo");
      };
      const renameSync = vi.spyOn(fs, "renameSync");
      const cpSync = vi.spyOn(fs, "cpSync");
      const rmSync = vi.spyOn(fs, "rmSync");
      if (kind === "copy") {
        renameSync.mockImplementation(() => {
          throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
        });
        cpSync.mockImplementationOnce((source, destination, options) => {
          occupy(source, destination);
          realCpSync(source, destination, options);
        });
      } else {
        renameSync.mockImplementationOnce((source, destination) => {
          occupy(source, destination);
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        });
      }
      const { movePathToTrash } = await import("./browser-maintenance.js");
      const target = writeTrashTarget();
      const original = fs.lstatSync(target, { bigint: true });
      const moved = await movePathToTrash(target);
      expectMovedTarget(target, moved);
      expectTrashDestination(first, target);
      expect(moved).not.toBe(first);
      expect(fs.readFileSync(first, "utf8")).toBe("occupied");
      expect(fs.lstatSync(first, { bigint: true }).ino).toBe(firstInode);
      if (kind === "copy") {
        expect(fs.lstatSync(moved, { bigint: true }).ino).not.toBe(original.ino);
        expect(cpSync).toHaveBeenCalledTimes(2);
        for (const [index, destination] of [first, moved].entries()) {
          expect(cpSync).toHaveBeenNthCalledWith(index + 1, target, destination, {
            recursive: true,
            force: false,
            errorOnExist: true,
          });
        }
        expect(rmSync).toHaveBeenCalledTimes(1);
        expect(rmSync).toHaveBeenCalledWith(target, { recursive: true, force: false });
      } else {
        expect(renameSync).toHaveBeenCalledTimes(2);
        expect(renameSync).toHaveBeenNthCalledWith(1, target, first);
        expect(renameSync).toHaveBeenNthCalledWith(2, target, moved);
        expect(cpSync).not.toHaveBeenCalled();
        expect(rmSync).not.toHaveBeenCalled();
      }
    },
  );
});
