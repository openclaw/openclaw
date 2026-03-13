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

  it("matches workspace assets by source path when candidate dirs include extra workspaces", async () => {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const workspaceA = path.join(tempHome.home, "workspace-a");
    const workspaceB = path.join(tempHome.home, "workspace-b");
    const extraWorkspace = path.join(tempHome.home, "workspace-extra");
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
            workspaceDirs: [extraWorkspace, workspaceB, workspaceA],
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

  it("falls back to current workspace only when source-path matching fails for every candidate", async () => {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    const currentWorkspace = path.join(tempHome.home, "current-workspace");
    const archivedWorkspace = path.join("/tmp", "archived-workspace");
    const unmatchedWorkspace = path.join("/tmp", "unmatched-workspace");
    try {
      await fs.mkdir(path.join(rootDir, "assets", "workspace"), { recursive: true });
      await fs.mkdir(path.join(rootDir, "assets", "config"), { recursive: true });
      await fs.writeFile(
        path.join(rootDir, "assets", "config", "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: {
              workspace: unmatchedWorkspace,
            },
          },
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(tempHome.home, ".openclaw", "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: {
              workspace: currentWorkspace,
            },
          },
        }),
        "utf8",
      );

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
            workspaceDirs: [unmatchedWorkspace],
          },
          assets: [
            {
              kind: "config",
              sourcePath: path.join(tempHome.home, ".openclaw", "openclaw.json"),
              archivePath: "archive-root/assets/config/openclaw.json",
            },
            {
              kind: "workspace",
              sourcePath: archivedWorkspace,
              archivePath: "archive-root/assets/workspace",
            },
          ],
        },
      });

      expect(operations).toEqual([
        expect.objectContaining({
          kind: "workspace",
          targetPath: currentWorkspace,
        }),
      ]);
    } finally {
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("prefers source-path match from later candidates over early positional fallback", async () => {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    const currentWorkspace = path.join(tempHome.home, "current-workspace");
    const archivedWorkspace = path.join("/tmp", "archived-workspace");
    try {
      await fs.mkdir(path.join(rootDir, "assets", "workspace"), { recursive: true });
      await fs.mkdir(path.join(rootDir, "assets", "config"), { recursive: true });
      await fs.writeFile(
        path.join(rootDir, "assets", "config", "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: {
              workspace: archivedWorkspace,
            },
          },
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(tempHome.home, ".openclaw", "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: {
              workspace: currentWorkspace,
            },
          },
        }),
        "utf8",
      );

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
            workspaceDirs: [archivedWorkspace],
          },
          assets: [
            {
              kind: "config",
              sourcePath: path.join(tempHome.home, ".openclaw", "openclaw.json"),
              archivePath: "archive-root/assets/config/openclaw.json",
            },
            {
              kind: "workspace",
              sourcePath: archivedWorkspace,
              archivePath: "archive-root/assets/workspace",
            },
          ],
        },
      });

      expect(operations).toEqual([
        expect.objectContaining({
          kind: "workspace",
          targetPath: archivedWorkspace,
        }),
      ]);
    } finally {
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

  it("rejects workspace restore targets nested under the oauth directory", async () => {
    const originalOAuthDir = process.env.OPENCLAW_OAUTH_DIR;
    const oauthDir = path.join(tempHome.home, "external-oauth");
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    const unsafeWorkspace = path.join(oauthDir, "workspace");
    try {
      process.env.OPENCLAW_OAUTH_DIR = oauthDir;
      await fs.mkdir(path.join(rootDir, "assets", "workspace"), { recursive: true });

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
              workspaceDirs: [unsafeWorkspace],
            },
            assets: [
              {
                kind: "workspace",
                sourcePath: unsafeWorkspace,
                archivePath: "archive-root/assets/workspace",
              },
            ],
          },
        }),
      ).rejects.toThrow("Refusing to restore workspace to an unsafe path");
    } finally {
      if (originalOAuthDir == null) {
        delete process.env.OPENCLAW_OAUTH_DIR;
      } else {
        process.env.OPENCLAW_OAUTH_DIR = originalOAuthDir;
      }
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("rejects workspace restore targets that would replace a parent of the state directory", async () => {
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = path.join(tempHome.home, "projects", ".openclaw");
    const workspaceTarget = path.join(tempHome.home, "projects");
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      await fs.writeFile(
        path.join(tempHome.home, ".openclaw", "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: {
              workspace: workspaceTarget,
            },
          },
        }),
        "utf8",
      );
      await fs.mkdir(path.join(rootDir, "assets", "workspace"), { recursive: true });

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
              workspaceDirs: [workspaceTarget],
            },
            assets: [
              {
                kind: "workspace",
                sourcePath: workspaceTarget,
                archivePath: "archive-root/assets/workspace",
              },
            ],
          },
        }),
      ).rejects.toThrow("Refusing to restore workspace to an unsafe path");
    } finally {
      if (originalStateDir == null) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("rejects workspace restore targets that would replace a parent of the oauth directory", async () => {
    const originalOauthDir = process.env.OPENCLAW_OAUTH_DIR;
    const oauthDir = path.join(tempHome.home, "shared", "oauth");
    const workspaceTarget = path.join(tempHome.home, "shared");
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    try {
      process.env.OPENCLAW_OAUTH_DIR = oauthDir;
      await fs.mkdir(path.join(rootDir, "assets", "workspace"), { recursive: true });

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
              workspaceDirs: [workspaceTarget],
            },
            assets: [
              {
                kind: "workspace",
                sourcePath: workspaceTarget,
                archivePath: "archive-root/assets/workspace",
              },
            ],
          },
        }),
      ).rejects.toThrow("Refusing to restore workspace to an unsafe path");
    } finally {
      if (originalOauthDir == null) {
        delete process.env.OPENCLAW_OAUTH_DIR;
      } else {
        process.env.OPENCLAW_OAUTH_DIR = originalOauthDir;
      }
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("rejects full-host restore when OPENCLAW_CONFIG_PATH resolves to the home directory", async () => {
    const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    try {
      process.env.OPENCLAW_CONFIG_PATH = tempHome.home;
      const canonicalHomeDir = await fs.realpath(tempHome.home);

      await expect(
        buildRestoreOperations({
          mode: "full-host",
          extractedRoot: extractDir,
          manifest: {
            schemaVersion: 1,
            createdAt: "2026-03-09T00:00:00.000Z",
            archiveRoot: "archive-root",
            runtimeVersion: "2026.3.9",
            platform: process.platform,
            nodeVersion: process.version,
            assets: [],
          },
        }),
      ).rejects.toThrow(
        `Refusing full-host restore: OPENCLAW_CONFIG_PATH resolves to ${canonicalHomeDir}, which is too broad.`,
      );
    } finally {
      if (originalConfigPath == null) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
      }
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("rejects config-only restore when OPENCLAW_CONFIG_PATH points to an existing directory", async () => {
    const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    const configDir = path.join(tempHome.home, "Documents");
    try {
      process.env.OPENCLAW_CONFIG_PATH = configDir;
      await fs.mkdir(path.join(rootDir, "assets"), { recursive: true });
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(rootDir, "assets", "config.json"), "{}\n", "utf8");

      await expect(
        buildRestoreOperations({
          mode: "config-only",
          extractedRoot: rootDir,
          manifest: {
            schemaVersion: 1,
            createdAt: "2026-03-09T00:00:00.000Z",
            archiveRoot: "archive-root",
            runtimeVersion: "2026.3.9",
            platform: process.platform,
            nodeVersion: process.version,
            assets: [
              {
                kind: "config",
                sourcePath: path.join(tempHome.home, ".openclaw", "openclaw.json"),
                archivePath: "archive-root/assets/config.json",
              },
            ],
          },
        }),
      ).rejects.toThrow(
        /Refusing config-only restore: OPENCLAW_CONFIG_PATH resolves to an existing directory/,
      );
    } finally {
      if (originalConfigPath == null) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
      }
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("rejects full-host restore when OPENCLAW_STATE_DIR points to an existing file", async () => {
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const stateFile = path.join(tempHome.home, "state-file.txt");
    try {
      process.env.OPENCLAW_STATE_DIR = stateFile;
      process.env.OPENCLAW_CONFIG_PATH = path.join(tempHome.home, "safe", "openclaw.json");
      await fs.writeFile(stateFile, "not a directory\n", "utf8");

      await expect(
        buildRestoreOperations({
          mode: "full-host",
          extractedRoot: extractDir,
          manifest: {
            schemaVersion: 1,
            createdAt: "2026-03-09T00:00:00.000Z",
            archiveRoot: "archive-root",
            runtimeVersion: "2026.3.9",
            platform: process.platform,
            nodeVersion: process.version,
            assets: [],
          },
        }),
      ).rejects.toThrow(
        /Refusing full-host restore: OPENCLAW_STATE_DIR resolves to an existing non-directory/,
      );
    } finally {
      if (originalStateDir == null) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
      if (originalConfigPath == null) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
      }
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("rejects full-host restore when OPENCLAW_OAUTH_DIR points to an existing file", async () => {
    const originalOauthDir = process.env.OPENCLAW_OAUTH_DIR;
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const oauthFile = path.join(tempHome.home, "oauth-file.txt");
    try {
      process.env.OPENCLAW_OAUTH_DIR = oauthFile;
      await fs.writeFile(oauthFile, "not a directory\n", "utf8");

      await expect(
        buildRestoreOperations({
          mode: "full-host",
          extractedRoot: extractDir,
          manifest: {
            schemaVersion: 1,
            createdAt: "2026-03-09T00:00:00.000Z",
            archiveRoot: "archive-root",
            runtimeVersion: "2026.3.9",
            platform: process.platform,
            nodeVersion: process.version,
            assets: [],
          },
        }),
      ).rejects.toThrow(
        /Refusing full-host restore: OPENCLAW_OAUTH_DIR resolves to an existing non-directory/,
      );
    } finally {
      if (originalOauthDir == null) {
        delete process.env.OPENCLAW_OAUTH_DIR;
      } else {
        process.env.OPENCLAW_OAUTH_DIR = originalOauthDir;
      }
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("rejects config-only restore when the config asset source is a directory", async () => {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    const configDir = path.join(rootDir, "assets", "config");
    try {
      await fs.mkdir(configDir, { recursive: true });

      await expect(
        buildRestoreOperations({
          mode: "config-only",
          extractedRoot: rootDir,
          manifest: {
            schemaVersion: 1,
            createdAt: "2026-03-09T00:00:00.000Z",
            archiveRoot: "archive-root",
            runtimeVersion: "2026.3.9",
            platform: process.platform,
            nodeVersion: process.version,
            assets: [
              {
                kind: "config",
                sourcePath: path.join(tempHome.home, ".openclaw", "openclaw.json"),
                archivePath: "archive-root/assets/config",
              },
            ],
          },
        }),
      ).rejects.toThrow(/Refusing config-only restore: config asset is not a regular file/);
    } finally {
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("rejects full-host restore when the config asset source is a directory", async () => {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    const configDir = path.join(rootDir, "assets", "config");
    try {
      await fs.mkdir(configDir, { recursive: true });

      await expect(
        buildRestoreOperations({
          mode: "full-host",
          extractedRoot: rootDir,
          manifest: {
            schemaVersion: 1,
            createdAt: "2026-03-09T00:00:00.000Z",
            archiveRoot: "archive-root",
            runtimeVersion: "2026.3.9",
            platform: process.platform,
            nodeVersion: process.version,
            assets: [
              {
                kind: "config",
                sourcePath: path.join(tempHome.home, ".openclaw", "openclaw.json"),
                archivePath: "archive-root/assets/config",
              },
            ],
          },
        }),
      ).rejects.toThrow(/Refusing full-host restore: config asset is not a regular file/);
    } finally {
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("rejects full-host restore when the state asset source is a file", async () => {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    const stateFile = path.join(rootDir, "assets", "state");
    try {
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, "not a directory\n", "utf8");

      await expect(
        buildRestoreOperations({
          mode: "full-host",
          extractedRoot: rootDir,
          manifest: {
            schemaVersion: 1,
            createdAt: "2026-03-09T00:00:00.000Z",
            archiveRoot: "archive-root",
            runtimeVersion: "2026.3.9",
            platform: process.platform,
            nodeVersion: process.version,
            assets: [
              {
                kind: "state",
                sourcePath: path.join(tempHome.home, ".openclaw"),
                archivePath: "archive-root/assets/state",
              },
            ],
          },
        }),
      ).rejects.toThrow(/Refusing full-host restore: state asset is not a directory/);
    } finally {
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("rejects full-host restore when the credentials asset source is a file", async () => {
    const originalOauthDir = process.env.OPENCLAW_OAUTH_DIR;
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    const credentialsFile = path.join(rootDir, "assets", "credentials");
    const oauthDir = path.join(tempHome.home, "external-oauth");
    try {
      process.env.OPENCLAW_OAUTH_DIR = oauthDir;
      await fs.mkdir(path.dirname(credentialsFile), { recursive: true });
      await fs.writeFile(credentialsFile, "not a directory\n", "utf8");

      await expect(
        buildRestoreOperations({
          mode: "full-host",
          extractedRoot: rootDir,
          manifest: {
            schemaVersion: 1,
            createdAt: "2026-03-09T00:00:00.000Z",
            archiveRoot: "archive-root",
            runtimeVersion: "2026.3.9",
            platform: process.platform,
            nodeVersion: process.version,
            assets: [
              {
                kind: "credentials",
                sourcePath: path.join(tempHome.home, ".openclaw", "credentials"),
                archivePath: "archive-root/assets/credentials",
              },
            ],
          },
        }),
      ).rejects.toThrow(/Refusing full-host restore: credentials asset is not a directory/);
    } finally {
      if (originalOauthDir == null) {
        delete process.env.OPENCLAW_OAUTH_DIR;
      } else {
        process.env.OPENCLAW_OAUTH_DIR = originalOauthDir;
      }
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("rejects workspace-only restore when the workspace asset source is a file", async () => {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    const workspaceFile = path.join(rootDir, "assets", "workspace");
    const workspaceTarget = path.join(tempHome.home, "workspace");
    try {
      await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
      await fs.writeFile(workspaceFile, "not a directory\n", "utf8");

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
              workspaceDirs: [workspaceTarget],
            },
            assets: [
              {
                kind: "workspace",
                sourcePath: workspaceTarget,
                archivePath: "archive-root/assets/workspace",
              },
            ],
          },
        }),
      ).rejects.toThrow(/Refusing workspace-only restore: workspace asset is not a directory/);
    } finally {
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("fails full-host restore when archived workspace assets cannot be mapped", async () => {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archivedWorkspaceA = path.join("/tmp", "archived-workspace-a");
    const archivedWorkspaceB = path.join("/tmp", "archived-workspace-b");
    try {
      await fs.mkdir(path.join(rootDir, "assets", "state"), { recursive: true });
      await fs.mkdir(path.join(rootDir, "assets", "workspace-a"), { recursive: true });
      await fs.mkdir(path.join(rootDir, "assets", "workspace-b"), { recursive: true });

      await expect(
        buildRestoreOperations({
          mode: "full-host",
          extractedRoot: rootDir,
          manifest: {
            schemaVersion: 1,
            createdAt: "2026-03-09T00:00:00.000Z",
            archiveRoot: "archive-root",
            runtimeVersion: "2026.3.9",
            platform: process.platform,
            nodeVersion: process.version,
            paths: {
              workspaceDirs: [
                archivedWorkspaceA,
                path.join("/tmp", "missing-workspace"),
                path.join("/tmp", "missing-workspace-2"),
              ],
            },
            assets: [
              {
                kind: "state",
                sourcePath: stateDir,
                archivePath: "archive-root/assets/state",
              },
              {
                kind: "workspace",
                sourcePath: archivedWorkspaceA,
                archivePath: "archive-root/assets/workspace-a",
              },
              {
                kind: "workspace",
                sourcePath: archivedWorkspaceB,
                archivePath: "archive-root/assets/workspace-b",
              },
            ],
          },
        }),
      ).rejects.toThrow("Workspace restore target mismatch");
    } finally {
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

  it("restores full-host config asset when state asset is missing", async () => {
    const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const stateDir = path.join(tempHome.home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-extract-"));
    const rootDir = path.join(extractDir, "archive-root");
    try {
      delete process.env.OPENCLAW_CONFIG_PATH;
      await fs.mkdir(path.join(rootDir, "assets"), { recursive: true });
      await fs.writeFile(path.join(rootDir, "assets", "config.json"), "{}\n", "utf8");

      const operations = await buildRestoreOperations({
        mode: "full-host",
        extractedRoot: rootDir,
        manifest: {
          schemaVersion: 1,
          createdAt: "2026-03-09T00:00:00.000Z",
          archiveRoot: "archive-root",
          runtimeVersion: "2026.3.9",
          platform: process.platform,
          nodeVersion: process.version,
          assets: [
            {
              kind: "config",
              sourcePath: configPath,
              archivePath: "archive-root/assets/config.json",
            },
          ],
        },
      });

      expect(operations).toEqual([
        expect.objectContaining({
          kind: "config",
          sourcePath: path.join(rootDir, "assets", "config.json"),
          targetPath: configPath,
        }),
      ]);
    } finally {
      if (originalConfigPath == null) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
      }
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it("restores external config paths from state-backed full-host archives", async () => {
    const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-full-config-"));
    const externalConfigPath = path.join(tempHome.home, "external", "openclaw.json");
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

      process.env.OPENCLAW_CONFIG_PATH = externalConfigPath;
      await fs.rm(path.join(stateDir, "openclaw.json"), { force: true });

      await backupRestoreCommand(runtime, {
        archive: created.archivePath,
        mode: "full-host",
      });

      expect(await fs.readFile(externalConfigPath, "utf8")).toContain('"backup"');
    } finally {
      if (originalConfigPath == null) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
      }
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("restores external oauth dirs from state-backed full-host archives", async () => {
    const originalOauthDir = process.env.OPENCLAW_OAUTH_DIR;
    const stateDir = path.join(tempHome.home, ".openclaw");
    const defaultOauthDir = path.join(stateDir, "credentials");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-full-oauth-"));
    const externalOauthDir = path.join(tempHome.home, "external-oauth");
    try {
      await fs.mkdir(defaultOauthDir, { recursive: true });
      await fs.writeFile(path.join(defaultOauthDir, "token.json"), '{"token":"abc"}\n', "utf8");

      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
        includeWorkspace: false,
      });

      process.env.OPENCLAW_OAUTH_DIR = externalOauthDir;
      await fs.rm(defaultOauthDir, { recursive: true, force: true });

      await backupRestoreCommand(runtime, {
        archive: created.archivePath,
        mode: "full-host",
      });

      expect(await fs.readFile(path.join(externalOauthDir, "token.json"), "utf8")).toContain(
        '"token":"abc"',
      );
    } finally {
      if (originalOauthDir == null) {
        delete process.env.OPENCLAW_OAUTH_DIR;
      } else {
        process.env.OPENCLAW_OAUTH_DIR = originalOauthDir;
      }
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
    const originalRename = fs.rename.bind(fs);
    try {
      await fs.writeFile(path.join(stateDir, "state.txt"), "original\n", "utf8");

      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
        includeWorkspace: false,
      });

      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (sourcePath, destPath) => {
        const sourcePathString = sourcePath.toString();
        const destPathString = destPath.toString();
        if (
          destPathString === stateDir &&
          sourcePathString.startsWith(path.dirname(stateDir)) &&
          path.basename(sourcePathString).startsWith(".openclaw-restore-")
        ) {
          throw new Error("copy failed");
        }
        return await originalRename(sourcePathString, destPathString);
      });

      await expect(
        backupRestoreCommand(runtime, {
          archive: created.archivePath,
          mode: "full-host",
        }),
      ).rejects.toThrow("copy failed");
      expect(await fs.readFile(path.join(stateDir, "state.txt"), "utf8")).toBe("original\n");
      renameSpy.mockRestore();
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

  it("rejects workspace restores when a missing parent path turns into a symlink", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restore-race-"));
    const safeRoot = path.join(tempHome.home, "safe-root");
    const stagedParent = path.join(safeRoot, "nested");
    const restoreTarget = path.join(stagedParent, "workspace");
    const originalMkdir = fs.mkdir.bind(fs);
    try {
      await fs.mkdir(restoreTarget, { recursive: true });
      await fs.writeFile(path.join(restoreTarget, "SOUL.md"), "# external\n", "utf8");
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: {
              workspace: restoreTarget,
            },
          },
        }),
        "utf8",
      );

      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
        includeWorkspace: true,
      });

      await fs.rm(restoreTarget, { recursive: true, force: true });
      await fs.rmdir(stagedParent);
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: {
              workspace: restoreTarget,
            },
          },
        }),
        "utf8",
      );

      const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
        if (target.toString() === stagedParent) {
          await fs.symlink(stateDir, stagedParent);
          return undefined;
        }
        return await originalMkdir(target, options);
      });

      await expect(
        backupRestoreCommand(runtime, {
          archive: created.archivePath,
          mode: "workspace-only",
        }),
      ).rejects.toThrow("Refusing to restore through a symbolic link path segment");
      expect(await fs.readFile(path.join(stateDir, "openclaw.json"), "utf8")).toContain(
        restoreTarget,
      );
      await expect(fs.access(path.join(stateDir, "workspace", "SOUL.md"))).rejects.toThrow();
      mkdirSpy.mockRestore();
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
      await fs.rm(stagedParent, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(safeRoot, { recursive: true, force: true }).catch(() => undefined);
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
