import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readAmbientTranscriptWatermarkFromEntry,
  resolveAmbientTranscriptWatermarkKey,
  updateAmbientTranscriptWatermark,
} from "./ambient-transcript-watermark.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";

describe("ambient transcript watermark", () => {
  const sessionKey = "agent:main:telegram:group:-100123";
  const key = resolveAmbientTranscriptWatermarkKey({
    channel: "telegram",
    accountId: "default",
    conversationId: "-100123",
  });

  it("stamps and resolves the watermark for the current session id only", async () => {
    await withOpenClawTestState({ label: "ambient-watermark" }, async (state) => {
      const storePath = state.statePath("sessions.json");
      const scope = { sessionKey, storePath };
      const stamp = (expectedSessionId?: string) =>
        updateAmbientTranscriptWatermark({
          ...scope,
          key,
          messageId: "12",
          timestampMs: 1_700_000_002_000,
          expectedSessionId,
        });
      const read = () => readAmbientTranscriptWatermarkFromEntry(loadSessionEntry(scope), key);
      await replaceSessionEntry(scope, { sessionId: "before-reset", updatedAt: 1_700_000_000_000 });

      await updateAmbientTranscriptWatermark({
        storePath,
        sessionKey,
        key,
        messageId: "11",
        timestampMs: 1_700_000_001_000,
      });

      const persistedEntry = loadSessionEntry(scope);
      if (!persistedEntry) {
        throw new Error("Expected persisted session entry");
      }
      expect(persistedEntry?.ambientTranscriptWatermarks?.[key]).toMatchObject({
        sessionId: "before-reset",
        messageId: "11",
        timestampMs: 1_700_000_001_000,
      });
      expect(read()).toMatchObject({
        sessionId: "before-reset",
        messageId: "11",
      });

      await replaceSessionEntry(scope, {
        ...persistedEntry,
        sessionId: "after-reset",
        updatedAt: 1_700_000_002_000,
      });

      expect(read()).toBeUndefined();
      await stamp("before-reset");
      expect(read()).toBeUndefined();
      await stamp("after-reset");
      expect(read()).toMatchObject({
        sessionId: "after-reset",
        messageId: "12",
      });
    });
  });

  it("ignores legacy watermarks without a session id", () => {
    const entry = parseSessionEntryJson({
      entry_json: JSON.stringify({
        sessionId: "current-session",
        updatedAt: 1_700_000_000_000,
        ambientTranscriptWatermarks: {
          [key]: {
            messageId: "11",
            timestampMs: 1_700_000_001_000,
            updatedAt: 1_700_000_002_000,
          },
        },
      }),
    });
    expect(entry?.ambientTranscriptWatermarks?.[key]).toMatchObject({ messageId: "11" });
    expect(readAmbientTranscriptWatermarkFromEntry(entry ?? undefined, key)).toBeUndefined();
  });
});
