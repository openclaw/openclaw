import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
  readFlushInstructions,
  resolveMemoryFlushPromptForRun,
  resolveMemoryFlushSettings,
} from "./memory-flush.js";

describe("resolveMemoryFlushPromptForRun", () => {
  const cfg = {
    agents: {
      defaults: {
        userTimezone: "America/New_York",
        timeFormat: "12",
      },
    },
  } as OpenClawConfig;

  it("replaces YYYY-MM-DD using user timezone and appends current time", () => {
    const prompt = resolveMemoryFlushPromptForRun({
      prompt: "Store durable notes in memory/YYYY-MM-DD.md",
      cfg,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(prompt).toContain("memory/2026-02-16.md");
    expect(prompt).toContain("Current time:");
    expect(prompt).toContain("(America/New_York)");
  });

  it("does not append a duplicate current time line", () => {
    const prompt = resolveMemoryFlushPromptForRun({
      prompt: "Store notes.\nCurrent time: already present",
      cfg,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(prompt).toContain("Current time: already present");
    expect((prompt.match(/Current time:/g) ?? []).length).toBe(1);
  });
});

describe("DEFAULT_MEMORY_FLUSH_SOFT_TOKENS", () => {
  it("defaults to 8000", () => {
    expect(DEFAULT_MEMORY_FLUSH_SOFT_TOKENS).toBe(8000);
  });

  it("resolveMemoryFlushSettings uses 8000 when no override", () => {
    const settings = resolveMemoryFlushSettings({} as OpenClawConfig);
    expect(settings?.softThresholdTokens).toBe(8000);
  });
});

describe("readFlushInstructions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flush-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when FLUSH.md does not exist", async () => {
    const result = await readFlushInstructions(tmpDir);
    expect(result).toBeNull();
  });

  it("returns flush instructions from FLUSH.md", async () => {
    await fs.writeFile(
      path.join(tmpDir, "FLUSH.md"),
      "Update SESSION-STATE.md\nUpdate daily log\n",
    );
    const result = await readFlushInstructions(tmpDir);
    expect(result).toContain("FLUSH.md");
    expect(result).toContain("Update SESSION-STATE.md");
    expect(result).toContain("Update daily log");
  });

  it("returns null for empty FLUSH.md", async () => {
    await fs.writeFile(path.join(tmpDir, "FLUSH.md"), "   \n  ");
    const result = await readFlushInstructions(tmpDir);
    expect(result).toBeNull();
  });

  it("truncates oversized FLUSH.md", async () => {
    const bigContent = "x".repeat(5000);
    await fs.writeFile(path.join(tmpDir, "FLUSH.md"), bigContent);
    const result = await readFlushInstructions(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThan(5100);
  });
});
