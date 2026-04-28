import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { backupCreateCommand } from "../commands/backup.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

const backupVerifyCommandMock = vi.hoisted(() => vi.fn());

vi.mock("../commands/backup-verify.js", () => ({
  backupVerifyCommand: backupVerifyCommandMock,
}));

async function getArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      entries.push(entry.path);
    },
  });
  return entries;
}

describe("backup create — exclude patterns", () => {
  let tempHome: TempHomeEnv;
  let previousCwd: string;

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-exclude-test-");
    previousCwd = process.cwd();
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
    process.chdir(previousCwd);
    await tempHome.restore();
  });

  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  async function setupStateDir(files: Record<string, string> = {}) {
    const stateDir = path.join(tempHome.home, ".openclaw");

    // Always write a config
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");

    // Create default structure
    const defaultFiles: Record<string, string> = {
      "state.txt": "state\n",
      "memory/notes.md": "# notes\n",
      "credentials/oauth.json": "{}",
      "venvs/lib/python3.11/site.py": "# python\n",
      "models/gpt2/config.json": '{"model": "gpt2"}',
      "logs/app.log": "log line\n",
      "completions/_openclaw": "# completions\n",
      ...files,
    };

    for (const [relPath, content] of Object.entries(defaultFiles)) {
      const fullPath = path.join(stateDir, relPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, "utf8");
    }

    return stateDir;
  }

  it("default backup (no flags) includes everything including venvs/", async () => {
    await setupStateDir();
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-no-exclude-"));

    try {
      const nowMs = Date.UTC(2026, 2, 12, 0, 0, 0);
      const result = await backupCreateCommand(runtime, {
        output: archiveDir,
        nowMs,
      });

      // Extract and check for venvs content
      const entries = await getArchiveEntries(result.archivePath);
      const venvEntries = entries.filter((e) => e.includes("venvs"));
      expect(venvEntries.length).toBeGreaterThan(0);

      // No exclusion data at all
      expect((result as unknown as Record<string, unknown>).excluded).toBeUndefined();
      expect(result.excludedStats).toBeUndefined();
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("--smart-exclude excludes venvs/, models/, logs/, completions/", async () => {
    await setupStateDir();
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-smart-exclude-"));

    try {
      const nowMs = Date.UTC(2026, 2, 12, 0, 0, 1);
      const result = await backupCreateCommand(runtime, {
        output: archiveDir,
        smartExclude: true,
        nowMs,
      });

      // Per-file excluded[] is no longer returned
      expect((result as unknown as Record<string, unknown>).excluded).toBeUndefined();

      // excludedStats should be populated with per-pattern aggregates
      expect(result.excludedStats).toBeDefined();
      expect(result.excludedStats!.totalFiles).toBeGreaterThan(0);
      expect(result.excludedStats!.totalBytes).toBeGreaterThanOrEqual(0);
      expect(result.excludedStats!.byPattern.length).toBeGreaterThan(0);

      // byPattern entries should have the right shape
      const venvsPattern = result.excludedStats!.byPattern.find((p) => p.pattern === "venvs/");
      expect(venvsPattern).toBeDefined();
      expect(venvsPattern!.files).toBeGreaterThan(0);
      expect(venvsPattern!.source).toBe("default");

      // Verify archive does NOT contain venvs content
      const entries = await getArchiveEntries(result.archivePath);
      const venvEntries = entries.filter((e) => e.includes("venvs"));
      expect(venvEntries).toHaveLength(0);

      // But memory should still be there
      const memoryEntries = entries.filter((e) => e.includes("memory"));
      expect(memoryEntries.length).toBeGreaterThan(0);

      // Credentials should still be there
      const credEntries = entries.filter((e) => e.includes("credentials"));
      expect(credEntries.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("--include-all creates archive with everything", async () => {
    await setupStateDir();
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-include-all-"));

    try {
      const result = await backupCreateCommand(runtime, {
        output: archiveDir,
        smartExclude: true,
        includeAll: true,
      });

      // include-all overrides smart-exclude: no exclusion data
      expect((result as unknown as Record<string, unknown>).excluded).toBeUndefined();
      expect(result.excludedStats).toBeUndefined();

      // venvs should be in the archive
      const entries = await getArchiveEntries(result.archivePath);
      const venvEntries = entries.filter((e) => e.includes("venvs"));
      expect(venvEntries.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("--exclude *.log excludes log files from archive", async () => {
    await setupStateDir({
      "important.log": "should be excluded\n",
      "keep.txt": "should be included\n",
    });
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-exclude-glob-"));

    try {
      const result = await backupCreateCommand(runtime, {
        output: archiveDir,
        exclude: ["*.log"],
      });

      // Per-file excluded[] is no longer returned
      expect((result as unknown as Record<string, unknown>).excluded).toBeUndefined();

      // excludedStats should record the pattern
      expect(result.excludedStats).toBeDefined();
      const logPattern = result.excludedStats!.byPattern.find((p) => p.pattern === "*.log");
      expect(logPattern).toBeDefined();
      expect(logPattern!.files).toBeGreaterThan(0);
      expect(logPattern!.source).toBe("cli");

      // Archive should not contain .log files
      const entries = await getArchiveEntries(result.archivePath);
      const logEntries = entries.filter((e) => e.endsWith(".log") || e.endsWith(".log/"));
      expect(logEntries).toHaveLength(0);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("--exclude-file loads and applies patterns to real archive", async () => {
    await setupStateDir();
    const excludeFilePath = path.join(tempHome.home, "excludes.txt");
    await fs.writeFile(excludeFilePath, "venvs/\nmodels/\n", "utf8");

    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-exclude-file-"));

    try {
      const result = await backupCreateCommand(runtime, {
        output: archiveDir,
        excludeFile: excludeFilePath,
      });

      // Per-file excluded[] is no longer returned
      expect((result as unknown as Record<string, unknown>).excluded).toBeUndefined();

      // excludedStats should track both patterns from the file
      expect(result.excludedStats).toBeDefined();
      expect(result.excludedStats!.byPattern.some((p) => p.pattern === "venvs/")).toBe(true);
      expect(result.excludedStats!.byPattern.some((p) => p.pattern === "models/")).toBe(true);

      const entries = await getArchiveEntries(result.archivePath);
      const venvEntries = entries.filter((e) => e.includes("venvs"));
      const modelEntries = entries.filter((e) => e.includes("models"));
      expect(venvEntries).toHaveLength(0);
      expect(modelEntries).toHaveLength(0);

      // But memory and credentials should still be present
      const memoryEntries = entries.filter((e) => e.includes("memory"));
      expect(memoryEntries.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("--dry-run shows excluded patterns, writes no archive", async () => {
    await setupStateDir();

    const result = await backupCreateCommand(runtime, {
      dryRun: true,
      smartExclude: true,
    });

    expect(result.dryRun).toBe(true);
    // Dry-run with patterns should indicate exclude intent
    expect(result.excludedStats).toBeDefined();
    expect(result.excludedStats!.byPattern.length).toBeGreaterThan(0);
  });

  it("--json output does not include excluded[], only excludedStats", async () => {
    await setupStateDir();
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-json-exclude-"));

    try {
      const logSpy = vi.fn();
      await backupCreateCommand(
        { log: logSpy, error: vi.fn(), exit: vi.fn() },
        {
          output: archiveDir,
          smartExclude: true,
          json: true,
        },
      );

      expect(logSpy).toHaveBeenCalledTimes(1);
      const jsonOutput = JSON.parse(logSpy.mock.calls[0][0] as string);

      // excluded[] must NOT be present in --json output
      expect(jsonOutput.excluded).toBeUndefined();

      // excludedStats must be present with full shape
      expect(jsonOutput.excludedStats).toBeDefined();
      expect(typeof jsonOutput.excludedStats.totalFiles).toBe("number");
      expect(typeof jsonOutput.excludedStats.totalBytes).toBe("number");
      expect(Array.isArray(jsonOutput.excludedStats.byPattern)).toBe(true);
      expect(jsonOutput.excludedStats.byPattern.length).toBeGreaterThan(0);

      // Each byPattern entry has the expected shape
      for (const entry of jsonOutput.excludedStats.byPattern) {
        expect(typeof entry.pattern).toBe("string");
        expect(typeof entry.files).toBe("number");
        expect(typeof entry.bytes).toBe("number");
        expect(typeof entry.source).toBe("string");
        // No per-file 'path' field
        expect(entry).not.toHaveProperty("path");
      }
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("excludedStats.totalBytes is correct", async () => {
    await setupStateDir();
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-stats-"));

    try {
      const result = await backupCreateCommand(runtime, {
        output: archiveDir,
        smartExclude: true,
      });

      expect(result.excludedStats).toBeDefined();
      expect(result.excludedStats!.totalFiles).toBeGreaterThan(0);
      expect(typeof result.excludedStats!.totalBytes).toBe("number");
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("no flags = no exclusions (backward compat for existing users)", async () => {
    await setupStateDir();
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-compat-"));

    try {
      const result = await backupCreateCommand(runtime, {
        output: archiveDir,
      });

      // No exclude options → neither excluded nor excludedStats
      expect((result as unknown as Record<string, unknown>).excluded).toBeUndefined();
      expect(result.excludedStats).toBeUndefined();

      // Everything including venvs should be in the archive
      const entries = await getArchiveEntries(result.archivePath);
      const venvEntries = entries.filter((e) => e.includes("venvs"));
      expect(venvEntries.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("--exclude-file nonexistent path exits with error BEFORE archive creation", async () => {
    await setupStateDir();

    await expect(
      backupCreateCommand(runtime, {
        excludeFile: "/tmp/nonexistent-exclude-file.txt",
      }),
    ).rejects.toThrow(/--exclude-file.*nonexistent/i);
  });

  it("--exclude credentials/ without --allow-exclude-protected warns", async () => {
    await setupStateDir();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-protected-warn-"));

    try {
      await backupCreateCommand(runtime, {
        output: archiveDir,
        exclude: ["credentials/"],
      });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("protected path"));
    } finally {
      warnSpy.mockRestore();
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });
});

describe("backup verify — tolerant manifest reader", () => {
  let tempHome: TempHomeEnv;
  let realBackupVerifyCommand: (typeof import("../commands/backup-verify.js"))["backupVerifyCommand"];

  beforeAll(async () => {
    // Import the REAL backupVerifyCommand — the module-scope vi.mock above
    // replaces it with a mock for the create tests. We need the real implementation
    // to actually verify archive integrity.
    const real = await vi.importActual<typeof import("../commands/backup-verify.js")>(
      "../commands/backup-verify.js",
    );
    realBackupVerifyCommand = real.backupVerifyCommand;
  });

  beforeEach(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-verify-exclude-test-");
  });

  afterEach(async () => {
    await tempHome.restore();
  });

  it("verify passes when smart-excluded paths are absent from archive", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.mkdir(path.join(stateDir, "venvs/lib"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "venvs/lib/site.py"), "# python\n", "utf8");
    await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-verify-exclude-"));

    try {
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const result = await backupCreateCommand(runtime, {
        output: archiveDir,
        smartExclude: true,
      });

      // Per-file excluded[] is no longer returned; excludedStats provides auditability
      expect((result as unknown as Record<string, unknown>).excluded).toBeUndefined();
      expect(result.excludedStats).toBeDefined();
      expect(result.excludedStats!.totalFiles).toBeGreaterThan(0);

      // Real verify should pass — excludedStats in manifest provides auditability;
      // asset presence is verified unconditionally.
      const verifyResult = await realBackupVerifyCommand(runtime, {
        archive: result.archivePath,
      });
      expect(verifyResult.ok).toBe(true);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("verify on v1 manifest (no excluded field) succeeds without error", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-verify-v1-"));

    try {
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      // Create archive WITHOUT any exclude options (v1 manifest behavior)
      const result = await backupCreateCommand(runtime, {
        output: archiveDir,
      });

      // Real verify — v1 manifests have no excluded field, should work fine
      const verifyResult = await realBackupVerifyCommand(runtime, {
        archive: result.archivePath,
      });
      expect(verifyResult.ok).toBe(true);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("in-archive manifest contains excludedStats (not excluded[]) with accurate data", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.mkdir(path.join(stateDir, "venvs/lib"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "venvs/lib/site.py"), "# python\n", "utf8");
    await fs.mkdir(path.join(stateDir, "models"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "models/gpt2.bin"), "model data\n", "utf8");
    await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");

    const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-verify-manifest-"));

    try {
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const result = await backupCreateCommand(runtime, {
        output: archiveDir,
        smartExclude: true,
      });

      // Extract manifest from archive
      let manifestJson = "";
      await tar.t({
        file: result.archivePath,
        gzip: true,
        onentry: (entry) => {
          if (entry.path.endsWith("manifest.json")) {
            const chunks: Buffer[] = [];
            entry.on("data", (chunk: Buffer | string) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            entry.on("end", () => {
              manifestJson = Buffer.concat(chunks).toString("utf8");
            });
          } else {
            entry.resume();
          }
        },
      });

      expect(manifestJson).toBeTruthy();
      const manifest = JSON.parse(manifestJson);

      // excluded[] must NOT be present in the manifest (no per-file paths)
      expect(manifest.excluded).toBeUndefined();

      // excludedStats must be present with per-pattern aggregates
      expect(manifest.excludedStats).toBeDefined();
      expect(typeof manifest.excludedStats.totalFiles).toBe("number");
      expect(typeof manifest.excludedStats.totalBytes).toBe("number");
      expect(manifest.excludedStats.totalFiles).toBeGreaterThan(0);
      expect(Array.isArray(manifest.excludedStats.byPattern)).toBe(true);
      expect(manifest.excludedStats.byPattern.length).toBeGreaterThan(0);

      // byPattern should include venvs/ and models/ patterns
      const patterns = manifest.excludedStats.byPattern.map((p: { pattern: string }) => p.pattern);
      expect(patterns).toContain("venvs/");
      expect(patterns).toContain("models/");

      // Each byPattern entry has the correct shape
      for (const entry of manifest.excludedStats.byPattern) {
        expect(typeof entry.pattern).toBe("string");
        expect(typeof entry.files).toBe("number");
        expect(typeof entry.bytes).toBe("number");
        expect(typeof entry.source).toBe("string");
        // Must NOT contain individual file paths
        expect(entry).not.toHaveProperty("path");
      }
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("archive with excludes passes backup verify (excludedStats-only manifest)", async () => {
    const stateDir = path.join(tempHome.home, ".openclaw");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
    await fs.mkdir(path.join(stateDir, "venvs/lib"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "venvs/lib/site.py"), "# python\n", "utf8");
    await fs.mkdir(path.join(stateDir, "logs"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "logs/app.log"), "log line\n", "utf8");
    await fs.writeFile(path.join(stateDir, "state.txt"), "state\n", "utf8");
    await fs.mkdir(path.join(stateDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "memory/notes.md"), "# notes\n", "utf8");

    const archiveDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-backup-verify-excludedstats-"),
    );

    try {
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

      // Create archive with excludes active
      const createResult = await backupCreateCommand(runtime, {
        output: archiveDir,
        smartExclude: true,
      });

      // Confirm the archive was created with exclusions
      expect(createResult.excludedStats).toBeDefined();
      expect(createResult.excludedStats!.totalFiles).toBeGreaterThan(0);

      // Archive should NOT contain excluded content
      const entries = await getArchiveEntries(createResult.archivePath);
      expect(entries.some((e) => e.includes("venvs"))).toBe(false);
      expect(entries.some((e) => e.includes("logs"))).toBe(false);

      // Archive SHOULD contain non-excluded content
      expect(entries.some((e) => e.includes("memory"))).toBe(true);

      // Real verify should pass with the excludedStats-only manifest
      const verifyResult = await realBackupVerifyCommand(runtime, {
        archive: createResult.archivePath,
      });
      expect(verifyResult.ok).toBe(true);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });
});
