import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  purgeOldTranscripts,
  ToolCallBudget,
  ToolCallBudgetExceeded,
  collectChannelTokenReuseFindings,
} from "./runtime-safety.js";

// =========================================================================
// 1. Transcript retention
// =========================================================================

describe("purgeOldTranscripts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "retention-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createOldFile(name: string, ageDays: number): void {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, "test content");
    const pastMs = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    fs.utimesSync(filePath, new Date(pastMs), new Date(pastMs));
  }

  function createRecentFile(name: string): void {
    fs.writeFileSync(path.join(tmpDir, name), "test content");
  }

  it("deletes JSONL files older than maxAgeDays", () => {
    createOldFile("old-session.jsonl", 60);
    createRecentFile("new-session.jsonl");

    const result = purgeOldTranscripts(tmpDir, 30);
    expect(result.deletedFiles).toBe(1);
    expect(result.deletedPaths[0]).toContain("old-session.jsonl");
    expect(fs.existsSync(path.join(tmpDir, "new-session.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "old-session.jsonl"))).toBe(false);
  });

  it("does not delete non-JSONL files", () => {
    createOldFile("config.json", 60);

    const result = purgeOldTranscripts(tmpDir, 30);
    expect(result.deletedFiles).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, "config.json"))).toBe(true);
  });

  it("returns zero when maxAgeDays is 0 (disabled)", () => {
    createOldFile("old.jsonl", 60);

    const result = purgeOldTranscripts(tmpDir, 0);
    expect(result.scannedFiles).toBe(0);
    expect(result.deletedFiles).toBe(0);
  });

  it("handles non-existent directory gracefully", () => {
    const result = purgeOldTranscripts("/nonexistent/path", 30);
    expect(result.scannedFiles).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles empty directory", () => {
    const result = purgeOldTranscripts(tmpDir, 30);
    expect(result.scannedFiles).toBe(0);
    expect(result.deletedFiles).toBe(0);
  });

  it("deletes multiple old files", () => {
    createOldFile("session-1.jsonl", 90);
    createOldFile("session-2.jsonl", 45);
    createRecentFile("session-3.jsonl");

    const result = purgeOldTranscripts(tmpDir, 30);
    expect(result.deletedFiles).toBe(2);
    expect(result.scannedFiles).toBe(3);
  });

  it("counts scanned files correctly", () => {
    createRecentFile("a.jsonl");
    createRecentFile("b.jsonl");
    createRecentFile("c.txt");

    const result = purgeOldTranscripts(tmpDir, 30);
    expect(result.scannedFiles).toBe(2);
    expect(result.deletedFiles).toBe(0);
  });
});

// =========================================================================
// 2. Tool call budget
// =========================================================================

describe("ToolCallBudget", () => {
  it("allows calls within budget", () => {
    const budget = new ToolCallBudget(5);
    expect(() => budget.check("session-1")).not.toThrow();
    expect(() => budget.check("session-1")).not.toThrow();
    expect(budget.getCount("session-1")).toBe(2);
  });

  it("throws ToolCallBudgetExceeded when limit reached", () => {
    const budget = new ToolCallBudget(3);
    budget.check("s1");
    budget.check("s1");
    budget.check("s1");
    expect(() => budget.check("s1")).toThrow(ToolCallBudgetExceeded);
  });

  it("error includes limit and current count", () => {
    const budget = new ToolCallBudget(2);
    budget.check("s1");
    budget.check("s1");
    try {
      budget.check("s1");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolCallBudgetExceeded);
      expect((err as ToolCallBudgetExceeded).limit).toBe(2);
      expect((err as ToolCallBudgetExceeded).current).toBe(3);
    }
  });

  it("tracks separate sessions independently", () => {
    const budget = new ToolCallBudget(2);
    budget.check("s1");
    budget.check("s1");
    expect(() => budget.check("s2")).not.toThrow();
    expect(budget.getCount("s1")).toBe(2);
    expect(budget.getCount("s2")).toBe(1);
  });

  it("does nothing when limit is 0 (disabled)", () => {
    const budget = new ToolCallBudget(0);
    for (let i = 0; i < 100; i++) {
      expect(() => budget.check("s1")).not.toThrow();
    }
  });

  it("resets a single session", () => {
    const budget = new ToolCallBudget(3);
    budget.check("s1");
    budget.check("s1");
    budget.reset("s1");
    expect(budget.getCount("s1")).toBe(0);
    expect(() => budget.check("s1")).not.toThrow();
  });

  it("resets all sessions", () => {
    const budget = new ToolCallBudget(3);
    budget.check("s1");
    budget.check("s2");
    budget.resetAll();
    expect(budget.getCount("s1")).toBe(0);
    expect(budget.getCount("s2")).toBe(0);
  });

  it("returns 0 for unknown sessions", () => {
    const budget = new ToolCallBudget(10);
    expect(budget.getCount("nonexistent")).toBe(0);
  });
});

// =========================================================================
// 3. Channel token reuse detection
// =========================================================================

describe("collectChannelTokenReuseFindings", () => {
  it("detects same token used across Telegram and Discord", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: { botToken: "shared-token-123" },
        discord: { token: "shared-token-123" },
      },
    } as OpenClawConfig;
    const findings = collectChannelTokenReuseFindings(cfg);
    const f = findings.find((f) => f.checkId === "credentials.token_reuse_across_channels");
    expect(f).toBeDefined();
    expect(f?.detail).toContain("channels.telegram.botToken");
    expect(f?.detail).toContain("channels.discord.token");
  });

  it("does not flag unique tokens", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: { botToken: "telegram-unique-token" },
        discord: { token: "discord-unique-token" },
      },
    } as OpenClawConfig;
    const findings = collectChannelTokenReuseFindings(cfg);
    expect(
      findings.find((f) => f.checkId === "credentials.token_reuse_across_channels"),
    ).toBeUndefined();
  });

  it("skips env var references", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: { botToken: "${TELEGRAM_TOKEN}" },
        discord: { token: "${TELEGRAM_TOKEN}" },
      },
    } as OpenClawConfig;
    const findings = collectChannelTokenReuseFindings(cfg);
    expect(findings).toHaveLength(0);
  });

  it("handles empty channels config", () => {
    const cfg: OpenClawConfig = {};
    const findings = collectChannelTokenReuseFindings(cfg);
    expect(findings).toHaveLength(0);
  });

  it("handles channels with no tokens configured", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: {} },
    } as OpenClawConfig;
    const findings = collectChannelTokenReuseFindings(cfg);
    expect(findings).toHaveLength(0);
  });

  it("detects reuse across Slack botToken and appToken", () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: { botToken: "same-slack-token", appToken: "same-slack-token" },
      },
    } as OpenClawConfig;
    const findings = collectChannelTokenReuseFindings(cfg);
    expect(
      findings.find((f) => f.checkId === "credentials.token_reuse_across_channels"),
    ).toBeDefined();
  });
});
