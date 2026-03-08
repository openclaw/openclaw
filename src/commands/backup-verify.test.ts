import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { buildBackupArchiveRoot } from "./backup-shared.js";
import { backupVerifyCommand } from "./backup-verify.js";
import { backupCreateCommand } from "./backup.js";

describe("backupVerifyCommand", () => {
  let tempHome: TempHomeEnv;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-verify-test-");
  });

  afterEach(async () => {
    await tempHome.restore();
  });

  it("verifies an archive created by backup create", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-verify-out-"));
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "hello\n", "utf8");

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

      const nowMs = Date.UTC(2026, 2, 9, 0, 0, 0);
      const created = await backupCreateCommand(runtime, { output: archiveDir, nowMs });
      const verified = await backupVerifyCommand(runtime, { archive: created.archivePath });

      expect(verified.ok).toBe(true);
      expect(verified.archiveRoot).toBe(buildBackupArchiveRoot(nowMs));
      expect(verified.assetCount).toBeGreaterThan(0);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("fails when the archive does not contain a manifest", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-no-manifest-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    try {
      const root = path.join(tempDir, "root");
      await fs.mkdir(path.join(root, "payload"), { recursive: true });
      await fs.writeFile(path.join(root, "payload", "data.txt"), "x\n", "utf8");
      await tar.c({ file: archivePath, gzip: true, cwd: tempDir }, ["root"]);

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /expected exactly one backup manifest entry/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails when the manifest references a missing asset payload", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-missing-asset-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    try {
      const rootName = "2026-03-09T00-00-00.000Z-openclaw-backup";
      const root = path.join(tempDir, rootName);
      await fs.mkdir(root, { recursive: true });
      const manifest = {
        schemaVersion: 1,
        createdAt: "2026-03-09T00:00:00.000Z",
        archiveRoot: rootName,
        runtimeVersion: "test",
        platform: process.platform,
        nodeVersion: process.version,
        assets: [
          {
            kind: "state",
            sourcePath: "/tmp/.openclaw",
            archivePath: `${rootName}/payload/posix/tmp/.openclaw`,
          },
        ],
      };
      await fs.writeFile(
        path.join(root, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await tar.c({ file: archivePath, gzip: true, cwd: tempDir }, [rootName]);

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /missing payload for manifest asset/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails when archive paths contain traversal segments", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-traversal-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    const manifestPath = path.join(tempDir, "manifest.json");
    const payloadPath = path.join(tempDir, "payload.txt");
    try {
      const rootName = "2026-03-09T00-00-00.000Z-openclaw-backup";
      const traversalPath = `${rootName}/payload/../escaped.txt`;
      const manifest = {
        schemaVersion: 1,
        createdAt: "2026-03-09T00:00:00.000Z",
        archiveRoot: rootName,
        runtimeVersion: "test",
        platform: process.platform,
        nodeVersion: process.version,
        assets: [
          {
            kind: "state",
            sourcePath: "/tmp/.openclaw",
            archivePath: traversalPath,
          },
        ],
      };
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await fs.writeFile(payloadPath, "payload\n", "utf8");
      await tar.c(
        {
          file: archivePath,
          gzip: true,
          portable: true,
          preservePaths: true,
          onWriteEntry: (entry) => {
            if (entry.path === manifestPath) {
              entry.path = `${rootName}/manifest.json`;
              return;
            }
            if (entry.path === payloadPath) {
              entry.path = traversalPath;
            }
          },
        },
        [manifestPath, payloadPath],
      );

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /path traversal segments/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("ignores payload manifest.json files when locating the backup manifest", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const externalWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const configPath = path.join(tempHome.home, "custom-config.json");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-verify-out-"));
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
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "hello\n", "utf8");
      await fs.writeFile(
        path.join(externalWorkspace, "manifest.json"),
        JSON.stringify({ name: "workspace-payload" }),
        "utf8",
      );

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

      const created = await backupCreateCommand(runtime, {
        output: archiveDir,
        includeWorkspace: true,
        nowMs: Date.UTC(2026, 2, 9, 2, 0, 0),
      });
      const verified = await backupVerifyCommand(runtime, { archive: created.archivePath });

      expect(verified.ok).toBe(true);
      expect(verified.assetCount).toBeGreaterThanOrEqual(2);
    } finally {
      delete process.env.OPENCLAW_CONFIG_PATH;
      await fs.rm(externalWorkspace, { recursive: true, force: true });
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("fails when the archive contains duplicate root manifest entries", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-duplicate-manifest-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    const manifestPath = path.join(tempDir, "manifest.json");
    const payloadPath = path.join(tempDir, "payload.txt");
    try {
      const rootName = "2026-03-09T00-00-00.000Z-openclaw-backup";
      const manifest = {
        schemaVersion: 1,
        createdAt: "2026-03-09T00:00:00.000Z",
        archiveRoot: rootName,
        runtimeVersion: "test",
        platform: process.platform,
        nodeVersion: process.version,
        assets: [
          {
            kind: "state",
            sourcePath: "/tmp/.openclaw",
            archivePath: `${rootName}/payload/posix/tmp/.openclaw/payload.txt`,
          },
        ],
      };
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await fs.writeFile(payloadPath, "payload\n", "utf8");
      await tar.c(
        {
          file: archivePath,
          gzip: true,
          portable: true,
          preservePaths: true,
          onWriteEntry: (entry) => {
            if (entry.path === manifestPath) {
              entry.path = `${rootName}/manifest.json`;
              return;
            }
            if (entry.path === payloadPath) {
              entry.path = `${rootName}/payload/posix/tmp/.openclaw/payload.txt`;
            }
          },
        },
        [manifestPath, manifestPath, payloadPath],
      );

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /expected exactly one backup manifest entry, found 2/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
