// Persistence and replay must agree on redaction provenance (#142821).
//
// This file runs the real persist-side transcript redaction and then the real replay
// projection, so both sides are proven against each other instead of against fixtures.
// Persist wraps every mask it produces; replay rewrites exactly those wrapped spans and
// leaves unmarked bytes alone.
import {
  REDACTION_PROVENANCE_END,
  REDACTION_PROVENANCE_START,
  hasRedactionProvenance,
} from "@openclaw/normalization-core/redaction-provenance";
import { buildSessionContext, type SessionTreeEntry } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { serializeRedactionMarker } from "../logging/redaction-provenance.test-support.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

const readLoggingConfig = vi.hoisted(() => vi.fn());

vi.mock("../logging/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/config.js")>();
  return { ...actual, readLoggingConfig };
});

const config = { logging: {} } satisfies OpenClawConfig;
const LONG_SECRET = "plainsecretvalue123";

function toolCallMessage(): ReturnType<typeof castAgentMessage> {
  return castAgentMessage({
    role: "assistant",
    api: "openai-responses",
    provider: "test-provider",
    model: "test-model",
    stopReason: "toolUse",
    timestamp: 0,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [
      {
        type: "toolCall",
        id: "call_1",
        name: "shell",
        arguments: {
          apiKey: LONG_SECRET,
          password: "hunter2",
          command: "OPENAI_API_KEY=sk-abc...0xyz openclaw health",
        },
      },
    ],
  });
}

function replayEntry(entryMessage: unknown): SessionTreeEntry {
  return {
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "2026-09-02T00:00:00.000Z",
    message: entryMessage,
  } as unknown as SessionTreeEntry;
}

function replay(entryMessage: unknown): string {
  return JSON.stringify(buildSessionContext([replayEntry(entryMessage)]).messages);
}

/** Replayed message content as bytes, not as JSON escapes. */
function replayedContent(entryMessage: unknown): string {
  const messages = buildSessionContext([replayEntry(entryMessage)]).messages as Array<{
    content?: unknown;
  }>;
  return String(messages[0]?.content);
}

describe("transcript persistence writes redaction provenance (#142821)", () => {
  it("marks every mask it stores and keeps the secret out of the transcript", () => {
    readLoggingConfig.mockReturnValue({});
    const stored = JSON.stringify(redactTranscriptMessage(toolCallMessage(), config));
    // Serialized transcripts are JSON, so the marker's escape byte is escaped there.
    expect(stored).toContain(serializeRedactionMarker(REDACTION_PROVENANCE_START));
    expect(stored).not.toContain(LONG_SECRET);
    expect(stored).not.toContain("hunter2");
  });

  it("does not mark a message it did not change", () => {
    readLoggingConfig.mockReturnValue({});
    const benign = castAgentMessage({
      role: "user",
      content: "the file is here…world of pain",
      timestamp: 0,
    });
    const stored = redactTranscriptMessage(benign, config);
    expect(stored).toBe(benign);
    expect(hasRedactionProvenance(JSON.stringify(stored))).toBe(false);
  });

  it("leaves an already marked mask intact when redaction runs twice", () => {
    readLoggingConfig.mockReturnValue({});
    const once = redactTranscriptMessage(toolCallMessage(), config);
    const twice = redactTranscriptMessage(once, config);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});

describe("replay consumes that provenance (#142821)", () => {
  it("swaps persisted masks for a re-derive placeholder and keeps surrounding text", () => {
    readLoggingConfig.mockReturnValue({});
    const stored = redactTranscriptMessage(toolCallMessage(), config);
    const replayed = replay(stored);
    expect(replayed).toContain("re-derive");
    expect(replayed).not.toContain(REDACTION_PROVENANCE_START);
    expect(replayed).not.toContain(LONG_SECRET);
    // The assignment prefix around the embedded mask survives.
    expect(replayed).toContain("OPENAI_API_KEY=");
    expect(replayed).toContain("openclaw health");
  });

  it("leaves literal history alone even when it looks exactly like a mask", () => {
    readLoggingConfig.mockReturnValue({});
    const legacy = castAgentMessage({
      role: "assistant",
      api: "openai-responses",
      provider: "test-provider",
      model: "test-model",
      stopReason: "toolUse",
      timestamp: 0,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "shell",
          arguments: { command: "value=sk-bug…9f3a", note: "***", rule: "***\n---" },
        },
      ],
    });
    const replayed = replay(legacy);
    expect(replayed).toContain("value=sk-bug…9f3a");
    expect(replayed).toContain('"***"');
    expect(replayed).not.toContain("re-derive");
  });

  it("round-trips literal delimiter history that only looks like provenance", () => {
    readLoggingConfig.mockReturnValue({});
    const literal = "⟦openclaw:redacted⟧example⟦/openclaw:redacted⟧";
    const content = `the doc quotes ${literal} verbatim`;
    const stored = redactTranscriptMessage(
      castAgentMessage({ role: "user", content, timestamp: 0 }),
      config,
    ) as unknown as { content: string };
    // History that carries no mark stays byte-identical in the transcript.
    expect(stored.content).toBe(content);
    expect(replayedContent(stored)).toBe(content);
  });

  it("escapes literal text that spells the current encoding and restores it on replay", () => {
    readLoggingConfig.mockReturnValue({});
    const literal = `${REDACTION_PROVENANCE_START}example${REDACTION_PROVENANCE_END}`;
    const content = `the doc quotes ${literal} verbatim`;
    const stored = redactTranscriptMessage(
      castAgentMessage({ role: "user", content, timestamp: 0 }),
      config,
    ) as unknown as { content: string };
    // Persistence escapes the escape bytes of literal history it did not mark itself.
    expect(stored.content).not.toBe(content);
    expect(stored.content.length).toBe(content.length + 2);
    expect(hasRedactionProvenance(stored.content)).toBe(false);
    expect(replayedContent(stored)).toBe(content);
  });
});
