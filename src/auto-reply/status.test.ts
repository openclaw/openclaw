import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStatusMessage } from "./status.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildStatusMessage", () => {
  it("summarizes agent readiness and context usage", () => {
    const text = buildStatusMessage({
      reply: {
        mode: "command",
        command: ["echo", "{{Body}}"],
        agent: { kind: "pi", model: "pi:opus", contextTokens: 32_000 },
        session: { scope: "per-sender" },
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        totalTokens: 16_000,
        contextTokens: 32_000,
        thinkingLevel: "low",
        verboseLevel: "on",
      },
      sessionKey: "main",
      sessionScope: "per-sender",
      storePath: "/tmp/sessions.json",
      resolvedThink: "medium",
      resolvedVerbose: "off",
      now: 10 * 60_000, // 10 minutes later
      webLinked: true,
      webAuthAgeMs: 5 * 60_000,
      heartbeatSeconds: 45,
    });

    expect(text).toContain("⚙️ Status");
    expect(text).toContain("Agent: ready");
    expect(text).toContain("Context: 16k/32k (50%)");
    expect(text).toContain("Session: main");
    expect(text).toContain("Web: linked");
    expect(text).toContain("heartbeat 45s");
    expect(text).toContain("thinking=medium");
    expect(text).toContain("verbose=off");
  });

  it("handles missing agent command gracefully", () => {
    const text = buildStatusMessage({
      reply: {
        mode: "command",
        command: [],
        session: { scope: "per-sender" },
      },
      sessionScope: "per-sender",
      webLinked: false,
    });

    expect(text).toContain("Agent: check");
    expect(text).toContain("not set");
    expect(text).toContain("Context:");
    expect(text).toContain("Web: not linked");
  });

  it("prefers cached prompt tokens from the session log", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdis-status-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "sess-1";
    const logPath = path.join(dir, `${sessionId}.jsonl`);

    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: "claude-opus-4-5",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 1000,
              cacheWrite: 0,
              totalTokens: 1003,
            },
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const text = buildStatusMessage({
      reply: {
        mode: "command",
        command: ["echo", "{{Body}}"],
        agent: { kind: "pi", model: "claude-opus-4-5", contextTokens: 32_000 },
        session: { scope: "per-sender" },
      },
      sessionEntry: {
        sessionId,
        updatedAt: 0,
        totalTokens: 3, // would be wrong if cached prompt tokens exist
        contextTokens: 32_000,
      },
      sessionKey: "main",
      sessionScope: "per-sender",
      storePath,
      webLinked: true,
    });

    expect(text).toContain("Context: 1.0k/32k");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
