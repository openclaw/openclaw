import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { upsertSessionEntry } from "./store.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import { appendSessionTranscriptMessage } from "./transcript-append.js";
import { loadSqliteSessionTranscriptEvents } from "./transcript-store.sqlite.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
} from "./transcript.js";

const readLoggingConfig = vi.hoisted(() => vi.fn());

vi.mock("../../logging/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/config.js")>();
  return {
    ...actual,
    readLoggingConfig,
  };
});

const EMAIL_PATTERN = String.raw`([\w]|[-.])+@([\w]|[-.])+\.\w+`;

type TranscriptMessageEvent = {
  type?: string;
  message?: unknown;
};

function readEvents(sessionId: string, agentId = "main") {
  return loadSqliteSessionTranscriptEvents({ agentId, sessionId }).map(
    (record) => record.event as TranscriptMessageEvent,
  );
}

function readMessages(sessionId: string, agentId = "main") {
  return readEvents(sessionId, agentId)
    .filter((event) => event.type === "message")
    .map((event) => event.message);
}

function readRawTranscript(sessionId: string, agentId = "main") {
  return JSON.stringify(readEvents(sessionId, agentId));
}

function writeSessionEntry(params: { agentId?: string; sessionKey: string; sessionId: string }) {
  upsertSessionEntry({
    agentId: params.agentId ?? "main",
    sessionKey: params.sessionKey,
    entry: {
      sessionId: params.sessionId,
      chatType: "direct",
      channel: "test",
      updatedAt: Date.now(),
    },
  });
}

function createAssistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses" as const,
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
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("appendSessionTranscriptMessage - redaction", () => {
  useTempSessionsFixture("transcript-redact-test-");

  beforeEach(() => {
    readLoggingConfig.mockReset();
    readLoggingConfig.mockReturnValue(undefined);
  });

  it("masks secrets in message content before SQLite persistence", async () => {
    const sessionId = "redact-on";
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId,
      message: {
        role: "user",
        content: [{ type: "text", text: "my key is sk-abcdef1234567890xyz ok" }],
      },
      config,
    });

    const raw = readRawTranscript(sessionId);
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).toContain("ok");

    const [msg] = readMessages(sessionId) as Array<{
      content: Array<{ text: string }>;
    }>;
    expect(msg.content[0].text).not.toContain("sk-abcdef1234567890xyz");
  });

  it("writes content unchanged when redactSensitive is off", async () => {
    const sessionId = "redact-off";
    const config: OpenClawConfig = { logging: { redactSensitive: "off" } };

    await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId,
      message: {
        role: "user",
        content: [{ type: "text", text: "my key is sk-abcdef1234567890xyz" }],
      },
      config,
    });

    expect(readRawTranscript(sessionId)).toContain("sk-abcdef1234567890xyz");
  });

  it("masks secrets when config is undefined", async () => {
    const sessionId = "redact-undef";

    await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId,
      message: {
        role: "user",
        content: [{ type: "text", text: "my key is sk-abcdef1234567890xyz" }],
      },
    });

    expect(readRawTranscript(sessionId)).not.toContain("sk-abcdef1234567890xyz");
  });

  it("masks secrets in string payloads without role before SQLite persistence", async () => {
    const sessionId = "redact-string-payload";
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId,
      message: "my key is sk-abcdef1234567890xyz ok",
      config,
    });

    const raw = readRawTranscript(sessionId);
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).toContain("ok");

    const [msg] = readMessages(sessionId) as string[];
    expect(msg).not.toContain("sk-abcdef1234567890xyz");
    expect(msg).toContain("ok");
  });

  it("masks secrets in structured payloads without role before SQLite persistence", async () => {
    const sessionId = "redact-structured-no-role";
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId,
      message: {
        apiKey: "plainsecretvalue123",
        password: "hunter2",
        nested: { accessToken: ["nestedplainsecret123"] },
        command: "OPENAI_API_KEY=sk-abcdef1234567890xyz openclaw health",
        safe: "visible",
      },
      config,
    });

    const raw = readRawTranscript(sessionId);
    expect(raw).not.toContain("plainsecretvalue123");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("nestedplainsecret123");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).toContain("visible");

    const [msg] = readMessages(sessionId) as Array<{
      apiKey: string;
      password: string;
      nested: { accessToken: string[] };
      command: string;
      safe: string;
    }>;
    expect(msg.apiKey).toBe("plains…e123");
    expect(msg.password).toBe("***");
    expect(msg.nested.accessToken[0]).toBe("nested…t123");
    expect(msg.command).toBe("OPENAI_API_KEY=sk-abc…0xyz openclaw health");
    expect(msg.safe).toBe("visible");
  });

  it("uses configured custom patterns when cfg omits logging", async () => {
    const sessionId = "redact-config-pattern-fallback";
    readLoggingConfig.mockReturnValue({
      redactSensitive: "tools",
      redactPatterns: [EMAIL_PATTERN],
    });

    await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId,
      message: {
        role: "user",
        content: [{ type: "text", text: "email peter@dc.io and key sk-abcdef1234567890xyz ok" }],
      },
      config: {},
    });

    const raw = readRawTranscript(sessionId);
    expect(raw).not.toContain("peter@dc.io");
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).toContain("ok");
  });

  it("masks secrets in assistant tool-call arguments before SQLite persistence", async () => {
    const sessionId = "redact-tool-call-args";
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId,
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

    const raw = readRawTranscript(sessionId);
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).not.toContain("plainsecretvalue123");
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain("OPENAI_API_KEY=sk-abc…0xyz openclaw health");
    expect(raw).toContain("openclaw health");

    const [msg] = readMessages(sessionId) as Array<{
      content: Array<{
        arguments: {
          command: string;
          env: { nested: string[] };
          apiKey: string;
          password: string;
        };
      }>;
    }>;
    expect(JSON.stringify(msg.content[0].arguments)).not.toContain("sk-abcdef1234567890xyz");
    expect(msg.content[0].arguments.command).toBe("OPENAI_API_KEY=sk-abc…0xyz openclaw health");
    expect(msg.content[0].arguments.env.nested[0]).toBe("token sk-abc…0xyz");
    expect(msg.content[0].arguments.apiKey).toBe("plains…e123");
    expect(msg.content[0].arguments.password).toBe("***");
  });

  it("masks secrets in tool-result details before SQLite persistence", async () => {
    const sessionId = "redact-tool-result-details";
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    await appendSessionTranscriptMessage({
      agentId: "main",
      sessionId,
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

    const raw = readRawTranscript(sessionId);
    expect(raw).not.toContain("sk-abcdef1234567890xyz");
    expect(raw).not.toContain("plainsecretvalue123");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("nestedplainsecret123");
    expect(raw).toContain("visible");

    const [msg] = readMessages(sessionId) as Array<{
      content: Array<{ text: string }>;
      details: {
        apiKey: string;
        password: string;
        nested: { accessToken: string[] };
      };
    }>;
    expect(msg.content[0].text).not.toContain("sk-abcdef1234567890xyz");
    expect(JSON.stringify(msg.details)).not.toContain("plainsecretvalue123");
    expect(msg.details.apiKey).toBe("plains…e123");
    expect(msg.details.password).toBe("***");
    expect(msg.details.nested.accessToken[0]).toBe("nested…t123");
  });
});

describe("appendExactAssistantMessageToSessionTranscript - redaction", () => {
  useTempSessionsFixture("exact-assistant-redact-test-");

  beforeEach(() => {
    readLoggingConfig.mockReset();
    readLoggingConfig.mockReturnValue(undefined);
  });

  it("does not redact when config.logging.redactSensitive is off", async () => {
    const sessionId = "test-session-redact-off";
    const sessionKey = "test-channel:test-user";
    writeSessionEntry({ sessionKey, sessionId });

    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const config: OpenClawConfig = { logging: { redactSensitive: "off" } };

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      config,
      message: createAssistantMessage(`Here is your key: ${fakeApiKey}`),
    });

    expect(result.ok).toBe(true);
    expect(readRawTranscript(sessionId)).toContain(fakeApiKey);
  });

  it("emits the redacted assistant message for inline transcript updates", async () => {
    const sessionId = "test-session-redact-event";
    const sessionKey = "test-channel:test-redact-event";
    writeSessionEntry({ sessionKey, sessionId });

    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };
    const updates: Array<{ message?: unknown }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));

    try {
      const result = await appendExactAssistantMessageToSessionTranscript({
        sessionKey,
        config,
        message: createAssistantMessage(`Here is your key: ${fakeApiKey}`),
      });

      expect(result.ok).toBe(true);

      const [storedMessage] = readMessages(sessionId);
      expect(JSON.stringify(storedMessage)).not.toContain(fakeApiKey);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.message).toEqual(storedMessage);
      expect(JSON.stringify(updates[0]?.message)).not.toContain(fakeApiKey);
    } finally {
      unsubscribe();
    }
  });

  it("dedupes delivery mirrors against the redacted persisted text", async () => {
    const sessionId = "test-session-redact-dedupe";
    const sessionKey = "test-channel:test-redact-dedupe";
    writeSessionEntry({ sessionKey, sessionId });

    const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const config: OpenClawConfig = { logging: { redactSensitive: "tools" } };

    const first = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      config,
      text: `Here is your key: ${fakeApiKey}`,
    });
    const second = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      config,
      text: `Here is your key: ${fakeApiKey}`,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(second.messageId).toBe(first.messageId);

    expect(readRawTranscript(sessionId)).not.toContain(fakeApiKey);
    expect(readMessages(sessionId)).toHaveLength(1);
  });

  it("redacts new delivery mirrors after older unredacted assistant entries", async () => {
    const sessionId = "test-session-redact-upgrade-dedupe";
    const sessionKey = "test-channel:test-redact-upgrade-dedupe";
    writeSessionEntry({ sessionKey, sessionId });

    const fakeApiKey = "sk-proj-OLDERUNREDACTEDTRANSCRIPT1234567890";
    const unredacted = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      config: { logging: { redactSensitive: "off" } },
      message: createAssistantMessage(`Here is your key: ${fakeApiKey}`),
    });
    const deduped = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      config: { logging: { redactSensitive: "tools" } },
      text: `Here is your key: ${fakeApiKey}`,
    });

    expect(unredacted.ok).toBe(true);
    expect(deduped.ok).toBe(true);
    if (!unredacted.ok || !deduped.ok) {
      return;
    }
    expect(deduped.messageId).not.toBe(unredacted.messageId);

    const messages = readMessages(sessionId);
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages[0])).toContain(fakeApiKey);
    expect(JSON.stringify(messages[1])).not.toContain(fakeApiKey);
  });
});
