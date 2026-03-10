import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { backupRestoreCommand, buildRestoreOperations } from "./backup-restore.js";
import { normalizeArchiveRoot, parseBackupManifest } from "./backup-verify.js";
import { backupCreateCommand } from "./backup.js";

const { serviceIsLoaded, serviceStop } = vi.hoisted(() => ({
  serviceIsLoaded: vi.fn(async () => false),
  serviceStop: vi.fn(async (_args?: { stdout: NodeJS.WritableStream }) => undefined),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    isLoaded: serviceIsLoaded,
    stop: serviceStop,
  }),
}));

describe("backup restore", () => {
  let tempHome: TempHomeEnv;
  let runtime: RuntimeEnv;
  let previousCwd: string;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-restore-test-");
    previousCwd = process.cwd();
    serviceIsLoaded.mockClear();
    serviceStop.mockClear();
    serviceIsLoaded.mockResolvedValue(false);
    serviceStop.mockResolvedValue(undefined);
    runtime = {
      log: vi.fn() as RuntimeEnv["log"],
      error: vi.fn() as RuntimeEnv["error"],
      exit: vi.fn() as RuntimeEnv["exit"],
    };
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await tempHome.restore();
  });

  it("restores a full-host backup archive into the current installation layout", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const externalWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-ws-"));
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-archive-"));
    try {
      await fs.mkdir(externalWorkspace, { recursive: true });
      await fs.writeFile(path.join(externalWorkspace, "SOUL.md"), "# external\n", "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: {
              workspace: externalWorkspace,
            },
          },
        }),
        "utf8",
      );

      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
        includeWorkspace: true,
      });

      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(externalWorkspace, { recursive: true, force: true });

      const restored = await backupRestoreCommand(runtime, {
        archive: created.archivePath,
        mode: "full-host",
      });

      expect(restored.mode).toBe("full-host");
      expect(restored.restoredTargets).toEqual(
        expect.arrayContaining([stateDir, externalWorkspace]),
      );
      expect(await fs.readFile(path.join(stateDir, "state.txt"), "utf8")).toBe("state\n");
      expect(await fs.readFile(path.join(externalWorkspace, "SOUL.md"), "utf8")).toBe(
        "# external\n",
      );
    } finally {
      await fs.rm(externalWorkspace, { recursive: true, force: true });
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("uses manifest workspace paths when restore config falls back to the default workspace", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const externalWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-ws-"));
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-archive-"));
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    try {
      await fs.mkdir(externalWorkspace, { recursive: true });
      await fs.writeFile(path.join(externalWorkspace, "SOUL.md"), "# external\n", "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: {
              workspace: externalWorkspace,
            },
          },
        }),
        "utf8",
      );

      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
        includeWorkspace: true,
      });
      await tar.x({
        file: created.archivePath,
        cwd: extractDir,
        gzip: true,
      });

      const archiveRoot = normalizeArchiveRoot(
        path.basename(created.archivePath).replace(/\.tar\.gz$/, ""),
      );
      const extractedRoot = path.join(extractDir, archiveRoot);
      const manifest = parseBackupManifest(
        await fs.readFile(path.join(extractedRoot, "manifest.json"), "utf8"),
      );

      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(externalWorkspace, { recursive: true, force: true });

      const operations = await buildRestoreOperations({
        mode: "full-host",
        manifest,
        extractedRoot,
      });

      expect(operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "state", targetPath: stateDir }),
          expect.objectContaining({ kind: "workspace", targetPath: externalWorkspace }),
        ]),
      );
    } finally {
      await fs.rm(externalWorkspace, { recursive: true, force: true });
      await fs.rm(archiveDir, { recursive: true, force: true });
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("matches workspace assets by source path when manifest workspaceDirs order differs", async () => {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const workspaceA = path.join(tempHome.home, "workspace-a");
    const workspaceB = path.join(tempHome.home, "workspace-b");
    const rootDir = path.join(extractDir, "archive-root");
    try {
      await fs.mkdir(path.join(rootDir, "assets", "workspace-a"), { recursive: true });
      await fs.mkdir(path.join(rootDir, "assets", "workspace-b"), { recursive: true });
      const operations = await buildRestoreOperations({
        mode: "workspace-only",
        extractedRoot: rootDir,
        manifest: {
          schemaVersion: 1,
          createdAt: "2026-03-09T00:00:00.000Z",
          archiveRoot: "archive-root",
          runtimeVersion: "2026.3.9",
          platform: process.platform,
          nodeVersion: process.version,
          paths: {
            workspaceDirs: [workspaceB, workspaceA],
          },
          assets: [
            {
              kind: "workspace",
              sourcePath: workspaceA,
              archivePath: "archive-root/assets/workspace-a",
            },
            {
              kind: "workspace",
              sourcePath: workspaceB,
              archivePath: "archive-root/assets/workspace-b",
            },
          ],
        },
      });

      const workspaceOps = operations.filter((entry) => entry.kind === "workspace");
      expect(workspaceOps).toEqual([
        expect.objectContaining({ targetPath: workspaceA }),
        expect.objectContaining({ targetPath: workspaceB }),
      ]);
    } finally {
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("matches workspace assets by canonical source path when manifest workspace roots are symlinked", async () => {
    if (process.platform === "win32") {
      return;
    }

    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const workspaceA = path.join(tempHome.home, "workspace-a");
    const workspaceB = path.join(tempHome.home, "workspace-b");
    const linkA = path.join(tempHome.home, "workspace-a-link");
    const linkB = path.join(tempHome.home, "workspace-b-link");
    const rootDir = path.join(extractDir, "archive-root");
    try {
      await fs.mkdir(path.join(rootDir, "assets", "workspace-a"), { recursive: true });
      await fs.mkdir(path.join(rootDir, "assets", "workspace-b"), { recursive: true });
      await fs.mkdir(workspaceA, { recursive: true });
      await fs.mkdir(workspaceB, { recursive: true });
      await fs.symlink(workspaceA, linkA);
      await fs.symlink(workspaceB, linkB);

      const operations = await buildRestoreOperations({
        mode: "workspace-only",
        extractedRoot: rootDir,
        manifest: {
          schemaVersion: 1,
          createdAt: "2026-03-09T00:00:00.000Z",
          archiveRoot: "archive-root",
          runtimeVersion: "2026.3.9",
          platform: process.platform,
          nodeVersion: process.version,
          paths: {
            workspaceDirs: [linkB, linkA],
          },
          assets: [
            {
              kind: "workspace",
              sourcePath: workspaceA,
              archivePath: "archive-root/assets/workspace-a",
            },
            {
              kind: "workspace",
              sourcePath: workspaceB,
              archivePath: "archive-root/assets/workspace-b",
            },
          ],
        },
      });

      const workspaceOps = operations.filter((entry) => entry.kind === "workspace");
      expect(workspaceOps).toEqual([
        expect.objectContaining({ targetPath: linkA }),
        expect.objectContaining({ targetPath: linkB }),
      ]);
    } finally {
      await fs.rm(linkA, { force: true }).catch(() => undefined);
      await fs.rm(linkB, { force: true }).catch(() => undefined);
      await fs.rm(workspaceA, { recursive: true, force: true });
      await fs.rm(workspaceB, { recursive: true, force: true });
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("rejects restoring a workspace directly onto the home directory", async () => {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    try {
      await fs.mkdir(path.join(rootDir, "assets", "workspace-home"), { recursive: true });
      await expect(
        buildRestoreOperations({
          mode: "workspace-only",
          extractedRoot: rootDir,
          manifest: {
            schemaVersion: 1,
            createdAt: "2026-03-09T00:00:00.000Z",
            archiveRoot: "archive-root",
            runtimeVersion: "2026.3.9",
            platform: process.platform,
            nodeVersion: process.version,
            paths: {
              workspaceDirs: [tempHome.home],
            },
            assets: [
              {
                kind: "workspace",
                sourcePath: tempHome.home,
                archivePath: "archive-root/assets/workspace-home",
              },
            ],
          },
        }),
      ).rejects.toThrow("Refusing to restore workspace to an unsafe path");
    } finally {
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("rejects workspace restore targets whose symlinks resolve into the state directory", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    const symlinkPath = path.join(tempHome.home, "workspace-link");
    try {
      await fs.mkdir(path.join(rootDir, "assets", "workspace-link"), { recursive: true });
      await fs.symlink(stateDir, symlinkPath);

      await expect(
        buildRestoreOperations({
          mode: "workspace-only",
          extractedRoot: rootDir,
          manifest: {
            schemaVersion: 1,
            createdAt: "2026-03-09T00:00:00.000Z",
            archiveRoot: "archive-root",
            runtimeVersion: "2026.3.9",
            platform: process.platform,
            nodeVersion: process.version,
            paths: {
              workspaceDirs: [symlinkPath],
            },
            assets: [
              {
                kind: "workspace",
                sourcePath: symlinkPath,
                archivePath: "archive-root/assets/workspace-link",
              },
            ],
          },
        }),
      ).rejects.toThrow("Refusing to restore workspace to an unsafe path");
    } finally {
      await fs.rm(symlinkPath, { force: true }).catch(() => undefined);
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("emits a single JSON payload when restore runs with --json", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-json-"));
    try {
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
        includeWorkspace: false,
      });

      vi.mocked(runtime.log).mockClear();
      await backupRestoreCommand(runtime, {
        archive: created.archivePath,
        mode: "full-host",
        json: true,
      });

      expect(runtime.log).toHaveBeenCalledTimes(1);
      const message = vi.mocked(runtime.log).mock.calls[0]?.[0];
      expect(typeof message).toBe("string");
      expect(() => JSON.parse(String(message))).not.toThrow();
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("restores config-only from the state asset when no standalone config asset exists", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-config-only-"));
    try {
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          backup: {
            target: path.join(tempHome.home, "backups"),
          },
        }),
        "utf8",
      );

      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
        includeWorkspace: false,
      });

      await fs.rm(path.join(stateDir, "openclaw.json"), { force: true });

      const restored = await backupRestoreCommand(runtime, {
        archive: created.archivePath,
        mode: "config-only",
      });

      expect(restored.mode).toBe("config-only");
      expect(await fs.readFile(path.join(stateDir, "openclaw.json"), "utf8")).toContain('"backup"');
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid restore modes instead of defaulting to full-host", async () => {
    serviceIsLoaded.mockResolvedValue(true);
    await expect(
      backupRestoreCommand(runtime, {
        archive: path.join(tempHome.home, "missing.tar.gz"),
        mode: "workspace" as "full-host",
        forceStop: true,
      }),
    ).rejects.toThrow("Invalid restore mode: workspace");
    expect(serviceIsLoaded).not.toHaveBeenCalled();
    expect(serviceStop).not.toHaveBeenCalled();
  });

  it("does not stop the gateway when restore archive validation fails", async () => {
    serviceIsLoaded.mockResolvedValue(true);

    await expect(
      backupRestoreCommand(runtime, {
        archive: path.join(tempHome.home, "missing.tar.gz"),
        mode: "full-host",
        forceStop: true,
      }),
    ).rejects.toThrow();

    expect(serviceIsLoaded).not.toHaveBeenCalled();
    expect(serviceStop).not.toHaveBeenCalled();
  });

  it("restores the original target if copying fails after rollback rename", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-rollback-"));
    const originalCp = fs.cp.bind(fs);
    try {
      await fs.writeFile(path.join(stateDir, "state.txt"), "original\n", "utf8");

      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
        includeWorkspace: false,
      });

      const cpSpy = vi.spyOn(fs, "cp").mockImplementation(async (...args) => {
        const targetPath = args[1];
        if (targetPath === stateDir) {
          throw new Error("copy failed");
        }
        return await originalCp(...args);
      });

      await expect(
        backupRestoreCommand(runtime, {
          archive: created.archivePath,
          mode: "full-host",
        }),
      ).rejects.toThrow("copy failed");
      expect(await fs.readFile(path.join(stateDir, "state.txt"), "utf8")).toBe("original\n");
      cpSpy.mockRestore();
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("keeps rollback rename moves on the target filesystem", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-exdev-"));
    const originalRename = fs.rename.bind(fs);
    try {
      await fs.writeFile(path.join(stateDir, "state.txt"), "before\n", "utf8");

      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
        includeWorkspace: false,
      });

      await fs.writeFile(path.join(stateDir, "state.txt"), "after\n", "utf8");

      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (sourcePath, destPath) => {
        const sourcePathString = sourcePath.toString();
        const destPathString = destPath.toString();
        const targetParent = path.dirname(stateDir);
        const relativeDest = path.relative(targetParent, destPathString);
        if (
          sourcePathString === stateDir &&
          (relativeDest.startsWith("..") || path.isAbsolute(relativeDest))
        ) {
          const error = new Error("cross-device link not permitted") as NodeJS.ErrnoException;
          error.code = "EXDEV";
          throw error;
        }
        return await originalRename(sourcePathString, destPathString);
      });

      await backupRestoreCommand(runtime, {
        archive: created.archivePath,
        mode: "full-host",
      });

      expect(await fs.readFile(path.join(stateDir, "state.txt"), "utf8")).toBe("before\n");
      renameSpy.mockRestore();
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("keeps --json output clean when force-stopping the gateway", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-force-stop-"));
    try {
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");
      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
        includeWorkspace: false,
      });

      serviceIsLoaded.mockResolvedValue(true);
      serviceStop.mockImplementation(async (args) => {
        args?.stdout.write("stopping\n");
      });

      vi.mocked(runtime.log).mockClear();
      await backupRestoreCommand(runtime, {
        archive: created.archivePath,
        mode: "full-host",
        json: true,
        forceStop: true,
      });

      expect(runtime.log).toHaveBeenCalledTimes(1);
      expect(() => JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]))).not.toThrow();
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("rejects restore archives that contain symbolic links", async () => {
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-link-archive-"));
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-link-source-"));
    const linkedDir = path.join(sourceDir, "openclaw-backup");
    const archivePath = path.join(archiveDir, "malicious-backup.tar.gz");
    try {
      await fs.mkdir(path.join(sourceDir, "outside"), { recursive: true });
      await fs.writeFile(path.join(sourceDir, "outside", "owned.txt"), "owned\n", "utf8");
      await fs.mkdir(linkedDir, { recursive: true });
      await fs.writeFile(
        path.join(linkedDir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          createdAt: "2026-03-09T00:00:00.000Z",
          archiveRoot: "openclaw-backup",
          runtimeVersion: "2026.3.9",
          platform: process.platform,
          nodeVersion: process.version,
          assets: [],
        }),
        "utf8",
      );
      await fs.symlink("../outside", path.join(linkedDir, "payload"));

      await tar.c(
        {
          gzip: true,
          cwd: sourceDir,
          file: archivePath,
        },
        ["openclaw-backup"],
      );

      await expect(
        backupRestoreCommand(runtime, {
          archive: archivePath,
          mode: "full-host",
        }),
      ).rejects.toThrow(/unsupported tar (special )?entry|tar entry is a link|symbolic link/i);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
      await fs.rm(sourceDir, { recursive: true, force: true });
    }
  });
});
