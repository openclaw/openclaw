import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  DEFAULT_MEMORY_FLUSH_PROMPT,
  ensureMemoryFlushTarget,
  resolveMemoryFlushPromptForRun,
  resolveMemoryFlushRelativePathForRun,
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
    expect(prompt).toContain(
      "Current time: Monday, February 16th, 2026 — 10:00 AM (America/New_York) / 2026-02-16 15:00 UTC",
    );
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

  it("resolves the canonical relative memory path using user timezone", () => {
    const relativePath = resolveMemoryFlushRelativePathForRun({
      cfg,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(relativePath).toBe("memory/2026-02-16.md");
  });
});

describe("ensureMemoryFlushTarget", () => {
  const tmpDir = path.join("/tmp", `test-memory-flush-target-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates memory/ directory and daily file when missing", async () => {
    const nowMs = Date.UTC(2026, 2, 17, 12, 0, 0);
    await ensureMemoryFlushTarget({ workspaceDir: tmpDir, nowMs });
    const filePath = path.join(tmpDir, "memory", "2026-03-17.md");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("does not overwrite an existing daily file", async () => {
    const memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    const filePath = path.join(memoryDir, "2026-03-17.md");
    fs.writeFileSync(filePath, "existing content");
    const nowMs = Date.UTC(2026, 2, 17, 12, 0, 0);
    await ensureMemoryFlushTarget({ workspaceDir: tmpDir, nowMs });
    expect(fs.readFileSync(filePath, "utf-8")).toBe("existing content");
  });

  it("is a no-op when called repeatedly", async () => {
    const nowMs = Date.UTC(2026, 2, 17, 12, 0, 0);
    await ensureMemoryFlushTarget({ workspaceDir: tmpDir, nowMs });
    await ensureMemoryFlushTarget({ workspaceDir: tmpDir, nowMs });
    const filePath = path.join(tmpDir, "memory", "2026-03-17.md");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("");
  });
});

describe("DEFAULT_MEMORY_FLUSH_PROMPT", () => {
  it("includes append-only instruction to prevent overwrites (#6877)", () => {
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toMatch(/APPEND/i);
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("do not overwrite");
  });

  it("includes anti-fragmentation instruction to prevent timestamped variant files (#34919)", () => {
    // Agents must not create YYYY-MM-DD-HHMM.md variants alongside the canonical file
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("timestamped variant");
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("YYYY-MM-DD.md");
  });
});
