import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import {
  buildBackupArchiveRoot,
  encodeAbsolutePathForBackupArchive,
  resolveBackupPlanFromDisk,
} from "./backup-shared.js";
import { backupCreateCommand } from "./backup.js";

describe("backup commands", () => {
  let tempHome: TempHomeEnv;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-test-");
  });

  afterEach(async () => {
    await tempHome.restore();
  });

  it("collapses default config, credentials, and workspace into the state backup root", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "credentials", "oauth.json"), "{}", "utf8");
    await fs.mkdir(path.join(stateDir, "workspace"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "workspace", "SOUL.md"), "# soul\n", "utf8");

    const plan = await resolveBackupPlanFromDisk({ includeWorkspace: true, nowMs: 123 });

    expect(plan.included).toHaveLength(1);
    expect(plan.included[0]?.kind).toBe("state");
    expect(plan.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "workspace", reason: "covered" })]),
    );
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

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

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

        const encodedStatePath = path.join(
          archiveRoot,
          "payload",
          encodeAbsolutePathForBackupArchive(stateDir),
          "state.txt",
        );
        const encodedWorkspacePath = path.join(
          archiveRoot,
          "payload",
          encodeAbsolutePathForBackupArchive(externalWorkspace),
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

  it("rejects output paths that would be created inside a backed-up directory", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    await expect(
      backupCreateCommand(runtime, {
        output: path.join(stateDir, "backups"),
      }),
    ).rejects.toThrow(/must not be written inside a source path/i);
  });
});
