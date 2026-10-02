import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import * as gatewayLocks from "../infra/gateway-lock.js";
import { hasNodeErrorCode } from "../infra/path-guards.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function attemptGatewayLockInChild(env: NodeJS.ProcessEnv): Promise<string> {
  const lockModuleUrl = pathToFileURL(path.resolve("src/infra/gateway-lock.ts")).href;
  const script = `
    const { acquireGatewayLock } = await import(${JSON.stringify(lockModuleUrl)});
    const report = (message) => process.send?.(message, () => process.exit(0));
    try {
      const lock = await acquireGatewayLock({
        allowInTests: true,
        env: process.env,
        pollIntervalMs: 2,
        timeoutMs: 15,
      });
      await lock?.release();
      report("acquired");
    } catch {
      report("blocked");
    }
  `;
  const childEnv = { ...env };
  delete childEnv.NODE_ENV;
  delete childEnv.VITEST;
  delete childEnv.VITEST_POOL_ID;
  delete childEnv.VITEST_WORKER_ID;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, "openclaw", "gateway"],
    { cwd: path.resolve("."), env: childEnv, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const message = await Promise.race([
    once(child, "message").then(([value]) => String(value)),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(
        `Gateway lock probe exited before reporting (${code ?? signal}): ${Buffer.concat(stderr).toString("utf8")}`,
      );
    }),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, "exit");
  }
  return message;
}

const workspaceStateMocks = vi.hoisted(() => ({
  deleteWorkspaceState: vi.fn(),
  prepareWorkspaceStateDeletion: vi.fn((workspaceDir: string) => ({ workspaceDir })),
}));

const fsSafeMocks = vi.hoisted(() => ({
  movePathToTrash: vi.fn(async (targetPath: string) => `${targetPath}.trashed`),
}));

vi.mock("../infra/fs-safe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/fs-safe.js")>()),
  movePathToTrash: fsSafeMocks.movePathToTrash,
}));

vi.mock("../agents/workspace-state-store.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/workspace-state-store.js")>(
    "../agents/workspace-state-store.js",
  )),
  deleteWorkspaceState: workspaceStateMocks.deleteWorkspaceState,
  prepareWorkspaceStateDeletion: workspaceStateMocks.prepareWorkspaceStateDeletion,
}));

import {
  buildCleanupPlan,
  moveToTrash,
  removePath,
  removeStateAndLinkedPaths,
  removeWorkspaceDirs,
} from "./cleanup-utils.js";

afterEach(() => {
  fsSafeMocks.movePathToTrash.mockReset();
  fsSafeMocks.movePathToTrash.mockImplementation(
    async (targetPath: string) => `${targetPath}.trashed`,
  );
  vi.restoreAllMocks();
});

async function cleanupFixture(configOutside = false, configRaw = "{}") {
  const tmpRoot = await fs.realpath(tempDirs.make("openclaw-cleanup-"));
  const stateDir = path.join(tmpRoot, "state");
  const configPath = path.join(configOutside ? tmpRoot : stateDir, "openclaw.json");
  await fs.mkdir(stateDir);
  await fs.writeFile(configPath, configRaw);
  const runtime = createRuntimeMock();
  const paths = {
    stateDir,
    configPath,
    oauthDir: path.join(stateDir, "credentials"),
    configInsideState: !configOutside,
    oauthInsideState: true,
  };
  return {
    tmpRoot,
    ...paths,
    runtime,
    env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir },
    remove: (
      overrides: Partial<typeof paths> = {},
      options?: Parameters<typeof removeStateAndLinkedPaths>[2],
    ) => removeStateAndLinkedPaths({ ...paths, ...overrides }, runtime, options),
  };
}

function pauseRemovalAt(pathname: string) {
  const started = createDeferred(),
    resumed = createDeferred();
  const rm = fs.rm;
  const spy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
    if (target === pathname) {
      started.resolve();
      await resumed.promise;
    }
    return rm(target, options);
  });
  return { started: started.promise, resume: resumed.resolve, restore: () => spy.mockRestore() };
}

function createRuntimeMock() {
  return {
    log: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  } as unknown as RuntimeEnv & {
    log: ReturnType<typeof vi.fn<(message: string) => void>>;
    error: ReturnType<typeof vi.fn<(message: string) => void>>;
  };
}

describe("moveToTrash", () => {
  it("retains the target when ownership expires during asynchronous preparation", async () => {
    const targetPath = path.join(tempDirs.make("openclaw-trash-expired-"), "target");
    await fs.writeFile(targetPath, "retain me");
    let owned = true;
    const removal = moveToTrash(targetPath, createTestRuntime(), () => {
      if (!owned) {
        throw new Error("cleanup ownership expired");
      }
    });
    owned = false;

    await expect(removal).resolves.toBe(false);
    expect(fsSafeMocks.movePathToTrash).not.toHaveBeenCalled();
    expect(await fs.readFile(targetPath, "utf8")).toBe("retain me");
  });

  it("allows fs-safe trash to move a symlink whose target resolves outside the parent", async () => {
    const testRoot = tempDirs.make("openclaw-trash-symlink-");
    const targetPath = path.join(testRoot, "target-link");
    const outsideTarget = path.join(os.tmpdir(), "openclaw-trash-symlink-target");
    fsSync.writeFileSync(targetPath, "link placeholder");
    vi.spyOn(fs, "lstat").mockResolvedValue({
      isSymbolicLink: () => true,
    } as fsSync.Stats);
    vi.spyOn(fs, "realpath").mockImplementation(async (candidate) =>
      String(candidate) === path.dirname(targetPath) ? path.dirname(targetPath) : outsideTarget,
    );
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;

    await moveToTrash(targetPath, runtime);

    expect(fsSafeMocks.movePathToTrash).toHaveBeenCalledWith(targetPath, {
      allowedRoots: [path.dirname(targetPath), path.dirname(outsideTarget)],
    });
  });

  it("moves a dangling symlink instead of treating it as already removed", async () => {
    const testRoot = tempDirs.make("openclaw-trash-dangling-link-");
    const targetPath = path.join(testRoot, "workspace-link");
    fsSync.symlinkSync(path.join(testRoot, "missing-target"), targetPath, "dir");
    const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
    const sourcePath = path.join(fsSync.realpathSync(testRoot), "workspace-link");

    await expect(moveToTrash(targetPath, runtime)).resolves.toBe(true);

    expect(fsSafeMocks.movePathToTrash).toHaveBeenCalledWith(sourcePath, {
      allowedRoots: [path.dirname(sourcePath)],
    });
  });
});

test("buildCleanupPlan resolves inside-state flags and workspace dirs", () => {
  const tmpRoot = path.join(path.parse(process.cwd()).root, "tmp");
  const defaultWorkspace = path.join(tmpRoot, "openclaw-workspace-default");
  const opsWorkspace = path.join(tmpRoot, "openclaw-workspace-ops");
  const cfg = {
    agents: {
      defaults: { workspace: defaultWorkspace },
      entries: { main: {}, ops: { workspace: opsWorkspace } },
    },
  };
  const plan = buildCleanupPlan({
    cfg: cfg as unknown as OpenClawConfig,
    stateDir: path.join(tmpRoot, "openclaw-state"),
    configPath: path.join(tmpRoot, "openclaw-state", "openclaw.json"),
    oauthDir: path.join(tmpRoot, "openclaw-oauth"),
  });

  expect(plan).toMatchObject({ configInsideState: true, oauthInsideState: false });
  expect(new Set(plan.workspaceDirs)).toEqual(
    new Set([path.join(defaultWorkspace, "main"), opsWorkspace]),
  );
});

describe("cleanup path removals", () => {
  beforeEach(() => {
    workspaceStateMocks.deleteWorkspaceState.mockClear();
  });

  it("returns failure when any linked dry-run target is unsafe", async () => {
    const runtime = createRuntimeMock();
    await expect(
      removeStateAndLinkedPaths(
        {
          stateDir: "/tmp/openclaw-cleanup/state",
          configPath: path.parse(process.cwd()).root,
          oauthDir: "/tmp/openclaw-cleanup/oauth",
          configInsideState: false,
          oauthInsideState: false,
        },
        runtime,
        { dryRun: true },
      ),
    ).resolves.toBe(false);
  });

  it("keeps the canonical state lock visible until state removal completes", async () => {
    const { stateDir, env, remove } = await cleanupFixture();
    const markerPath = path.join(stateDir, "keep.txt");
    await fs.writeFile(markerPath, "remove me");
    const pause = pauseRemovalAt(markerPath);

    try {
      const cleanup = remove();
      await pause.started;

      await expect(
        gatewayLocks.acquireGatewayLock({
          allowInTests: true,
          env,
          pollIntervalMs: 2,
          timeoutMs: 15,
        }),
      ).rejects.toBeInstanceOf(gatewayLocks.GatewayLockError);

      pause.resume();
      await expect(cleanup).resolves.toBe(true);
      await expect(fs.access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      pause.resume();
      pause.restore();
    }
  });

  it.each(["shared", "separate"] as const)(
    "retains current and published Gateway exclusion through linked-path cleanup (%s lock directory)",
    async (layout) => {
      const { stateDir, configPath, env, remove } = await cleanupFixture(true, "{}\n");
      const markerPath = path.join(stateDir, "marker.txt");
      const lockDir =
        layout === "shared" ? resolveGatewayLockDir(stateDir) : path.join(stateDir, "custom-locks");
      const acquire = gatewayLocks.acquireGatewayLock;
      let cleanupLock: Awaited<ReturnType<typeof acquire>> | undefined;
      vi.spyOn(gatewayLocks, "acquireGatewayLock").mockImplementation(async (options) => {
        cleanupLock = await acquire({ ...options, lockDir });
        return cleanupLock;
      });
      await fs.writeFile(markerPath, "remove me");
      const pause = pauseRemovalAt(configPath);

      try {
        const cleanup = remove();
        await pause.started;

        const held = expectDefined(cleanupLock, "cleanup ownership");
        for (const lockPath of [held.lockPath, held.stateLockPath]) {
          expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toMatchObject({
            pid: process.pid,
          });
        }
        const stateLockPath = held.stateLockPath;
        let legacyBlocked = false;
        let legacyDescriptor: number | undefined;
        try {
          // Published 2026.9.4 startup must exclusively create this same marker.
          fsSync.mkdirSync(path.dirname(stateLockPath), { recursive: true });
          legacyDescriptor = fsSync.openSync(stateLockPath, "wx", 0o600);
        } catch (error) {
          if (!hasNodeErrorCode(error, "EEXIST")) {
            throw error;
          }
          legacyBlocked = true;
        } finally {
          if (legacyDescriptor !== undefined) {
            fsSync.closeSync(legacyDescriptor);
            fsSync.unlinkSync(stateLockPath);
          }
        }
        const lockAttempt = await attemptGatewayLockInChild(env);
        pause.resume();
        const [cleanupResult] = await Promise.allSettled([cleanup]);

        expect(legacyBlocked).toBe(true);
        expect(lockAttempt).toBe("blocked");
        expect(cleanupResult).toEqual({ status: "fulfilled", value: true });
        await expect(fs.access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        pause.resume();
        pause.restore();
      }
    },
  );

  it("fails without removing state recreated during cleanup finalization", async () => {
    const { stateDir, remove } = await cleanupFixture(false);
    const lockDir = resolveGatewayLockDir(stateDir);
    const recreatedPath = path.join(lockDir, "new-owner.txt");
    const realRmdir = fs.rmdir;
    vi.spyOn(fs, "rmdir").mockImplementation(async (target) => {
      if (target === path.dirname(lockDir)) {
        await fs.mkdir(lockDir, { recursive: true });
        await fs.writeFile(recreatedPath, "active");
      }
      return await realRmdir(target);
    });

    await expect(remove()).rejects.toThrow(/interrupted by a new state operation/);
    await expect(fs.readFile(recreatedPath, "utf8")).resolves.toBe("active");
  });

  it.each(["lock directory", "state directory"] as const)(
    "preserves a replacement empty %s after cleanup ownership releases",
    async (replacement) => {
      const { tmpRoot, stateDir, remove } = await cleanupFixture(false);
      const lockDir = resolveGatewayLockDir(stateDir);
      const target = replacement === "lock directory" ? lockDir : stateDir;
      await fs.mkdir(lockDir, { recursive: true });
      const previous = await fs.lstat(target, { bigint: true });
      const acquire = gatewayLocks.acquireGatewayLock;
      vi.spyOn(gatewayLocks, "acquireGatewayLock").mockImplementation(async (options) => {
        const held = expectDefined(await acquire(options), "cleanup ownership");
        const release = held.release;
        vi.spyOn(held, "release").mockImplementation(async () => {
          await release();
          await fs.rename(target, path.join(tmpRoot, "retired-directory"));
          await fs.mkdir(target);
        });
        return held;
      });

      await expect(remove()).rejects.toThrow(/interrupted by a new state operation/);
      const current = await fs.lstat(target, { bigint: true });
      expect(current.ino).not.toBe(previous.ino);
      expect(await fs.readdir(target)).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects an aliased OAuth cleanup target containing held ownership before removing state",
    async () => {
      const { tmpRoot, stateDir, configPath, remove } = await cleanupFixture(true);
      const alias = path.join(tmpRoot, "state-alias");
      const marker = path.join(stateDir, "retain.txt");
      await fs.symlink(stateDir, alias, "dir");
      await fs.writeFile(marker, "retained");
      const linkedLockDir = path.join(
        alias,
        path.relative(stateDir, resolveGatewayLockDir(stateDir)),
      );

      await expect(remove({ oauthDir: linkedLockDir, oauthInsideState: false })).rejects.toThrow(
        /linked cleanup path.*active state lock/,
      );
      expect(await fs.readFile(marker, "utf8")).toBe("retained");
      expect(await fs.lstat(alias).then((entry) => entry.isSymbolicLink())).toBe(true);
      expect(await fs.readFile(configPath, "utf8")).toBe("{}");
    },
  );

  it.skipIf(process.platform === "win32").each(["inside", "database file"] as const)(
    "refuses cleanup before deletion when the lock namespace is redirected (%s)",
    async (location) => {
      const { stateDir, configPath, remove } = await cleanupFixture(true);
      const redirected = path.join(stateDir, "runtime");
      const marker = path.join(stateDir, "retain.txt");
      await fs.mkdir(redirected, { recursive: true });
      const alias =
        location === "database file"
          ? path.join(stateDir, "state", "openclaw.sqlite")
          : path.join(stateDir, "tmp");
      if (location === "database file") {
        await fs.mkdir(path.dirname(alias));
        const database = path.join(redirected, "openclaw.sqlite");
        await fs.writeFile(database, "");
        await fs.symlink(database, alias);
      } else {
        await fs.symlink(redirected, alias, "dir");
      }
      await fs.writeFile(marker, "retained");

      const removal = remove();
      await expect(removal).rejects.toThrow(/active (?:lock directory|database path).*redirected/);
      expect(await fs.readFile(marker, "utf8")).toBe("retained");
      expect(await fs.readFile(configPath, "utf8")).toBe("{}");
      expect(await fs.lstat(alias).then((entry) => entry.isSymbolicLink())).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans a state directory reached through a symbolic-link alias",
    async () => {
      const { tmpRoot, stateDir, configPath, remove } = await cleanupFixture(true);
      const stateAlias = path.join(tmpRoot, "state-alias");
      await fs.writeFile(path.join(stateDir, "marker.txt"), "remove me");
      await fs.symlink(stateDir, stateAlias, "dir");

      await expect(
        remove({ stateDir: stateAlias, oauthDir: path.join(stateAlias, "credentials") }),
      ).resolves.toBe(true);

      await expect(fs.access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(stateAlias)).rejects.toMatchObject({ code: "ENOENT" });
      await fs.mkdir(stateAlias);
      await expect(fs.stat(stateAlias).then((stat) => stat.isDirectory())).resolves.toBe(true);
      await expect(fs.access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves linked paths when guarded state removal fails", async () => {
    const { tmpRoot, stateDir, configPath, remove } = await cleanupFixture(true, "{}\n");
    const oauthDir = path.join(tmpRoot, "credentials");
    const oauthPath = path.join(oauthDir, "token.json");
    const markerPath = path.join(stateDir, "marker.txt");
    await fs.mkdir(oauthDir);
    await fs.writeFile(markerPath, "remove me");
    await fs.writeFile(oauthPath, "keep me");
    const realRm = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === markerPath) {
        throw new Error("simulated state removal failure");
      }
      return await realRm(target, options);
    });

    await expect(remove({ oauthDir, oauthInsideState: false })).rejects.toThrow(
      /Failed to remove non-preserved OpenClaw state/,
    );
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe("{}\n");
    await expect(fs.readFile(oauthPath, "utf8")).resolves.toBe("keep me");
  });

  it.each(["lock overlap", "inspection failure"] as const)(
    "retains state when workspace preservation encounters %s",
    async (failure) => {
      const { stateDir, configPath, remove } = await cleanupFixture(failure === "lock overlap");
      const parent = failure === "lock overlap" ? resolveGatewayLockDir(stateDir) : stateDir;
      const workspaceDir = path.join(parent, "workspace");
      const workspaceFile = path.join(workspaceDir, "project.txt");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(workspaceFile, "keep me");
      const error = Object.assign(new Error("workspace inspection denied"), { code: "EACCES" });
      if (failure === "inspection failure") {
        vi.spyOn(fs, "lstat").mockRejectedValueOnce(error);
      }
      const rm = vi.spyOn(fs, "rm");
      const removal = remove({}, { preservePaths: [workspaceDir] });
      if (failure === "inspection failure") {
        await expect(removal).rejects.toBe(error);
        expect(rm).not.toHaveBeenCalled();
      } else {
        await expect(removal).rejects.toThrow(/overlaps the active state lock/);
      }
      expect(await fs.readFile(workspaceFile, "utf8")).toBe("keep me");
      expect(await fs.readFile(configPath, "utf8")).toBe("{}");
    },
  );

  it("preserves nested workspace paths during state-only removal", async () => {
    const { stateDir, configPath, remove } = await cleanupFixture();
    const workspaceDir = path.join(stateDir, "tmp", "workspace");
    const workspaceFile = path.join(workspaceDir, "project.txt");
    const cacheFile = path.join(stateDir, "cache.json");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(workspaceFile, "keep me");
    await fs.writeFile(cacheFile, "remove me");
    await remove({}, { preservePaths: [workspaceDir] });
    await expect(fs.readFile(workspaceFile, "utf8")).resolves.toBe("keep me");
    await expect(fs.stat(configPath)).rejects.toThrow();
    await expect(fs.stat(cacheFile)).rejects.toThrow();
  });

  it.each(["remove", "preview", "failure"] as const)(
    "settles workspace rows after filesystem %s",
    async (operation) => {
      const runtime = createRuntimeMock();
      const workspaceDir = path.join(tempDirs.make("openclaw-cleanup-workspace-"), "workspace");
      await fs.mkdir(workspaceDir);
      const siblingMarker = `${workspaceDir}.attested`;
      if (operation === "preview") {
        await fs.writeFile(
          siblingMarker,
          "openclaw-workspace-attestation:v1\n2026-07-15T11:00:00.000Z\n",
        );
      } else if (operation === "failure") {
        vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("permission denied"));
      }
      await removeWorkspaceDirs([workspaceDir], runtime, {
        dryRun: operation === "preview",
        removeStateRows: true,
      });
      if (operation === "remove") {
        await expect(fs.stat(workspaceDir)).rejects.toThrow();
        expect(workspaceStateMocks.deleteWorkspaceState).toHaveBeenCalledWith({ workspaceDir });
      } else {
        expect(workspaceStateMocks.deleteWorkspaceState).not.toHaveBeenCalled();
        if (operation === "preview") {
          expect(runtime.log).toHaveBeenCalledWith(`[dry-run] remove ${siblingMarker}`);
          await expect(fs.lstat(siblingMarker)).resolves.toBeDefined();
        }
      }
    },
  );

  it("continues after an injected workspace remover rejects", async () => {
    const runtime = createRuntimeMock();
    const removeWorkspace = vi
      .fn<(workspace: string) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("trash unavailable"))
      .mockResolvedValueOnce(true);

    const failures = await removeWorkspaceDirs(["/tmp/first", "/tmp/second"], runtime, {
      removeWorkspace,
    });

    expect(removeWorkspace).toHaveBeenCalledTimes(2);
    expect(failures).toEqual(["/tmp/first"]);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("trash unavailable"));
  });

  it("refuses to remove the current working directory", async () => {
    const runtime = createRuntimeMock();
    const result = await removePath(process.cwd(), runtime, { dryRun: true });

    expect(result.ok).toBe(false);
    expect(runtime.error.mock.calls).toEqual([
      [expect.stringMatching(/Refusing to remove unsafe path/)],
    ]);
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
