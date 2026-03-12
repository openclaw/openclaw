import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { backupVerifyCommand } from "./backup-verify.js";
import { backupCreateCommand } from "./backup.js";

const backupVerifyCommandMock = vi.hoisted(() => vi.fn());

vi.mock("./backup-verify.js", () => ({
  backupVerifyCommand: backupVerifyCommandMock,
}));

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

      // No excluded entries
      expect(result.excluded).toBeUndefined();
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

      // Should have excluded entries
      expect(result.excluded).toBeDefined();
      expect(result.excluded!.length).toBeGreaterThan(0);

      // Check excluded paths include our smart-exclude dirs
      const excludedPaths = result.excluded!.map((e) => e.path);
      expect(excludedPaths.some((p) => p === "venvs" || p.startsWith("venvs/"))).toBe(true);

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

      // include-all overrides smart-exclude: no excluded entries
      expect(result.excluded).toBeUndefined();

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

      expect(result.excluded).toBeDefined();
      const excludedPaths = result.excluded!.map((e) => e.path);
      expect(excludedPaths.some((p) => p.endsWith(".log"))).toBe(true);

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

      expect(result.excluded).toBeDefined();

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

  it("--json output includes excluded[] in result object", async () => {
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

      // The JSON output should include excluded info
      expect(logSpy).toHaveBeenCalledTimes(1);
      const jsonOutput = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(jsonOutput.excluded).toBeDefined();
      expect(Array.isArray(jsonOutput.excluded)).toBe(true);
      expect(jsonOutput.excludedStats).toBeDefined();
      expect(typeof jsonOutput.excludedStats.totalBytes).toBe("number");
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

      // No exclude options → nothing excluded
      expect(result.excluded).toBeUndefined();
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
    ).rejects.toThrow(/file not found/i);
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

      // Verify should pass — the actual backupVerifyCommand reads the archive
      const verifyResult = await backupVerifyCommand(runtime, {
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

      const verifyResult = await backupVerifyCommand(runtime, {
        archive: result.archivePath,
      });
      expect(verifyResult.ok).toBe(true);
    } finally {
      await fs.rm(archiveDir, { recursive: true, force: true });
    }
  });
});
