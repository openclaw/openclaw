import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendInjectedAssistantMessageToTranscript } from "../../gateway/server-methods/chat-transcript-inject.js";
import * as transcriptEvents from "../../sessions/transcript-events.js";
import { resolveSessionTranscriptPathInDir } from "./paths.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
} from "./transcript.js";

type ExactAssistantMessage = Parameters<
  typeof appendExactAssistantMessageToSessionTranscript
>[0]["message"];

function makeAssistantMessage(params: {
  text?: string;
  content?: ExactAssistantMessage["content"];
  provider?: string;
  model?: string;
}): ExactAssistantMessage {
  return {
    role: "assistant",
    content: params.content ?? [{ type: "text", text: params.text ?? "" }],
    api: "openai-responses",
    provider: params.provider ?? "codex",
    model: params.model ?? "gpt-5.4",
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
  };
}

const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
let tempConfigDirs: string[] = [];

afterEach(() => {
  if (originalConfigPath === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
  }
  for (const dir of tempConfigDirs) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  tempConfigDirs = [];
});

function writeRedactConfig(source: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-redact-"));
  tempConfigDirs.push(dir);
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, source);
  process.env.OPENCLAW_CONFIG_PATH = configPath;
}

describe("appendAssistantMessageToSessionTranscript", () => {
  const fixture = useTempSessionsFixture("transcript-test-");
  const sessionId = "test-session-id";
  const sessionKey = "test-session";

  function writeTranscriptStore() {
    fs.writeFileSync(
      fixture.storePath(),
      JSON.stringify({
        [sessionKey]: {
          sessionId,
          chatType: "direct",
          channel: "discord",
        },
      }),
      "utf-8",
    );
  }

  it("creates transcript file and appends message for valid session", async () => {
    writeTranscriptStore();

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fs.existsSync(result.sessionFile)).toBe(true);
      const sessionFileMode = fs.statSync(result.sessionFile).mode & 0o777;
      if (process.platform !== "win32") {
        expect(sessionFileMode).toBe(0o600);
      }

      const lines = fs.readFileSync(result.sessionFile, "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);

      const header = JSON.parse(lines[0]);
      expect(header.type).toBe("session");
      expect(header.id).toBe(sessionId);

      const messageLine = JSON.parse(lines[1]);
      expect(messageLine.type).toBe("message");
      expect(messageLine.message.role).toBe("assistant");
      expect(messageLine.message.content[0].type).toBe("text");
      expect(messageLine.message.content[0].text).toBe("Hello from delivery mirror!");
    }
  });

  it("emits transcript update events for delivery mirrors", async () => {
    const store = {
      [sessionKey]: {
        sessionId,
        chatType: "direct",
        channel: "discord",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      storePath: fixture.storePath(),
    });

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile,
        sessionKey,
        messageId: expect.any(String),
        message: expect.objectContaining({
          role: "assistant",
          provider: "openclaw",
          model: "delivery-mirror",
          content: [{ type: "text", text: "Hello from delivery mirror!" }],
        }),
      }),
    );
    emitSpy.mockRestore();
  });

  it("does not append a duplicate delivery mirror for the same idempotency key", async () => {
    writeTranscriptStore();

    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });
    await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);

    const messageLine = JSON.parse(lines[1]);
    expect(messageLine.message.idempotencyKey).toBe("mirror:test-source-message");
    expect(messageLine.message.content[0].text).toBe("Hello from delivery mirror!");
  });

  it("does not append a duplicate delivery mirror when the latest assistant message already matches", async () => {
    writeTranscriptStore();

    const exactResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: makeAssistantMessage({ text: "Hello from Codex!" }),
    });

    expect(exactResult.ok).toBe(true);

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from Codex!",
      storePath: fixture.storePath(),
    });

    expect(mirrorResult.ok).toBe(true);
    if (exactResult.ok && mirrorResult.ok) {
      expect(mirrorResult.messageId).toBe(exactResult.messageId);
      const lines = fs.readFileSync(mirrorResult.sessionFile, "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);

      const messageLine = JSON.parse(lines[1]);
      expect(messageLine.message.provider).toBe("codex");
      expect(messageLine.message.model).toBe("gpt-5.4");
      expect(messageLine.message.content[0].text).toBe("Hello from Codex!");
    }
  });

  it("does not reuse an older matching assistant message across turns", async () => {
    writeTranscriptStore();

    const olderResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: makeAssistantMessage({ text: "Repeated answer" }),
    });

    const latestResult = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: makeAssistantMessage({ text: "Different latest answer" }),
    });

    const mirrorResult = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Repeated answer",
      storePath: fixture.storePath(),
    });

    expect(olderResult.ok).toBe(true);
    expect(latestResult.ok).toBe(true);
    expect(mirrorResult.ok).toBe(true);
    if (olderResult.ok && latestResult.ok && mirrorResult.ok) {
      expect(mirrorResult.messageId).not.toBe(olderResult.messageId);
      expect(mirrorResult.messageId).not.toBe(latestResult.messageId);

      const lines = fs.readFileSync(mirrorResult.sessionFile, "utf-8").trim().split("\n");
      expect(lines.length).toBe(4);

      const messageLine = JSON.parse(lines[3]);
      expect(messageLine.message.provider).toBe("openclaw");
      expect(messageLine.message.model).toBe("delivery-mirror");
      expect(messageLine.message.content[0].text).toBe("Repeated answer");
    }
  });

  it("finds session entry using normalized (lowercased) key", async () => {
    const storeKey = "agent:main:bluebubbles:direct:+15551234567";
    const store = {
      [storeKey]: {
        sessionId: "test-session-normalized",
        chatType: "direct",
        channel: "bluebubbles",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:BlueBubbles:direct:+15551234567",
      text: "Hello normalized!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
  });

  it("finds Slack session entry using normalized (lowercased) key", async () => {
    const storeKey = "agent:main:slack:direct:u12345abc";
    const store = {
      [storeKey]: {
        sessionId: "test-slack-session",
        chatType: "direct",
        channel: "slack",
      },
    };
    fs.writeFileSync(fixture.storePath(), JSON.stringify(store), "utf-8");

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:slack:direct:U12345ABC",
      text: "Hello Slack user!",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
  });

  it("ignores malformed transcript lines when checking mirror idempotency", async () => {
    writeTranscriptStore();

    const sessionFile = resolveSessionTranscriptPathInDir(sessionId, fixture.sessionsDir());
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        }),
        "{not-json",
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            idempotencyKey: "mirror:test-source-message",
            content: [{ type: "text", text: "Hello from delivery mirror!" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey,
      text: "Hello from delivery mirror!",
      idempotencyKey: "mirror:test-source-message",
      storePath: fixture.storePath(),
    });

    expect(result.ok).toBe(true);
    const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
  });

  it("appends exact assistant transcript messages without rewriting phased content", async () => {
    writeTranscriptStore();

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: makeAssistantMessage({
        content: [
          {
            type: "text",
            text: "internal reasoning",
            textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
          },
          {
            type: "text",
            text: "Done.",
            textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
          },
        ],
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const lines = fs.readFileSync(result.sessionFile, "utf-8").trim().split("\n");
      const messageLine = JSON.parse(lines[1]);
      expect(messageLine.message.content).toEqual([
        {
          type: "text",
          text: "internal reasoning",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ]);
    }
  });

  it("can emit file-only transcript refresh events for exact assistant appends", async () => {
    writeTranscriptStore();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      updateMode: "file-only",
      message: makeAssistantMessage({
        text: "Done.",
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledWith(result.sessionFile);
    }
    emitSpy.mockRestore();
  });

  it("can suppress transcript update events for exact assistant appends", async () => {
    writeTranscriptStore();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      updateMode: "none",
      message: makeAssistantMessage({
        text: "Done.",
        provider: "openclaw",
        model: "delivery-mirror",
      }),
    });

    expect(result.ok).toBe(true);
    expect(emitSpy).not.toHaveBeenCalled();
    emitSpy.mockRestore();
  });
});

describe("transcript message redaction via guardSessionManager", () => {
  const fixture = useTempSessionsFixture("transcript-redact-");
  const sessionId = "redact-session-id";
  const sessionKey = "redact-session";

  function writeStore() {
    fs.writeFileSync(
      fixture.storePath(),
      JSON.stringify({
        [sessionKey]: {
          sessionId,
          chatType: "direct",
          channel: "discord",
        },
      }),
      "utf-8",
    );
  }

  it("writes non-sensitive text content verbatim to JSONL", async () => {
    writeRedactConfig(
      JSON.stringify({
        logging: { redactSensitive: "tools", redactPatterns: [String.raw`sk-[a-zA-Z0-9]+`] },
      }),
    );
    writeStore();

    const plainText = "This is a normal message with no secrets.";
    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: makeAssistantMessage({ text: plainText }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const raw = fs.readFileSync(result.sessionFile, "utf-8");
      expect(raw).toContain(plainText);
    }
  });

  it("applies default redaction when no config is provided (safe fallback)", async () => {
    // With no config passed, guardSessionManager uses undefined opts.config,
    // so redactTranscriptText falls back to default redaction patterns.
    // This is the intended safe fallback: callers without a config context
    // still get redaction applied.
    writeStore();

    const secret = "apiKey=sk-abcdef1234567890xyz";
    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: makeAssistantMessage({ text: `Here is the key: ${secret}` }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const raw = fs.readFileSync(result.sessionFile, "utf-8");
      // Default redaction masks long alphanumeric tokens
      expect(raw).not.toContain("sk-abcdef1234567890xyz");
    }
  });

  it("honours logging.redactSensitive=off when config is passed through", async () => {
    // Regression test: before this fix, config was not threaded through
    // to guardSessionManager, so redactSensitive="off" was silently ignored.
    writeStore();

    const secret = "apiKey=sk-abcdef1234567890xyz";
    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: makeAssistantMessage({ text: `Here is the key: ${secret}` }),
      config: { logging: { redactSensitive: "off" } } as Parameters<
        typeof appendExactAssistantMessageToSessionTranscript
      >[0]["config"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const raw = fs.readFileSync(result.sessionFile, "utf-8");
      // With redactSensitive="off", the secret should appear verbatim
      expect(raw).toContain("sk-abcdef1234567890xyz");
    }
  });

  it("masks Bearer tokens in thinking blocks persisted to JSONL", async () => {
    writeRedactConfig(
      JSON.stringify({
        logging: { redactSensitive: "tools", redactPatterns: [String.raw`Bearer\s+[a-zA-Z0-9_]+`] },
      }),
    );
    writeStore();

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: makeAssistantMessage({
        content: [
          {
            type: "thinking",
            thinking: "I will authenticate using Bearer ghp_abcdefghijklmnopqrst",
            thinkingSignature: "sig-v1",
          },
          { type: "text", text: "Done." },
        ],
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const raw = fs.readFileSync(result.sessionFile, "utf-8");
      expect(raw).not.toContain("ghp_abcdefghijklmnopqrst");
    }
  });

  it("passes through non-text content blocks unchanged", async () => {
    writeRedactConfig(
      JSON.stringify({
        logging: { redactSensitive: "tools", redactPatterns: [String.raw`sk-[a-zA-Z0-9]+`] },
      }),
    );
    writeStore();

    const imageUrl = "https://example.com/image.png";
    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: makeAssistantMessage({
        content: [
          { type: "image_url", image_url: { url: imageUrl } } as any,
          { type: "text", text: "See image above" },
        ],
      }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const raw = fs.readFileSync(result.sessionFile, "utf-8");
      expect(raw).toContain(imageUrl);
    }
  });

  it("preserves idempotency-key dedup after guard wrapping", async () => {
    writeRedactConfig(
      JSON.stringify({
        logging: { redactSensitive: "tools", redactPatterns: [String.raw`sk-[a-zA-Z0-9]+`] },
      }),
    );
    writeStore();

    const r1 = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      idempotencyKey: "dup-test-key",
      message: makeAssistantMessage({ text: "First write sk-abc123" }),
    });
    const r2 = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      idempotencyKey: "dup-test-key",
      message: makeAssistantMessage({ text: "Second write sk-def456" }),
    });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.messageId).toBe(r1.messageId);
      const lines = fs.readFileSync(r2.sessionFile, "utf-8").trim().split("\n");
      // header + exactly one message line
      expect(lines.length).toBe(2);
    }
  });

  it("still emits transcript update event with correct payload after guard wrapping", async () => {
    writeStore();

    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");

    const result = await appendExactAssistantMessageToSessionTranscript({
      sessionKey,
      storePath: fixture.storePath(),
      message: makeAssistantMessage({ text: "Event test message" }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(emitSpy).toHaveBeenCalledTimes(1);
      const lastCallArg = emitSpy.mock.lastCall?.[0];
      const lastCall = typeof lastCallArg === "object" ? lastCallArg : undefined;
      expect(lastCall?.sessionFile).toBe(result.sessionFile);
      expect(lastCall?.sessionKey).toBe(sessionKey);
      expect(lastCall?.messageId).toBe(result.messageId);
      expect(
        (lastCall?.message as { content?: Array<{ type?: string }> } | undefined)?.content?.[0]
          ?.type,
      ).toBe("text");
    }
    emitSpy.mockRestore();
  });
});

describe("gateway-injected transcript path honours redactSensitive config", () => {
  // These tests call appendInjectedAssistantMessageToTranscript directly,
  // which is the gateway path that previously silently ignored redactSensitive="off".
  // No live OpenClaw instance is needed — only a tmp JSONL file is written.
  const gatewayTempDirs: string[] = [];

  afterEach(() => {
    for (const dir of gatewayTempDirs) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
    gatewayTempDirs.length = 0;
  });

  function makeTranscriptPath(): string {
    const dir = path.join(os.tmpdir(), `gw-inject-transcripts-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    gatewayTempDirs.push(dir);
    const p = path.join(dir, "session.jsonl");
    // Write a well-formed session header so SessionManager.open succeeds.
    // Fields must match the pi-coding-agent expected shape: type, version, id, timestamp, cwd.
    fs.writeFileSync(
      p,
      JSON.stringify({
        type: "session",
        version: 1,
        id: "gw-inject-session",
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      }) + "\n",
      "utf-8",
    );
    return p;
  }

  it("honours redactSensitive=off on gateway-injected path (regression)", () => {
    // Regression: before the fix, appendInjectedAssistantMessageToTranscript called
    // guardSessionManager({}) without config, so redactSensitive="off" was silently ignored.
    const transcriptPath = makeTranscriptPath();
    const secret = "sk-abcdef1234567890xyz";

    const result = appendInjectedAssistantMessageToTranscript({
      transcriptPath,
      message: `Here is the key: ${secret}`,
      config: { logging: { redactSensitive: "off" } } as Parameters<
        typeof appendInjectedAssistantMessageToTranscript
      >[0]["config"],
    });

    expect(result.ok).toBe(true);
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    // With redactSensitive="off" the secret must survive verbatim
    expect(raw).toContain(secret);
  });

  it("applies default redaction on gateway-injected path when no config provided", () => {
    const transcriptPath = makeTranscriptPath();
    const secret = "sk-abcdef1234567890xyz";

    const result = appendInjectedAssistantMessageToTranscript({
      transcriptPath,
      message: `Here is the key: ${secret}`,
      // no config — safe fallback: default redaction should kick in
    });

    expect(result.ok).toBe(true);
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    expect(raw).not.toContain(secret);
  });
});
