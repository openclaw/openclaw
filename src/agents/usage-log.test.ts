import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
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

    const exists = await fs.access(usageFile).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("skips writing when total is zero", async () => {
    await recordTokenUsage({
      workspaceDir: tmpDir,
      label: "llm_output",
      usage: { input: 0, output: 0 },
    });

    const exists = await fs.access(usageFile).then(() => true).catch(() => false);
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
});
