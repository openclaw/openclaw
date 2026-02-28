import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveIdleNudgeConfig, sweepIdleSessions, resetIdleNudgeState } from "./idle-nudge.js";

// Mock the imports
vi.mock("../agents/pi-embedded-runner/runs.js", () => ({
  isEmbeddedPiRunActive: vi.fn(() => false),
}));

vi.mock("../config/sessions/store.js", () => ({
  loadSessionStore: vi.fn(() => ({})),
}));

import { isEmbeddedPiRunActive } from "../agents/pi-embedded-runner/runs.js";
import { loadSessionStore } from "../config/sessions/store.js";

const mockIsActive = vi.mocked(isEmbeddedPiRunActive);
const mockLoadStore = vi.mocked(loadSessionStore);

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("resolveIdleNudgeConfig", () => {
  it("returns default config when undefined", () => {
    const cfg = resolveIdleNudgeConfig(undefined);
    expect(cfg).toEqual({ idleMs: 300_000, message: expect.any(String), maxNudges: 3 });
  });

  it("returns default config when true", () => {
    const cfg = resolveIdleNudgeConfig({ idleNudge: true });
    expect(cfg?.idleMs).toBe(300_000);
  });

  it("returns null when false", () => {
    expect(resolveIdleNudgeConfig({ idleNudge: false })).toBeNull();
  });

  it("returns null when 0", () => {
    expect(resolveIdleNudgeConfig({ idleNudge: 0 })).toBeNull();
  });

  it("accepts number as idleMs", () => {
    const cfg = resolveIdleNudgeConfig({ idleNudge: 60_000 });
    expect(cfg?.idleMs).toBe(60_000);
  });

  it("accepts object config", () => {
    const cfg = resolveIdleNudgeConfig({
      idleNudge: { idleMs: 120_000, message: "wake up", maxNudges: 1 },
    });
    expect(cfg).toEqual({ idleMs: 120_000, message: "wake up", maxNudges: 1 });
  });
});

describe("sweepIdleSessions", () => {
  beforeEach(() => {
    resetIdleNudgeState();
    mockIsActive.mockReturnValue(false);
  });

  it("nudges idle subagent sessions", async () => {
    const now = Date.now();
    mockLoadStore.mockReturnValue({
      "agent:default:subagent:abc": {
        sessionId: "s1",
        updatedAt: now - 6 * 60_000,
      },
    } as any);

    const nudge = vi.fn().mockResolvedValue({ status: "ok" });
    const result = await sweepIdleSessions({
      sessionStorePath: "/tmp/sessions.json",
      config: { idleMs: 300_000, maxNudges: 3 },
      nowMs: now,
      log: noopLog,
      force: true,
      nudgeSession: nudge,
    });

    expect(result.nudged).toBe(1);
    expect(nudge).toHaveBeenCalledWith(
      "agent:default:subagent:abc",
      expect.stringContaining("idle"),
    );
  });

  it("nudges idle cron sessions", async () => {
    const now = Date.now();
    mockLoadStore.mockReturnValue({
      "agent:default:cron:job1": {
        sessionId: "s2",
        updatedAt: now - 10 * 60_000,
      },
    } as any);

    const nudge = vi.fn().mockResolvedValue({ status: "ok" });
    const result = await sweepIdleSessions({
      sessionStorePath: "/tmp/sessions.json",
      config: { idleMs: 300_000, maxNudges: 3 },
      nowMs: now,
      log: noopLog,
      force: true,
      nudgeSession: nudge,
    });

    expect(result.nudged).toBe(1);
  });

  it("nudges idle ticket sessions", async () => {
    const now = Date.now();
    mockLoadStore.mockReturnValue({
      "agent:voss:ticket:71:voss": {
        sessionId: "s3",
        updatedAt: now - 7 * 60_000,
      },
    } as any);

    const nudge = vi.fn().mockResolvedValue({ status: "ok" });
    const result = await sweepIdleSessions({
      sessionStorePath: "/tmp/sessions.json",
      config: { idleMs: 300_000, maxNudges: 3 },
      nowMs: now,
      log: noopLog,
      force: true,
      nudgeSession: nudge,
    });

    expect(result.nudged).toBe(1);
  });

  it("skips main sessions", async () => {
    const now = Date.now();
    mockLoadStore.mockReturnValue({
      "agent:default:main": {
        sessionId: "s4",
        updatedAt: now - 10 * 60_000,
      },
    } as any);

    const nudge = vi.fn().mockResolvedValue({ status: "ok" });
    const result = await sweepIdleSessions({
      sessionStorePath: "/tmp/sessions.json",
      config: { idleMs: 300_000, maxNudges: 3 },
      nowMs: now,
      log: noopLog,
      force: true,
      nudgeSession: nudge,
    });

    expect(result.nudged).toBe(0);
    expect(nudge).not.toHaveBeenCalled();
  });

  it("skips sessions with active runs", async () => {
    const now = Date.now();
    mockLoadStore.mockReturnValue({
      "agent:default:subagent:abc": {
        sessionId: "active-session",
        updatedAt: now - 10 * 60_000,
      },
    } as any);
    mockIsActive.mockReturnValue(true);

    const nudge = vi.fn().mockResolvedValue({ status: "ok" });
    const result = await sweepIdleSessions({
      sessionStorePath: "/tmp/sessions.json",
      config: { idleMs: 300_000, maxNudges: 3 },
      nowMs: now,
      log: noopLog,
      force: true,
      nudgeSession: nudge,
    });

    expect(result.nudged).toBe(0);
  });

  it("skips recently updated sessions", async () => {
    const now = Date.now();
    mockLoadStore.mockReturnValue({
      "agent:default:subagent:abc": {
        sessionId: "s5",
        updatedAt: now - 2 * 60_000,
      },
    } as any);

    const nudge = vi.fn().mockResolvedValue({ status: "ok" });
    const result = await sweepIdleSessions({
      sessionStorePath: "/tmp/sessions.json",
      config: { idleMs: 300_000, maxNudges: 3 },
      nowMs: now,
      log: noopLog,
      force: true,
      nudgeSession: nudge,
    });

    expect(result.nudged).toBe(0);
  });

  it("respects maxNudges limit", async () => {
    const now = Date.now();
    mockLoadStore.mockReturnValue({
      "agent:default:subagent:abc": {
        sessionId: "s6",
        updatedAt: now - 10 * 60_000,
      },
    } as any);

    const nudge = vi.fn().mockResolvedValue({ status: "ok" });
    const config = { idleMs: 300_000, maxNudges: 2 };

    for (let i = 0; i < 3; i++) {
      await sweepIdleSessions({
        sessionStorePath: "/tmp/sessions.json",
        config,
        nowMs: now + i * 60_000,
        log: noopLog,
        force: true,
        nudgeSession: nudge,
      });
    }

    expect(nudge).toHaveBeenCalledTimes(2);
  });

  it("skips sessions where last assistant message is END", async () => {
    const now = Date.now();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-nudge-test-"));
    const sessionId = "end-session-123";
    const jsonlPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: sessionId }),
      JSON.stringify({
        type: "message",
        id: "m1",
        message: { role: "user", content: [{ type: "text", text: "do something" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m2",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done. Updated files.\nEND" }],
        },
      }),
    ];
    fs.writeFileSync(jsonlPath, lines.join("\n") + "\n");

    mockLoadStore.mockReturnValue({
      "agent:default:subagent:abc": {
        sessionId,
        updatedAt: now - 10 * 60_000,
      },
    } as any);

    const nudge = vi.fn().mockResolvedValue({ status: "ok" });
    const result = await sweepIdleSessions({
      sessionStorePath: "/tmp/sessions.json",
      sessionsDir: tmpDir,
      config: { idleMs: 300_000, maxNudges: 3 },
      nowMs: now,
      log: noopLog,
      force: true,
      nudgeSession: nudge,
    });

    expect(result.nudged).toBe(0);
    expect(nudge).not.toHaveBeenCalled();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("nudges sessions where last assistant message is NOT END", async () => {
    const now = Date.now();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-nudge-test-"));
    const sessionId = "not-end-session-456";
    const jsonlPath = path.join(tmpDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: sessionId }),
      JSON.stringify({
        type: "message",
        id: "m1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I'm working on it..." }],
        },
      }),
    ];
    fs.writeFileSync(jsonlPath, lines.join("\n") + "\n");

    mockLoadStore.mockReturnValue({
      "agent:default:subagent:xyz": {
        sessionId,
        updatedAt: now - 10 * 60_000,
      },
    } as any);

    const nudge = vi.fn().mockResolvedValue({ status: "ok" });
    const result = await sweepIdleSessions({
      sessionStorePath: "/tmp/sessions.json",
      sessionsDir: tmpDir,
      config: { idleMs: 300_000, maxNudges: 3 },
      nowMs: now,
      log: noopLog,
      force: true,
      nudgeSession: nudge,
    });

    expect(result.nudged).toBe(1);
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("throttles sweeps", async () => {
    const now = Date.now();
    mockLoadStore.mockReturnValue({
      "agent:default:subagent:abc": {
        sessionId: "s7",
        updatedAt: now - 10 * 60_000,
      },
    } as any);

    const nudge = vi.fn().mockResolvedValue({ status: "ok" });

    await sweepIdleSessions({
      sessionStorePath: "/tmp/sessions.json",
      config: { idleMs: 300_000, maxNudges: 10 },
      nowMs: now,
      log: noopLog,
      force: true,
      nudgeSession: nudge,
    });

    const result = await sweepIdleSessions({
      sessionStorePath: "/tmp/sessions.json",
      config: { idleMs: 300_000, maxNudges: 10 },
      nowMs: now + 30_000,
      log: noopLog,
      nudgeSession: nudge,
    });

    expect(result.swept).toBe(false);
  });
});
