import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { recordTokenUsage } from "./usage-log.js";

describe("recordTokenUsage", () => {
  let tmpDir: string;
  let usageFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-log-test-"));
    usageFile = path.join(tmpDir, "memory", "token-usage.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes inputTokens and outputTokens when provided", async () => {
    await recordTokenUsage({
      workspaceDir: tmpDir,
      label: "llm_output",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      usage: { input: 1000, output: 500, total: 1500 },
    });

    const records = JSON.parse(await fs.readFile(usageFile, "utf-8"));
    expect(records).toHaveLength(1);
    expect(records[0].tokensUsed).toBe(1500);
    expect(records[0].inputTokens).toBe(1000);
    expect(records[0].outputTokens).toBe(500);
    expect(records[0].cacheReadTokens).toBeUndefined();
    expect(records[0].cacheWriteTokens).toBeUndefined();
  });

  it("writes cacheReadTokens and cacheWriteTokens when provided", async () => {
    await recordTokenUsage({
      workspaceDir: tmpDir,
      label: "llm_output",
      usage: { input: 800, output: 200, cacheRead: 300, cacheWrite: 100, total: 1400 },
    });

    const records = JSON.parse(await fs.readFile(usageFile, "utf-8"));
    expect(records[0].inputTokens).toBe(800);
    expect(records[0].outputTokens).toBe(200);
    expect(records[0].cacheReadTokens).toBe(300);
    expect(records[0].cacheWriteTokens).toBe(100);
  });

  it("omits IO fields when usage only has total (legacy records)", async () => {
    await recordTokenUsage({
      workspaceDir: tmpDir,
      label: "llm_output",
      usage: { total: 28402 },
    });

    const records = JSON.parse(await fs.readFile(usageFile, "utf-8"));
    expect(records[0].tokensUsed).toBe(28402);
    expect(records[0].inputTokens).toBeUndefined();
    expect(records[0].outputTokens).toBeUndefined();
  });

  it("skips writing when usage is undefined", async () => {
    await recordTokenUsage({
      workspaceDir: tmpDir,
      label: "llm_output",
      usage: undefined,
    });

    const exists = await fs
      .access(usageFile)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("skips writing when total is zero", async () => {
    await recordTokenUsage({
      workspaceDir: tmpDir,
      label: "llm_output",
      usage: { input: 0, output: 0 },
    });

    const exists = await fs
      .access(usageFile)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("appends multiple records to the same file", async () => {
    await recordTokenUsage({
      workspaceDir: tmpDir,
      label: "llm_output",
      usage: { input: 100, output: 50, total: 150 },
    });
    await recordTokenUsage({
      workspaceDir: tmpDir,
      label: "llm_output",
      usage: { input: 200, output: 80, total: 280 },
    });

    const records = JSON.parse(await fs.readFile(usageFile, "utf-8"));
    expect(records).toHaveLength(2);
    expect(records[0].inputTokens).toBe(100);
    expect(records[1].inputTokens).toBe(200);
  });

  it("truncates fractional tokens", async () => {
    await recordTokenUsage({
      workspaceDir: tmpDir,
      label: "llm_output",
      usage: { input: 100.9, output: 50.1, total: 151 },
    });

    const records = JSON.parse(await fs.readFile(usageFile, "utf-8"));
    expect(records[0].inputTokens).toBe(100);
    expect(records[0].outputTokens).toBe(50);
  });

  it("does not overwrite a valid-but-non-array token-usage.json — rejects unexpected shape", async () => {
    // Simulate a manual edit or migration that left a valid JSON object
    await fs.mkdir(path.join(tmpDir, "memory"), { recursive: true });
    await fs.writeFile(usageFile, '{"legacy": true, "records": []}', "utf-8");

    await expect(
      recordTokenUsage({
        workspaceDir: tmpDir,
        label: "llm_output",
        usage: { input: 100, output: 50, total: 150 },
      }),
    ).rejects.toThrow("not an array");

    // File must be unchanged — the legacy data is preserved.
    const content = await fs.readFile(usageFile, "utf-8");
    expect(content).toBe('{"legacy": true, "records": []}');
  });

  it("does not overwrite a malformed token-usage.json — preserves corrupted file", async () => {
    // Simulate an interrupted write that left partial JSON
    await fs.mkdir(path.join(tmpDir, "memory"), { recursive: true });
    await fs.writeFile(usageFile, '{"broken":true', "utf-8");

    // recordTokenUsage must reject (caller is responsible for handling, e.g.
    // attempt.ts uses .catch()) and must NOT overwrite the existing file.
    await expect(
      recordTokenUsage({
        workspaceDir: tmpDir,
        label: "llm_output",
        usage: { input: 100, output: 50, total: 150 },
      }),
    ).rejects.toThrow(SyntaxError);

    // File must still contain the original corrupted content, not a new array.
    const content = await fs.readFile(usageFile, "utf-8");
    expect(content).toBe('{"broken":true');
  });

  it("cross-process lock: concurrent writers via file lock do not lose records", async () => {
    // Simulate two processes bypassing the in-memory queue by calling
    // recordTokenUsage from independent promise chains simultaneously.
    // If the file lock is working they must still land all records.
    const N = 10;
    const writes = Array.from({ length: N }, (_, i) => {
      // Each call is deliberately NOT chained — they race on the file lock.
      return recordTokenUsage({
        workspaceDir: tmpDir,
        label: "llm_output",
        usage: { input: i + 1, output: 1, total: i + 2 },
      });
    });
    await Promise.all(writes);

    const records = JSON.parse(await fs.readFile(usageFile, "utf-8"));
    expect(records).toHaveLength(N);
  });

  it("reclaims stale lock left by a crashed process", async () => {
    // Spawn a subprocess that exits immediately, then use its (now-dead) PID
    // to simulate a lock file left behind after an abnormal exit.
    const deadPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
      const pid = child.pid!;
      child.on("exit", () => resolve(pid));
      child.on("error", reject);
    });

    const memoryDir = path.join(tmpDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    const lockPath = path.join(memoryDir, "token-usage.json.lock");
    // withFileLock (plugin-sdk) stores {pid, createdAt} — match that format.
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: deadPid, createdAt: new Date().toISOString() }),
    );

    // recordTokenUsage must detect the stale lock, reclaim it, and succeed.
    await recordTokenUsage({
      workspaceDir: tmpDir,
      label: "llm_output",
      usage: { input: 100, output: 50, total: 150 },
    });

    const records = JSON.parse(await fs.readFile(usageFile, "utf-8"));
    expect(records).toHaveLength(1);
    expect(records[0].tokensUsed).toBe(150);
    // Lock file must be cleaned up by the winner.
    const lockExists = await fs
      .access(lockPath)
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(false);
  });

  it("different path spellings for the same workspace share one queue — no record is lost", async () => {
    // Symlink tmpDir → another name so the same physical directory has two
    // spellings.  Without queue-key canonicalisation both spellings create
    // independent writeQueues entries; when one chain holds the file lock
    // (HELD_LOCKS set) the other re-entrantly joins it and both execute the
    // read-modify-write cycle concurrently, silently dropping entries.
    const symlinkDir = `${tmpDir}-symlink`;
    await fs.symlink(tmpDir, symlinkDir);
    try {
      // Mix canonical and symlink paths across concurrent writes.
      const N = 6;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          recordTokenUsage({
            workspaceDir: i % 2 === 0 ? tmpDir : symlinkDir,
            label: "llm_output",
            usage: { input: i + 1, output: 1, total: i + 2 },
          }),
        ),
      );

      // All N records must survive — none may be lost to a concurrent
      // read-modify-write collision.
      const records = JSON.parse(await fs.readFile(usageFile, "utf-8"));
      expect(records).toHaveLength(N);
    } finally {
      await fs.unlink(symlinkDir).catch(() => {});
    }
  });

  it("serialises concurrent writes — no record is lost", async () => {
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        recordTokenUsage({
          workspaceDir: tmpDir,
          label: "llm_output",
          usage: { input: i + 1, output: 1, total: i + 2 },
        }),
      ),
    );

    const records = JSON.parse(await fs.readFile(usageFile, "utf-8"));
    expect(records).toHaveLength(N);
    // Every distinct tokensUsed value must appear exactly once
    const totals = records
      .map((r: { tokensUsed: number }) => r.tokensUsed)
      .toSorted((a: number, b: number) => a - b);
    expect(totals).toEqual(Array.from({ length: N }, (_, i) => i + 2));
  });
});
