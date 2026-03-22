import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import {
  buildBackupArchiveRoot,
  encodeAbsolutePathForBackupArchive,
  resolveBackupPlanFromDisk,
} from "./backup-shared.js";
import { backupCreateCommand } from "./backup.js";

const backupVerifyCommandMock = vi.hoisted(() => vi.fn());

vi.mock("./backup-verify.js", () => ({
  backupVerifyCommand: backupVerifyCommandMock,
}));

describe("backup commands", () => {
  let tempHome: TempHomeEnv;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-test-");
    backupVerifyCommandMock.mockReset();
    backupVerifyCommandMock.mockResolvedValue({
      ok: true,
      archivePath: "/tmp/fake.tar.gz",
      archiveRoot: "fake",
      createdAt: new Date().toISOString(),
      runtimeVersion: "test",
      assetCount: 1,
      entryCount: 2,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await tempHome.restore();
  });

  function createRuntime(): RuntimeEnv {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } satisfies RuntimeEnv;
  }

  async function withInvalidWorkspaceBackupConfig<T>(fn: (runtime: RuntimeEnv) => Promise<T>) {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const configPath = path.join(tempHome.home, "custom-config.json");
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.writeFile(configPath, '{"agents": { defaults: { workspace: ', "utf8");
    const runtime = createRuntime();

    try {
      return await fn(runtime);
    } finally {
      delete process.env.OPENCLAW_CONFIG_PATH;
    }
  }

  function expectWorkspaceCoveredByState(
    plan: Awaited<ReturnType<typeof resolveBackupPlanFromDisk>>,
  ) {
    expect(plan.included).toHaveLength(1);
    expect(plan.included[0]?.kind).toBe("state");
    expect(plan.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "workspace", reason: "covered" })]),
    );
  }

  it("collapses default config, credentials, and workspace into the state backup root", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "credentials", "oauth.json"), "{}", "utf8");
    await fs.mkdir(path.join(stateDir, "workspace"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "workspace", "SOUL.md"), "# soul\n", "utf8");

    const plan = await resolveBackupPlanFromDisk({ includeWorkspace: true, nowMs: 123 });
    expectWorkspaceCoveredByState(plan);
  });

  it("orders coverage checks by canonical path so symlinked workspaces do not duplicate state", async () => {
    if (process.platform === "win32") {
      return;
    }

    const stateDir = path.join(tempHome.home, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    const symlinkDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-link-"));
    const workspaceLink = path.join(symlinkDir, "ws-link");
    try {
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# soul\n", "utf8");
      await fs.symlink(workspaceDir, workspaceLink);
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: {
              workspace: workspaceLink,
            },
          },
        }),
        "utf8",
      );

      const plan = await resolveBackupPlanFromDisk({ includeWorkspace: true, nowMs: 123 });
      expectWorkspaceCoveredByState(plan);
    } finally {
      await fs.rm(symlinkDir, { recursive: true, force: true });
    }
  });

  it("creates an archive with a manifest and external workspace payload", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const externalWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const configPath = path.join(tempHome.home, "custom-config.json");
    const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backups-"));
    try {
      process.env.OPENCLAW_CONFIG_PATH = configPath;
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: {
            defaults: {
              workspace: externalWorkspace,
            },
          },
        }),
        "utf8",
      );
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");
      await fs.writeFile(path.join(externalWorkspace, "SOUL.md"), "# external\n", "utf8");

      const runtime = createRuntime();

      const nowMs = Date.UTC(2026, 2, 9, 0, 0, 0);
      const result = await backupCreateCommand(runtime, {
        output: backupDir,
        includeWorkspace: true,
        nowMs,
      });

      expect(result.archivePath).toBe(
        path.join(backupDir, `${buildBackupArchiveRoot(nowMs)}.tar.gz`),
      );

      const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-extract-"));
      try {
        await tar.x({ file: result.archivePath, cwd: extractDir, gzip: true });
        const archiveRoot = path.join(extractDir, buildBackupArchiveRoot(nowMs));
        const manifest = JSON.parse(
          await fs.readFile(path.join(archiveRoot, "manifest.json"), "utf8"),
        ) as {
          assets: Array<{ kind: string; archivePath: string }>;
        };

        expect(manifest.assets).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "state" }),
            expect.objectContaining({ kind: "config" }),
            expect.objectContaining({ kind: "workspace" }),
          ]),
        );

        const stateAsset = result.assets.find((asset) => asset.kind === "state");
        const workspaceAsset = result.assets.find((asset) => asset.kind === "workspace");
        expect(stateAsset).toBeDefined();
        expect(workspaceAsset).toBeDefined();

        const encodedStatePath = path.join(
          archiveRoot,
          "payload",
          encodeAbsolutePathForBackupArchive(stateAsset!.sourcePath),
          "state.txt",
        );
        const encodedWorkspacePath = path.join(
          archiveRoot,
          "payload",
          encodeAbsolutePathForBackupArchive(workspaceAsset!.sourcePath),
          "SOUL.md",
        );
        expect(await fs.readFile(encodedStatePath, "utf8")).toBe("state\n");
        expect(await fs.readFile(encodedWorkspacePath, "utf8")).toBe("# external\n");
      } finally {
        await fs.rm(extractDir, { recursive: true, force: true });
      }
    } finally {
      delete process.env.OPENCLAW_CONFIG_PATH;
      await fs.rm(externalWorkspace, { recursive: true, force: true });
      await fs.rm(backupDir, { recursive: true, force: true });
    }
  });

  it("optionally verifies the archive after writing it", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-backup-verify-on-create-"),
    );
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

      const runtime = createRuntime();

      const result = await backupCreateCommand(runtime, {
        output: archiveDir,
        verify: true,
      });

      expect(result.verified).toBe(true);
      expect(backupVerifyCommandMock).toHaveBeenCalledWith(
        expect.objectContaining({ log: expect.any(Function) }),
        expect.objectContaining({ archive: result.archivePath, json: false }),
      );
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("rejects output paths that would be created inside a backed-up directory", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");

    const runtime = createRuntime();

    await expect(
      backupCreateCommand(runtime, {
        output: path.join(stateDir, "backups"),
      }),
    ).rejects.toThrow(/must not be written inside a source path/i);
  });

  it("rejects symlinked output paths even when intermediate directories do not exist yet", async () => {
    if (process.platform === "win32") {
      return;
    }

    const stateDir = path.join(tempHome.home, ".openclaw");
    const symlinkDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-link-"));
    const symlinkPath = path.join(symlinkDir, "linked-state");
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.symlink(stateDir, symlinkPath);

      const runtime = createRuntime();

      await expect(
        backupCreateCommand(runtime, {
          output: path.join(symlinkPath, "new", "subdir", "backup.tar.gz"),
        }),
      ).rejects.toThrow(/must not be written inside a source path/i);
    } finally {
      await fs.rm(symlinkDir, { recursive: true, force: true });
    }
  });

  it("falls back to the home directory when cwd is inside a backed-up source tree", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# soul\n", "utf8");
    vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

    const runtime = createRuntime();

    const nowMs = Date.UTC(2026, 2, 9, 1, 2, 3);
    const result = await backupCreateCommand(runtime, { nowMs });

    expect(result.archivePath).toBe(
      path.join(tempHome.home, `${buildBackupArchiveRoot(nowMs)}.tar.gz`),
    );
    await fs.rm(result.archivePath, { force: true });
  });

  it("falls back to the home directory when cwd is a symlink into a backed-up source tree", async () => {
    if (process.platform === "win32") {
      return;
    }

    const stateDir = path.join(tempHome.home, ".openclaw");
    const workspaceDir = path.join(stateDir, "workspace");
    const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-cwd-link-"));
    const workspaceLink = path.join(linkParent, "workspace-link");
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# soul\n", "utf8");
      await fs.symlink(workspaceDir, workspaceLink);
      vi.spyOn(process, "cwd").mockReturnValue(workspaceLink);

      const runtime = createRuntime();

      const nowMs = Date.UTC(2026, 2, 9, 1, 3, 4);
      const result = await backupCreateCommand(runtime, { nowMs });

      expect(result.archivePath).toBe(
        path.join(tempHome.home, `${buildBackupArchiveRoot(nowMs)}.tar.gz`),
      );
      await fs.rm(result.archivePath, { force: true });
    } finally {
      await fs.rm(linkParent, { recursive: true, force: true });
    }
  });

  it("allows dry-run preview even when the target archive already exists", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const existingArchive = path.join(tempHome.home, "existing-backup.tar.gz");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.writeFile(existingArchive, "already here", "utf8");

    const runtime = createRuntime();

    const result = await backupCreateCommand(runtime, {
      output: existingArchive,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.archivePath).toBe(existingArchive);
    expect(await fs.readFile(existingArchive, "utf8")).toBe("already here");
  });

  it("fails fast when config is invalid and workspace backup is enabled", async () => {
    await withInvalidWorkspaceBackupConfig(async (runtime) => {
      await expect(backupCreateCommand(runtime, { dryRun: true })).rejects.toThrow(
        /--no-include-workspace/i,
      );
    });
  });

  it("allows explicit partial backups when config is invalid", async () => {
    await withInvalidWorkspaceBackupConfig(async (runtime) => {
      const result = await backupCreateCommand(runtime, {
        dryRun: true,
        includeWorkspace: false,
      });

      expect(result.includeWorkspace).toBe(false);
      expect(result.assets.some((asset) => asset.kind === "workspace")).toBe(false);
    });
  });

  it("backs up only the active config file when --only-config is requested", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ theme: "config-only" }), "utf8");
    await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");
    await fs.writeFile(path.join(stateDir, "credentials", "oauth.json"), "{}", "utf8");

    const runtime = createRuntime();

    const result = await backupCreateCommand(runtime, {
      dryRun: true,
      onlyConfig: true,
    });

    expect(result.onlyConfig).toBe(true);
    expect(result.includeWorkspace).toBe(false);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.kind).toBe("config");
  });

  it("allows config-only backups even when the config file is invalid", async () => {
    const configPath = path.join(tempHome.home, "custom-config.json");
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    await fs.writeFile(configPath, '{"agents": { defaults: { workspace: ', "utf8");

    const runtime = createRuntime();

    try {
      const result = await backupCreateCommand(runtime, {
        dryRun: true,
        onlyConfig: true,
      });

      expect(result.assets).toHaveLength(1);
      expect(result.assets[0]?.kind).toBe("config");
    } finally {
      delete process.env.OPENCLAW_CONFIG_PATH;
    }
  });
});
