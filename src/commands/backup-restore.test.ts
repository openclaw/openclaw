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

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    isLoaded: vi.fn(async () => false),
    stop: vi.fn(async () => undefined),
  }),
}));

describe("backup restore", () => {
  let tempHome: TempHomeEnv;
  let runtime: RuntimeEnv;
  let previousCwd: string;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-restore-test-");
    previousCwd = process.cwd();
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
});
