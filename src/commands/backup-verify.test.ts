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

  it("fails when archive paths contain backslashes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-backslash-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    const manifestPath = path.join(tempDir, "manifest.json");
    const payloadPath = path.join(tempDir, "payload.txt");
    try {
      const rootName = "2026-03-09T00-00-00.000Z-openclaw-backup";
      const invalidPath = `${rootName}/payload\\..\\escaped.txt`;
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
            archivePath: invalidPath,
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
              entry.path = invalidPath;
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
        /forward slashes/i,
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

  it("fails when the archive contains duplicate payload entries", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-duplicate-payload-"));
    const archivePath = path.join(tempDir, "broken.tar.gz");
    const manifestPath = path.join(tempDir, "manifest.json");
    const payloadPathA = path.join(tempDir, "payload-a.txt");
    const payloadPathB = path.join(tempDir, "payload-b.txt");
    try {
      const rootName = "2026-03-09T00-00-00.000Z-openclaw-backup";
      const payloadArchivePath = `${rootName}/payload/posix/tmp/.openclaw/payload.txt`;
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
            archivePath: payloadArchivePath,
          },
        ],
      };
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await fs.writeFile(payloadPathA, "payload-a\n", "utf8");
      await fs.writeFile(payloadPathB, "payload-b\n", "utf8");
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
            if (entry.path === payloadPathA || entry.path === payloadPathB) {
              entry.path = payloadArchivePath;
            }
          },
        },
        [manifestPath, payloadPathA, payloadPathB],
      );

      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };

      await expect(backupVerifyCommand(runtime, { archive: archivePath })).rejects.toThrow(
        /duplicate entry path/i,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("verifies checksums in a round-trip create-verify cycle", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-checksum-"));
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "hello\n", "utf8");
      await fs.mkdir(path.join(stateDir, "nested"), { recursive: true });
      await fs.writeFile(path.join(stateDir, "nested", "deep.txt"), "deep content\n", "utf8");

      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const nowMs = Date.UTC(2026, 2, 9, 3, 0, 0);
      const created = await backupCreateCommand(runtime, { output: archiveDir, nowMs });
      const verified = await backupVerifyCommand(runtime, { archive: created.archivePath });

      expect(verified.ok).toBe(true);
      expect(verified.schemaVersion).toBe(2);
      expect(verified.checksumsVerified).toBe(true);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("detects tampered archive content", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-tamper-"));
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "original\n", "utf8");

      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const nowMs = Date.UTC(2026, 2, 9, 4, 0, 0);
      const created = await backupCreateCommand(runtime, { output: archiveDir, nowMs });

      // Extract, tamper with a file, and repack
      const extractDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-backup-tamper-extract-"),
      );
      try {
        await tar.x({ file: created.archivePath, cwd: extractDir, gzip: true });
        const archiveRoot = buildBackupArchiveRoot(nowMs);

        // Find and tamper with state.txt inside the archive
        const stateAssetDir = path.join(extractDir, archiveRoot, "payload");
        const tamperedFiles = await findFilesRecursive(stateAssetDir, "state.txt");
        expect(tamperedFiles.length).toBeGreaterThan(0);
        await fs.writeFile(tamperedFiles[0], "tampered!\n", "utf8");

        // Repack the tampered archive
        await fs.rm(created.archivePath);
        await tar.c({ file: created.archivePath, gzip: true, cwd: extractDir }, [archiveRoot]);

        await expect(
          backupVerifyCommand(runtime, { archive: created.archivePath }),
        ).rejects.toThrow(/checksum mismatch/i);
      } finally {
        await fs.rm(extractDir, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("verifies a v1 archive without checksums gracefully", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-v1-compat-"));
    const archivePath = path.join(tempDir, "v1.tar.gz");
    try {
      const rootName = "2026-03-09T00-00-00.000Z-openclaw-backup";
      const root = path.join(tempDir, rootName);
      const payloadDir = path.join(root, "payload", "posix", "tmp", ".openclaw");
      await fs.mkdir(payloadDir, { recursive: true });
      await fs.writeFile(path.join(payloadDir, "state.txt"), "v1 content\n", "utf8");
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

      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const verified = await backupVerifyCommand(runtime, { archive: archivePath });

      expect(verified.ok).toBe(true);
      expect(verified.schemaVersion).toBe(1);
      expect(verified.checksumsVerified).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("includes sha256 fields in the manifest for each asset", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-sha256-field-"));
    try {
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.writeFile(path.join(stateDir, "state.txt"), "checksum test\n", "utf8");

      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const nowMs = Date.UTC(2026, 2, 9, 5, 0, 0);
      const created = await backupCreateCommand(runtime, { output: archiveDir, nowMs });

      const extractDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-backup-sha256-extract-"),
      );
      try {
        await tar.x({ file: created.archivePath, cwd: extractDir, gzip: true });
        const archiveRoot = buildBackupArchiveRoot(nowMs);
        const manifest = JSON.parse(
          await fs.readFile(path.join(extractDir, archiveRoot, "manifest.json"), "utf8"),
        ) as {
          schemaVersion: number;
          assets: Array<{ kind: string; sha256: string }>;
        };

        expect(manifest.schemaVersion).toBe(2);
        for (const asset of manifest.assets) {
          expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
        }
      } finally {
        await fs.rm(extractDir, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });
});

async function findFilesRecursive(dir: string, name: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findFilesRecursive(fullPath, name)));
    } else if (entry.name === name) {
      results.push(fullPath);
    }
  }
  return results;
}
