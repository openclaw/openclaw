import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  readAmbientTranscriptWatermark,
  resolveAmbientTranscriptWatermarkKey,
  updateAmbientTranscriptWatermark,
} from "./ambient-transcript-watermark.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";

describe("ambient transcript watermark", () => {
  let tempDir: string;
  let storePath: string;
  const sessionKey = "agent:main:telegram:group:-100123";
  const key = resolveAmbientTranscriptWatermarkKey({
    channel: "telegram",
    accountId: "default",
    conversationId: "-100123",
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ambient-watermark-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("stamps and resolves the watermark for the current session id only", async () => {
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: "before-reset", updatedAt: 1_700_000_000_000 },
    );

    await updateAmbientTranscriptWatermark({
      storePath,
      sessionKey,
      key,
      messageId: "11",
      timestampMs: 1_700_000_001_000,
    });

    const persistedEntry = loadSessionEntry({ sessionKey, storePath });
    if (!persistedEntry) {
      throw new Error("Expected persisted session entry");
    }
    expect(persistedEntry?.ambientTranscriptWatermarks?.[key]).toMatchObject({
      sessionId: "before-reset",
      messageId: "11",
      timestampMs: 1_700_000_001_000,
    });
    expect(readAmbientTranscriptWatermark(persistedEntry, key)).toMatchObject({
      sessionId: "before-reset",
      messageId: "11",
    });

    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        ...persistedEntry,
        sessionId: "after-reset",
        updatedAt: 1_700_000_002_000,
      },
    );

    const resetEntry = loadSessionEntry({ sessionKey, storePath });
    expect(readAmbientTranscriptWatermark(resetEntry, key)).toBeUndefined();

    await updateAmbientTranscriptWatermark({
      storePath,
      sessionKey,
      key,
      messageId: "12",
      timestampMs: 1_700_000_002_000,
      expectedSessionId: "before-reset",
    });

    expect(
      readAmbientTranscriptWatermark(loadSessionEntry({ sessionKey, storePath }), key),
    ).toBeUndefined();

    await updateAmbientTranscriptWatermark({
      storePath,
      sessionKey,
      key,
      messageId: "12",
      timestampMs: 1_700_000_002_000,
      expectedSessionId: "after-reset",
    });

    expect(
      readAmbientTranscriptWatermark(loadSessionEntry({ sessionKey, storePath }), key),
    ).toMatchObject({
      sessionId: "after-reset",
      messageId: "12",
    });
  });

  it("ignores legacy watermarks without a session id", () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "current-session",
          updatedAt: 1_700_000_000_000,
          ambientTranscriptWatermarks: {
            [key]: {
              messageId: "11",
              timestampMs: 1_700_000_001_000,
              updatedAt: 1_700_000_002_000,
            },
          },
        },
      }),
      "utf-8",
    );

    expect(
      readAmbientTranscriptWatermark(loadSessionEntry({ sessionKey, storePath }), key),
    ).toBeUndefined();
  });

  it("orders only canonical decimal message ids numerically within a timestamp", async () => {
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: "current-session", updatedAt: 1_700_000_000_000 },
    );

    const updateMessageId = async (messageId: string) => {
      await updateAmbientTranscriptWatermark({
        storePath,
        sessionKey,
        key,
        messageId,
        timestampMs: 1_700_000_001_000,
      });
      return loadSessionEntry({ sessionKey, storePath })?.ambientTranscriptWatermarks?.[key]
        ?.messageId;
    };

    await expect(updateMessageId("0x12")).resolves.toBe("0x12");
    await expect(updateMessageId("17")).resolves.toBe("17");
    await expect(updateMessageId("16")).resolves.toBe("17");
    await expect(updateMessageId("18")).resolves.toBe("18");
    await expect(updateMessageId("1e3")).resolves.toBe("1e3");
    await expect(updateMessageId("999")).resolves.toBe("999");
  });
});
