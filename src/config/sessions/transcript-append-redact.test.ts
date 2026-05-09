import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveSessionTranscriptPathInDir } from "./paths.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";
import { appendExactAssistantMessageToSessionTranscript } from "./transcript.js";

function readMessages(sessionFile: string) {
  return fs
    .readFileSync(sessionFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; message?: unknown })
    .filter((r) => r.type === "message")
    .map((r) => r.message);
}

describe("appendSessionTranscriptMessage - redaction", () => {
  const fixture = useTempSessionsFixture("transcript-redact-test-");
  it("masks secrets in message content before writing to disk", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir("redact-on", fixture.sessionsDir());
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: [{ type: "text", text: "my key is sk-abcdef1234567890xyz ok" }],
      },
      config,
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).toContain("ok"); // safe text preserved

    const [msg] = readMessages(sessionFile) as Array<{
      content: Array<{ text: string }>;
    }>;
    expect(msg.content[0].text).not.toContain("sk-abcdef1234567890xyz");
  });

  it("writes content unchanged when redactSensitive is off", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir("redact-off", fixture.sessionsDir());
    const config: OpenClawConfig = { logging: { redactSensitive: "off" } };

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: [{ type: "text", text: "my key is sk-abcdef1234567890xyz" }],
      },
      config,
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).toContain("sk-abcdef1234567890xyz");
  });

  it("masks secrets when config is undefined (default patterns)", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir("redact-undef", fixture.sessionsDir());

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "user",
        content: [{ type: "text", text: "my key is sk-abcdef1234567890xyz" }],
      },
      // config intentionally omitted
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
  });

  it("masks secrets in assistant tool-call arguments before writing to disk", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "redact-tool-call-args",
      fixture.sessionsDir(),
    );
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "shell",
            arguments: {
              command: "OPENAI_API_KEY=sk-abcdef1234567890xyz openclaw health",
              env: { nested: ["token sk-abcdef1234567890xyz"] },
              apiKey: "plainsecretvalue123",
              password: "hunter2",
            },
          },
        ],
      },
      config,
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).not.toContain("plainsecretvalue123");
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain("openclaw health");

    const [msg] = readMessages(sessionFile) as Array<{
      content: Array<{ arguments: unknown }>;
    }>;
    expect(JSON.stringify(msg.content[0].arguments)).not.toContain("sk-abcdef1234567890xyz");
  });

  it("masks secrets in tool-result details before writing to disk", async () => {
    const sessionFile = resolveSessionTranscriptPathInDir(
      "redact-tool-result-details",
      fixture.sessionsDir(),
    );
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      transcriptPath: sessionFile,
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "send_request",
        content: [{ type: "text", text: "result sk-abcdef1234567890xyz" }],
        details: {
          apiKey: "plainsecretvalue123",
          password: "hunter2",
          nested: { accessToken: ["nestedplainsecret123"] },
          safe: "visible",
        },
        isError: false,
        timestamp: Date.now(),
      },
      config,
    });

    const raw = fs.readFileSync(sessionFile, "utf-8");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).not.toContain("plainsecretvalue123");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("nestedplainsecret123");
    expect(raw).toContain("visible");

    const [msg] = readMessages(sessionFile) as Array<{
      content: Array<{ text: string }>;
      details: unknown;
    }>;
    expect(msg.content[0].text).not.toContain("sk-abcdef1234567890xyz");
    expect(JSON.stringify(msg.details)).not.toContain("plainsecretvalue123");
  });
});

describe("appendExactAssistantMessageToSessionTranscript - redaction", () => {
  const fixture = useTempSessionsFixture("exact-assistant-redact-test-");

  it("does not redact when config.logging.redactSensitive is off", async () => {
    // Set up a minimal session store so the function can resolve the session file.
    const sessionsDir = fixture.sessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "test-session-redact-off";
    const sessionKey = "test-channel:test-user";
    const store = {
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    };
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });

    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const config: OpenClawConfig = { logging: { redactSensitive: "off" } };

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath,
      config,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Here is your key: ${fakeApiKey}` }],
        api: "openai-responses",
        provider: "openclaw",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const raw = fs.readFileSync(result.sessionFile, "utf-8");
    expect(raw).toContain(fakeApiKey);
  });

  it("emits the redacted assistant message for inline transcript updates", async () => {
    const sessionsDir = fixture.sessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const sessionId = "test-session-redact-event";
    const sessionKey = "test-channel:test-redact-event";
    fs.writeFileSync(
      storePath,
      JSON.stringify({ [sessionKey]: { sessionId, updatedAt: Date.now() } }, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );

    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };
    const updates: Array<{ message?: unknown }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));

    try {
      const result = await appendExactAssistantMessageToSessionTranscript({
        sessionKey,
        storePath,
        config,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Here is your key: ${fakeApiKey}` }],
          api: "openai-responses",
          provider: "openclaw",
          model: "test-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const [diskMessage] = readMessages(result.sessionFile);
      expect(JSON.stringify(diskMessage)).not.toContain(fakeApiKey);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.message).toEqual(diskMessage);
      expect(JSON.stringify(updates[0]?.message)).not.toContain(fakeApiKey);
    } finally {
      unsubscribe();
    }
  });
});
