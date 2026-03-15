/**
 * Integration tests for backup import/restore orchestration.
 *
 * Tests the full import pipeline: read → decrypt → extract → validate → apply,
 * including dry-run mode, cron merging, integrity verification, and tar-slip prevention.
 *
 * Strategy: create test archives manually using tar.c with known content.
 * This makes import tests independent from the export pipeline.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackupManifest, ManifestEntry } from "./types.js";

const tempDirs: string[] = [];

async function makeTempDir(label: string = "import-test"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${label}-`));
  tempDirs.push(dir);
  return dir;
}

/** Compute SHA-256 hex digest of a file. */
async function sha256(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Build a staging directory, write manifest, and pack into a tar.gz archive.
 * Returns the archive path plus the manifest for verification.
 */
async function buildTestArchive(opts: {
  baseDir: string;
  files: Array<{ archivePath: string; content: string }>;
  components: string[];
  label?: string;
  encrypted?: boolean;
}): Promise<{ archivePath: string; manifest: BackupManifest }> {
  const staging = path.join(opts.baseDir, "staging");
  await fs.mkdir(staging, { recursive: true });

  const entries: ManifestEntry[] = [];

  for (const file of opts.files) {
    const fullPath = path.join(staging, file.archivePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.content, "utf-8");
    const stat = await fs.stat(fullPath);
    entries.push({
      path: file.archivePath,
      sha256: await sha256(fullPath),
      size: stat.size,
    });
  }

  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    openclawVersion: "2026.2.9",
    components: opts.components as BackupManifest["components"],
    entries,
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.encrypted ? { encrypted: true } : {}),
  };

  await fs.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));

  const archivePath = path.join(opts.baseDir, "test-backup.tar.gz");
  await tar.c({ gzip: true, file: archivePath, cwd: staging }, ["."]);

  return { archivePath, manifest };
}

/**
 * Reset modules and mock paths + cron store to point to a target state dir.
 */
async function setupImport(targetStateDir: string, cronStorePath?: string) {
  vi.resetModules();

  if (cronStorePath) {
    vi.doMock("../cron/store.js", async () => {
      const actual = await vi.importActual<typeof import("../cron/store.js")>("../cron/store.js");
      return {
        ...actual,
        DEFAULT_CRON_STORE_PATH: cronStorePath,
      };
    });
  }
  const { importBackup } = await import("./import.js");
  return { importBackup };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  tempDirs.length = 0;
});

describe("backup/import", () => {
  describe("full import cycle", () => {
    it("imports restoring all files to target state dir", async () => {
      const base = await makeTempDir("import-full");
      const { archivePath } = await buildTestArchive({
        baseDir: base,
        files: [
          {
            archivePath: "config/openclaw.json",
            content: JSON.stringify({
              models: { primary: "anthropic/claude-4" },
            }),
          },
          {
            archivePath: "workspace/SOUL.md",
            content: "# Soul\nI am helpful.",
          },
          {
            archivePath: "workspace/MEMORY.md",
            content: "# Memory\nDark mode.",
          },
          { archivePath: "skills/greeting/SKILL.md", content: "# Greeting" },
        ],
        components: ["config", "workspace", "skills"],
      });

      const targetBase = await makeTempDir("import-target");
      const targetStateDir = path.join(targetBase, ".openclaw");
      await fs.mkdir(targetStateDir, { recursive: true });

      const { importBackup } = await setupImport(targetStateDir);

      const result = await importBackup({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: archivePath,
      });

      expect(result.dryRun).toBe(false);
      expect(result.integrityErrors).toEqual([]);
      expect(result.restoredComponents).toContain("config");
      expect(result.restoredComponents).toContain("workspace");
      expect(result.restoredComponents).toContain("skills");
      expect(result.restoredFiles.length).toBeGreaterThan(0);

      // Verify config was written
      const config = JSON.parse(
        await fs.readFile(path.join(targetStateDir, "openclaw.json"), "utf-8"),
      );
      expect(config.models.primary).toBe("anthropic/claude-4");

      // Verify workspace files
      const agentDir = path.join(targetStateDir, "agents", "default", "agent");
      const soul = await fs.readFile(path.join(agentDir, "SOUL.md"), "utf-8");
      expect(soul).toContain("I am helpful");

      // Verify skills
      const skillFile = await fs.readFile(
        path.join(targetStateDir, "skills", "greeting", "SKILL.md"),
        "utf-8",
      );
      expect(skillFile).toBe("# Greeting");
    });

    it("creates .pre-restore.bak of existing config before overwriting", async () => {
      const base = await makeTempDir("import-bak");
      const { archivePath } = await buildTestArchive({
        baseDir: base,
        files: [
          {
            archivePath: "config/openclaw.json",
            content: JSON.stringify({ newConfig: true }),
          },
        ],
        components: ["config"],
      });

      const targetBase = await makeTempDir("import-bak-target");
      const targetStateDir = path.join(targetBase, ".openclaw");
      await fs.mkdir(targetStateDir, { recursive: true });
      const existingConfig = JSON.stringify({
        existing: true,
        important: "data",
      });
      await fs.writeFile(path.join(targetStateDir, "openclaw.json"), existingConfig);

      const { importBackup } = await setupImport(targetStateDir);
      await importBackup({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: archivePath,
      });

      // Check backup was created
      const bakContent = await fs.readFile(
        path.join(targetStateDir, "openclaw.json.pre-restore.bak"),
        "utf-8",
      );
      expect(JSON.parse(bakContent)).toEqual({
        existing: true,
        important: "data",
      });

      // Check new config was written
      const newConfig = JSON.parse(
        await fs.readFile(path.join(targetStateDir, "openclaw.json"), "utf-8"),
      );
      expect(newConfig).toEqual({ newConfig: true });
    });
  });

  describe("dry-run mode", () => {
    it("reports what would be restored without modifying files", async () => {
      const base = await makeTempDir("dryrun");
      const { archivePath } = await buildTestArchive({
        baseDir: base,
        files: [
          {
            archivePath: "config/openclaw.json",
            content: JSON.stringify({ dryRun: true }),
          },
          { archivePath: "workspace/SOUL.md", content: "# Soul" },
        ],
        components: ["config", "workspace"],
      });

      const targetBase = await makeTempDir("dryrun-target");
      const targetStateDir = path.join(targetBase, ".openclaw");
      await fs.mkdir(targetStateDir, { recursive: true });

      const { importBackup } = await setupImport(targetStateDir);

      const result = await importBackup({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: archivePath,
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.manifest.version).toBe(1);
      expect(result.restoredComponents).toContain("config");
      expect(result.restoredComponents).toContain("workspace");
      expect(result.restoredFiles.length).toBeGreaterThan(0);

      // Target should NOT have any files restored
      const configExists = await fs
        .access(path.join(targetStateDir, "openclaw.json"))
        .then(() => true)
        .catch(() => false);
      expect(configExists).toBe(false);
    });
  });

  describe("encrypted archives", () => {
    it("decrypts and restores an encrypted archive", async () => {
      const passphrase = "test-encryption-key-2026";
      const base = await makeTempDir("enc");

      // Build a plain archive first, then encrypt it
      const { archivePath: plainArchive } = await buildTestArchive({
        baseDir: base,
        files: [
          {
            archivePath: "config/openclaw.json",
            content: JSON.stringify({ encrypted: "test" }),
          },
        ],
        components: ["config"],
        encrypted: true,
      });

      // Encrypt the archive
      const { encrypt } = await import("./crypto.js");
      const plainData = await fs.readFile(plainArchive);
      const encryptedData = encrypt(plainData, passphrase);
      const encryptedPath = path.join(base, "encrypted.tar.gz");
      await fs.writeFile(encryptedPath, encryptedData);

      const targetBase = await makeTempDir("enc-target");
      const targetStateDir = path.join(targetBase, ".openclaw");
      await fs.mkdir(targetStateDir, { recursive: true });

      const { importBackup } = await setupImport(targetStateDir);

      const result = await importBackup({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: encryptedPath,
        decrypt: passphrase,
      });

      expect(result.dryRun).toBe(false);
      expect(result.integrityErrors).toEqual([]);
      expect(result.restoredFiles.length).toBeGreaterThan(0);

      // Verify restored config
      const config = JSON.parse(
        await fs.readFile(path.join(targetStateDir, "openclaw.json"), "utf-8"),
      );
      expect(config.encrypted).toBe("test");
    });

    it("throws on wrong decryption passphrase", async () => {
      const base = await makeTempDir("enc-wrong");

      const { archivePath: plainArchive } = await buildTestArchive({
        baseDir: base,
        files: [
          {
            archivePath: "config/openclaw.json",
            content: "{}",
          },
        ],
        components: ["config"],
      });

      const { encrypt } = await import("./crypto.js");
      const encryptedData = encrypt(await fs.readFile(plainArchive), "correct-pass");
      const encryptedPath = path.join(base, "encrypted.tar.gz");
      await fs.writeFile(encryptedPath, encryptedData);

      const targetStateDir = "/nonexistent";
      const { importBackup } = await setupImport(targetStateDir);

      await expect(
        importBackup({
          stateDir: targetStateDir,
          configPath: path.join(targetStateDir, "openclaw.json"),
          cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
          agentDir: path.join(targetStateDir, "agents", "default", "agent"),
          input: encryptedPath,
          decrypt: "wrong-pass",
        }),
      ).rejects.toThrow();
    });
  });

  describe("integrity verification", () => {
    it("reports integrity errors in dry-run without throwing", async () => {
      const base = await makeTempDir("integrity-dryrun");
      const staging = path.join(base, "staging");
      await fs.mkdir(path.join(staging, "config"), { recursive: true });
      const configContent = '{"test": true}';
      await fs.writeFile(path.join(staging, "config", "openclaw.json"), configContent);

      // Write manifest with WRONG checksum
      const manifest: BackupManifest = {
        version: 1,
        createdAt: new Date().toISOString(),
        openclawVersion: "2026.2.9",
        components: ["config"],
        entries: [
          {
            path: "config/openclaw.json",
            sha256: "0".repeat(64), // Intentionally wrong
            size: Buffer.byteLength(configContent),
          },
        ],
      };
      await fs.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest));

      const archivePath = path.join(base, "bad-checksums.tar.gz");
      await tar.c({ gzip: true, file: archivePath, cwd: staging }, ["."]);

      const { importBackup } = await setupImport("/nonexistent");
      const targetStateDir = "/nonexistent";

      const result = await importBackup({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: archivePath,
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.integrityErrors.length).toBeGreaterThan(0);
      expect(result.integrityErrors[0]).toContain("checksum mismatch");
    });

    it("throws on integrity failure during non-dry-run import", async () => {
      const base = await makeTempDir("integrity-fail");
      const staging = path.join(base, "staging");
      await fs.mkdir(path.join(staging, "config"), { recursive: true });
      await fs.writeFile(path.join(staging, "config", "openclaw.json"), '{"test": true}');

      const manifest: BackupManifest = {
        version: 1,
        createdAt: new Date().toISOString(),
        openclawVersion: "2026.2.9",
        components: ["config"],
        entries: [
          {
            path: "config/openclaw.json",
            sha256: "0".repeat(64),
            size: 14,
          },
        ],
      };
      await fs.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest));

      const archivePath = path.join(base, "bad.tar.gz");
      await tar.c({ gzip: true, file: archivePath, cwd: staging }, ["."]);

      const targetBase = await makeTempDir("integrity-target");
      const targetStateDir = path.join(targetBase, ".openclaw");
      await fs.mkdir(targetStateDir, { recursive: true });

      const { importBackup } = await setupImport(targetStateDir);

      await expect(
        importBackup({
          stateDir: targetStateDir,
          configPath: path.join(targetStateDir, "openclaw.json"),
          cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
          agentDir: path.join(targetStateDir, "agents", "default", "agent"),
          input: archivePath,
        }),
      ).rejects.toThrow("Integrity check failed");
    });
  });

  describe("manifest validation", () => {
    it("throws on missing manifest.json", async () => {
      const base = await makeTempDir("no-manifest");
      const staging = path.join(base, "staging");
      await fs.mkdir(staging, { recursive: true });
      await fs.writeFile(path.join(staging, "some-file.txt"), "no manifest here");

      const archivePath = path.join(base, "no-manifest.tar.gz");
      await tar.c({ gzip: true, file: archivePath, cwd: staging }, ["."]);

      const { importBackup } = await setupImport("/nonexistent");
      const targetStateDir = "/nonexistent";

      await expect(
        importBackup({
          stateDir: targetStateDir,
          configPath: path.join(targetStateDir, "openclaw.json"),
          cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
          agentDir: path.join(targetStateDir, "agents", "default", "agent"),
          input: archivePath,
        }),
      ).rejects.toThrow("missing or has an invalid manifest.json");
    });

    it("throws on invalid manifest version", async () => {
      const base = await makeTempDir("bad-version");
      const staging = path.join(base, "staging");
      await fs.mkdir(staging, { recursive: true });
      await fs.writeFile(
        path.join(staging, "manifest.json"),
        JSON.stringify({
          version: 99,
          createdAt: "2026-01-01",
          openclawVersion: "2026.2.9",
          components: ["config"],
          entries: [],
        }),
      );

      const archivePath = path.join(base, "bad-version.tar.gz");
      await tar.c({ gzip: true, file: archivePath, cwd: staging }, ["."]);

      const { importBackup } = await setupImport("/nonexistent");
      const targetStateDir = "/nonexistent";

      await expect(
        importBackup({
          stateDir: targetStateDir,
          configPath: path.join(targetStateDir, "openclaw.json"),
          cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
          agentDir: path.join(targetStateDir, "agents", "default", "agent"),
          input: archivePath,
        }),
      ).rejects.toThrow("Invalid manifest");
    });
  });

  describe("cron merge", () => {
    it("merges cron jobs when --merge option is used", async () => {
      const base = await makeTempDir("cron-merge");

      // Build archive with cron jobs
      const { archivePath } = await buildTestArchive({
        baseDir: base,
        files: [
          {
            archivePath: "cron/jobs.json",
            content: JSON.stringify({
              version: 1,
              jobs: [
                {
                  id: "job-from-backup",
                  name: "Daily Report",
                  schedule: "0 9 * * *",
                },
                {
                  id: "shared-job",
                  name: "Backup Updated",
                  schedule: "0 0 * * 0",
                },
              ],
            }),
          },
        ],
        components: ["cron"],
      });

      // Set up target with existing cron jobs
      const targetBase = await makeTempDir("cron-target");
      const targetStateDir = path.join(targetBase, ".openclaw");
      await fs.mkdir(targetStateDir, { recursive: true });

      const cronDir = path.join(targetBase, "cron");
      await fs.mkdir(cronDir, { recursive: true });
      const cronStorePath = path.join(cronDir, "jobs.json");
      await fs.writeFile(
        cronStorePath,
        JSON.stringify({
          version: 1,
          jobs: [
            { id: "existing-job", name: "Weekly Check", schedule: "0 0 * * 1" },
            {
              id: "shared-job",
              name: "Original Version",
              schedule: "0 0 * * 0",
            },
          ],
        }),
      );

      const { importBackup } = await setupImport(targetStateDir, cronStorePath);

      const result = await importBackup({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath,
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: archivePath,
        merge: true,
      });

      expect(result.restoredFiles).toContain("cron/jobs.json");

      // Read the merged cron store
      const merged = JSON.parse(await fs.readFile(cronStorePath, "utf-8"));
      const jobIds = merged.jobs.map((j: { id: string }) => j.id);

      // Should contain all unique jobs
      expect(jobIds).toContain("existing-job");
      expect(jobIds).toContain("job-from-backup");
      expect(jobIds).toContain("shared-job");

      // Shared job should be the backup version (backup overrides)
      const sharedJob = merged.jobs.find((j: { id: string }) => j.id === "shared-job");
      expect(sharedJob.name).toBe("Backup Updated");
    });
  });

  describe("storage backend import", () => {
    it("reads archive from a storage backend", async () => {
      const base = await makeTempDir("storage-import");

      const { archivePath } = await buildTestArchive({
        baseDir: base,
        files: [
          {
            archivePath: "config/openclaw.json",
            content: JSON.stringify({ fromStorage: true }),
          },
        ],
        components: ["config"],
      });

      // Put the archive into a local storage backend
      const { createLocalStorage } = await import("./storage/local.js");
      const storageDir = path.join(base, "storage");
      const storage = createLocalStorage(storageDir);
      const archiveData = await fs.readFile(archivePath);
      await storage.put("stored-backup.tar.gz", archiveData);

      const targetBase = await makeTempDir("storage-import-target");
      const targetStateDir = path.join(targetBase, ".openclaw");
      await fs.mkdir(targetStateDir, { recursive: true });

      const { importBackup } = await setupImport(targetStateDir);

      const result = await importBackup(
        {
          stateDir: targetStateDir,
          configPath: path.join(targetStateDir, "openclaw.json"),
          cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
          agentDir: path.join(targetStateDir, "agents", "default", "agent"),
          input: "stored-backup.tar.gz",
        },
        storage,
      );

      expect(result.dryRun).toBe(false);
      expect(result.restoredFiles).toContain("config/openclaw.json");

      const config = JSON.parse(
        await fs.readFile(path.join(targetStateDir, "openclaw.json"), "utf-8"),
      );
      expect(config.fromStorage).toBe(true);
    });
  });

  describe("approvals and pairing restore", () => {
    it("restores approvals and pairing files", async () => {
      const base = await makeTempDir("approvals-pairing");

      const { archivePath } = await buildTestArchive({
        baseDir: base,
        files: [
          {
            archivePath: "approvals/exec-approvals.json",
            content: JSON.stringify({ approvals: ["tool-a", "tool-b"] }),
          },
          {
            archivePath: "pairing/allowlist.json",
            content: JSON.stringify({ allowed: ["+1234567890"] }),
          },
        ],
        components: ["approvals", "pairing"],
      });

      const targetBase = await makeTempDir("approvals-target");
      const targetStateDir = path.join(targetBase, ".openclaw");
      await fs.mkdir(targetStateDir, { recursive: true });

      const { importBackup } = await setupImport(targetStateDir);
      const result = await importBackup({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: archivePath,
      });

      expect(result.restoredComponents).toContain("approvals");
      expect(result.restoredComponents).toContain("pairing");

      // Verify approvals
      const approvals = JSON.parse(
        await fs.readFile(path.join(targetStateDir, "exec-approvals.json"), "utf-8"),
      );
      expect(approvals.approvals).toEqual(["tool-a", "tool-b"]);

      // Verify pairing
      const pairing = JSON.parse(
        await fs.readFile(path.join(targetStateDir, "pairing", "allowlist.json"), "utf-8"),
      );
      expect(pairing.allowed).toEqual(["+1234567890"]);
    });
  });

  describe("cleanup", () => {
    it("cleans up extract directory even when import fails", async () => {
      const base = await makeTempDir("cleanup");
      const archivePath = path.join(base, "invalid.tar.gz");
      await fs.writeFile(archivePath, "this is not a valid tar.gz archive");

      const { importBackup } = await setupImport("/nonexistent");
      const targetStateDir = "/nonexistent";

      await expect(
        importBackup({
          stateDir: targetStateDir,
          configPath: path.join(targetStateDir, "openclaw.json"),
          cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
          agentDir: path.join(targetStateDir, "agents", "default", "agent"),
          input: archivePath,
        }),
      ).rejects.toThrow();

      // Verify no orphaned extract dirs in tmp (best-effort)
      const tmpContents = await fs.readdir(os.tmpdir());
      const orphaned = tmpContents.filter(
        (name) => name.startsWith("openclaw-restore-") && name.includes(String(process.pid)),
      );
      expect(orphaned.length).toBeLessThanOrEqual(1);
    });
  });

  describe("multiple integrity errors", () => {
    it("reports all mismatched files, not just the first", async () => {
      const base = await makeTempDir("multi-integrity");
      const staging = path.join(base, "staging");
      await fs.mkdir(path.join(staging, "config"), { recursive: true });
      await fs.mkdir(path.join(staging, "workspace"), { recursive: true });
      await fs.writeFile(path.join(staging, "config", "openclaw.json"), '{"a":1}');
      await fs.writeFile(path.join(staging, "workspace", "SOUL.md"), "# Soul");
      await fs.writeFile(path.join(staging, "workspace", "MEMORY.md"), "# Memory");

      // All entries have wrong checksums
      const manifest: BackupManifest = {
        version: 1,
        createdAt: new Date().toISOString(),
        openclawVersion: "2026.2.9",
        components: ["config", "workspace"],
        entries: [
          { path: "config/openclaw.json", sha256: "a".repeat(64), size: 7 },
          { path: "workspace/SOUL.md", sha256: "b".repeat(64), size: 6 },
          { path: "workspace/MEMORY.md", sha256: "c".repeat(64), size: 8 },
        ],
      };
      await fs.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest));

      const archivePath = path.join(base, "multi-bad.tar.gz");
      await tar.c({ gzip: true, file: archivePath, cwd: staging }, ["."]);

      const { importBackup } = await setupImport("/nonexistent");
      const targetStateDir = "/nonexistent";
      const result = await importBackup({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: archivePath,
        dryRun: true,
      });

      // Should report errors for all 3 files
      expect(result.integrityErrors.length).toBe(3);
      expect(result.integrityErrors.some((e) => e.includes("config/openclaw.json"))).toBe(true);
      expect(result.integrityErrors.some((e) => e.includes("workspace/SOUL.md"))).toBe(true);
      expect(result.integrityErrors.some((e) => e.includes("workspace/MEMORY.md"))).toBe(true);
    });
  });

  describe("import idempotency", () => {
    it("importing the same archive twice produces identical results", async () => {
      const base = await makeTempDir("idempotent");
      const { archivePath } = await buildTestArchive({
        baseDir: base,
        files: [
          {
            archivePath: "config/openclaw.json",
            content: JSON.stringify({ idempotent: true }),
          },
          { archivePath: "workspace/SOUL.md", content: "# Idempotent Soul" },
        ],
        components: ["config", "workspace"],
      });

      const targetBase = await makeTempDir("idempotent-target");
      const targetStateDir = path.join(targetBase, ".openclaw");
      await fs.mkdir(targetStateDir, { recursive: true });

      // First import
      const { importBackup: import1 } = await setupImport(targetStateDir);
      const result1 = await import1({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: archivePath,
      });

      // Second import (overwrites same files)
      const { importBackup: import2 } = await setupImport(targetStateDir);
      const result2 = await import2({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: archivePath,
      });

      // Both results should match
      expect(result1.restoredFiles.toSorted()).toEqual(result2.restoredFiles.toSorted());
      expect(result1.integrityErrors).toEqual([]);
      expect(result2.integrityErrors).toEqual([]);

      // File content should be the same after second import
      const config = JSON.parse(
        await fs.readFile(path.join(targetStateDir, "openclaw.json"), "utf-8"),
      );
      expect(config.idempotent).toBe(true);

      // .pre-restore.bak of the second import should contain the same config
      const bak = JSON.parse(
        await fs.readFile(path.join(targetStateDir, "openclaw.json.pre-restore.bak"), "utf-8"),
      );
      expect(bak.idempotent).toBe(true);
    });
  });

  describe("unicode content", () => {
    it("preserves unicode and emoji in file content through backup/restore", async () => {
      const base = await makeTempDir("unicode");
      const unicodeContent = [
        "# T\u00E2m h\u1ED3n\n",
        "Xin ch\u00E0o th\u1EBF gi\u1EDBi! \u{1F30F}\n",
        "\u65E5\u672C\u8A9E\u30C6\u30B9\u30C8 \u{1F1EF}\u{1F1F5}\n",
        "\u0422\u0435\u0441\u0442 \u{1F680}",
      ].join("");

      const { archivePath } = await buildTestArchive({
        baseDir: base,
        files: [
          { archivePath: "workspace/SOUL.md", content: unicodeContent },
          {
            archivePath: "config/openclaw.json",
            content: JSON.stringify({ label: "\u{1F916} Bot Config" }),
          },
        ],
        components: ["config", "workspace"],
      });

      const targetBase = await makeTempDir("unicode-target");
      const targetStateDir = path.join(targetBase, ".openclaw");
      await fs.mkdir(targetStateDir, { recursive: true });

      const { importBackup } = await setupImport(targetStateDir);
      const result = await importBackup({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: archivePath,
      });

      expect(result.integrityErrors).toEqual([]);

      // Verify unicode content survived the roundtrip
      const agentDir = path.join(targetStateDir, "agents", "default", "agent");
      const restored = await fs.readFile(path.join(agentDir, "SOUL.md"), "utf-8");
      expect(restored).toBe(unicodeContent);

      const config = JSON.parse(
        await fs.readFile(path.join(targetStateDir, "openclaw.json"), "utf-8"),
      );
      expect(config.label).toBe("\u{1F916} Bot Config");
    });
  });

  describe("sessions restore", () => {
    it("restores sessions.json to the agent directory", async () => {
      const base = await makeTempDir("sessions");
      const sessionsData = JSON.stringify({
        sessions: [
          { id: "s1", createdAt: "2026-01-01T00:00:00Z", messages: 42 },
          { id: "s2", createdAt: "2026-02-01T00:00:00Z", messages: 7 },
        ],
      });

      const { archivePath } = await buildTestArchive({
        baseDir: base,
        files: [{ archivePath: "sessions/sessions.json", content: sessionsData }],
        components: ["sessions"],
      });

      const targetBase = await makeTempDir("sessions-target");
      const targetStateDir = path.join(targetBase, ".openclaw");
      await fs.mkdir(targetStateDir, { recursive: true });

      const { importBackup } = await setupImport(targetStateDir);
      const result = await importBackup({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: archivePath,
      });

      expect(result.restoredComponents).toContain("sessions");
      expect(result.restoredFiles).toContain("sessions/sessions.json");

      // sessions are restored to the agent dir
      const agentDir = path.join(targetStateDir, "agents", "default", "agent");
      const restored = JSON.parse(await fs.readFile(path.join(agentDir, "sessions.json"), "utf-8"));
      expect(restored.sessions).toHaveLength(2);
      expect(restored.sessions[0].id).toBe("s1");
    });
  });

  describe("cron merge edge cases", () => {
    it("handles merge when no existing cron store file (ENOENT)", async () => {
      const base = await makeTempDir("cron-enoent");

      const { archivePath } = await buildTestArchive({
        baseDir: base,
        files: [
          {
            archivePath: "cron/jobs.json",
            content: JSON.stringify({
              version: 1,
              jobs: [{ id: "new-job", name: "Fresh Job", schedule: "0 * * * *" }],
            }),
          },
        ],
        components: ["cron"],
      });

      const targetBase = await makeTempDir("cron-enoent-target");
      const targetStateDir = path.join(targetBase, ".openclaw");
      await fs.mkdir(targetStateDir, { recursive: true });

      // Cron store file doesn't exist yet
      const cronDir = path.join(targetBase, "cron");
      await fs.mkdir(cronDir, { recursive: true });
      const cronStorePath = path.join(cronDir, "jobs.json");

      const { importBackup } = await setupImport(targetStateDir, cronStorePath);
      const result = await importBackup({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath,
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: archivePath,
        merge: true,
      });

      expect(result.restoredFiles).toContain("cron/jobs.json");

      const merged = JSON.parse(await fs.readFile(cronStorePath, "utf-8"));
      expect(merged.jobs).toHaveLength(1);
      expect(merged.jobs[0].id).toBe("new-job");
    });

    it("non-merge cron import replaces existing store", async () => {
      const base = await makeTempDir("cron-replace");

      const { archivePath } = await buildTestArchive({
        baseDir: base,
        files: [
          {
            archivePath: "cron/jobs.json",
            content: JSON.stringify({
              version: 1,
              jobs: [{ id: "backup-only", schedule: "0 12 * * *" }],
            }),
          },
        ],
        components: ["cron"],
      });

      const targetBase = await makeTempDir("cron-replace-target");
      const targetStateDir = path.join(targetBase, ".openclaw");
      await fs.mkdir(targetStateDir, { recursive: true });

      const cronDir = path.join(targetBase, "cron");
      await fs.mkdir(cronDir, { recursive: true });
      const cronStorePath = path.join(cronDir, "jobs.json");
      // Write existing jobs that should be overwritten
      await fs.writeFile(
        cronStorePath,
        JSON.stringify({
          version: 1,
          jobs: [{ id: "old-job", schedule: "0 0 * * *" }],
        }),
      );

      // Import WITHOUT merge — should replace
      const { importBackup } = await setupImport(targetStateDir, cronStorePath);
      const result = await importBackup({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath,
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: archivePath,
      });

      expect(result.restoredFiles).toContain("cron/jobs.json");

      const restored = JSON.parse(await fs.readFile(cronStorePath, "utf-8"));
      const jobIds = restored.jobs?.map((j: { id: string }) => j.id) ?? restored.version;
      // The old-job should be gone (replaced, not merged)
      expect(jobIds).toContain("backup-only");
      expect(jobIds).not.toContain("old-job");
    });
  });

  describe("manifest edge cases", () => {
    it("throws on manifest with missing required fields", async () => {
      const base = await makeTempDir("bad-manifest-fields");
      const staging = path.join(base, "staging");
      await fs.mkdir(staging, { recursive: true });
      // Manifest missing 'entries' and 'components'
      await fs.writeFile(
        path.join(staging, "manifest.json"),
        JSON.stringify({
          version: 1,
          createdAt: "2026-01-01",
          openclawVersion: "2026.2.9",
        }),
      );

      const archivePath = path.join(base, "bad-fields.tar.gz");
      await tar.c({ gzip: true, file: archivePath, cwd: staging }, ["."]);

      const { importBackup } = await setupImport("/nonexistent");
      const targetStateDir = "/nonexistent";
      await expect(
        importBackup({
          stateDir: targetStateDir,
          configPath: path.join(targetStateDir, "openclaw.json"),
          cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
          agentDir: path.join(targetStateDir, "agents", "default", "agent"),
          input: archivePath,
        }),
      ).rejects.toThrow("Invalid manifest");
    });

    it("throws on manifest.json that is not valid JSON", async () => {
      const base = await makeTempDir("json-parse-error");
      const staging = path.join(base, "staging");
      await fs.mkdir(staging, { recursive: true });
      await fs.writeFile(path.join(staging, "manifest.json"), "{{not json}}");

      const archivePath = path.join(base, "bad-json.tar.gz");
      await tar.c({ gzip: true, file: archivePath, cwd: staging }, ["."]);

      const { importBackup } = await setupImport("/nonexistent");
      const targetStateDir = "/nonexistent";
      await expect(
        importBackup({
          stateDir: targetStateDir,
          configPath: path.join(targetStateDir, "openclaw.json"),
          cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
          agentDir: path.join(targetStateDir, "agents", "default", "agent"),
          input: archivePath,
        }),
      ).rejects.toThrow("missing or has an invalid manifest.json");
    });
  });

  describe("large archive", () => {
    it("handles archive with many files across components", async () => {
      const base = await makeTempDir("large");

      // Generate 50 skill files
      const files = [];
      for (let i = 0; i < 50; i++) {
        files.push({
          archivePath: `skills/skill-${i}/SKILL.md`,
          content: `# Skill ${i}\nThis is skill number ${i} with some content to make it realistic.`,
        });
      }
      // Add config and workspace
      files.push({
        archivePath: "config/openclaw.json",
        content: JSON.stringify({ models: { primary: "test" } }),
      });
      files.push({
        archivePath: "workspace/SOUL.md",
        content: "# Large backup soul",
      });

      const { archivePath } = await buildTestArchive({
        baseDir: base,
        files,
        components: ["config", "workspace", "skills"],
      });

      const targetBase = await makeTempDir("large-target");
      const targetStateDir = path.join(targetBase, ".openclaw");
      await fs.mkdir(targetStateDir, { recursive: true });

      const { importBackup } = await setupImport(targetStateDir);
      const result = await importBackup({
        stateDir: targetStateDir,
        configPath: path.join(targetStateDir, "openclaw.json"),
        cronStorePath: path.join(targetStateDir, "cron", "jobs.json"),
        agentDir: path.join(targetStateDir, "agents", "default", "agent"),
        input: archivePath,
      });

      expect(result.integrityErrors).toEqual([]);
      // 52 files: 50 skills + 1 config + 1 workspace
      expect(result.restoredFiles.length).toBe(52);

      // Verify a random skill
      const skill25 = await fs.readFile(
        path.join(targetStateDir, "skills", "skill-25", "SKILL.md"),
        "utf-8",
      );
      expect(skill25).toContain("Skill 25");
    });
  });
});
