import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import * as logger from "../logger.js";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  commitBackgroundPayloadsToSession,
  retainDeliveredMediaReferences,
} from "./background-result-payloads.js";

const DESTINATION_KEY = "agent:main:telegram:group:-100123";
const DESTINATION_SESSION_ID = "destination";

describe("background result payload projection", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      for (const dir of tempDirs.dirs) {
        await closeOpenClawAgentDatabasesAsync(dir);
      }
      cleanup();
    }),
  );

  it("retains a named reference, not a false delivery failure, when a confirmed audio send cannot be embedded", async () => {
    const warn = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    try {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const dir = tempDirs.make("openclaw-bg-payload-");
        const storePath = path.join(dir, "agents", "main", "sessions", "sessions.json");
        await replaceSessionEntry(
          { sessionKey: DESTINATION_KEY, storePath },
          { sessionId: DESTINATION_SESSION_ID, updatedAt: 1 },
        );
        const result = await commitBackgroundPayloadsToSession({
          agentId: "main",
          sessionKey: DESTINATION_KEY,
          expectedGeneration: { sessionId: DESTINATION_SESSION_ID, lifecycleRevision: undefined },
          payloads: [{ text: "Voice note", mediaUrls: ["data:audio/ogg;base64,not-valid!"] }],
          idempotencyKey: "confirmed-delivery:0",
          deliveryConfirmed: true,
          config: {
            session: { store: storePath },
            agents: { defaults: { workspace: state.workspaceDir } },
          },
        });
        expect(result).toEqual({ ok: true });
        const entry = loadSessionEntryReadOnly({ sessionKey: DESTINATION_KEY, storePath });
        expect(entry).toBeDefined();
        const messages = (
          await loadTranscriptEvents({
            sessionKey: DESTINATION_KEY,
            sessionId: DESTINATION_SESSION_ID,
            storePath,
          })
        )
          .map(readTranscriptEventMessage)
          .filter(Boolean);
        expect(messages).toHaveLength(1);
        const display = readAssistantDisplayContent(messages[0]);
        // The channel already delivered the payload; an embedding failure must not be
        // recorded as a delivery failure.
        expect(display.some((block) => block.type === "attachment_error")).toBe(false);
        expect(display).toContainEqual({
          type: "attachment",
          attachment: { kind: "audio", label: "Generated audio 1" },
        });
        // The delivered name stays visible in the display text, which the UI renders even
        // though it drops a reference attachment that has no URL.
        const referenceText = display
          .filter((block) => block.type === "text")
          .map((block) => (block as { text?: string }).text ?? "")
          .join("\n");
        expect(referenceText).toContain("Generated audio 1");
        // The embedding warning still carries the underlying reason for operator diagnostics.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid image data URL"));
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the failure card when the payload was not confirmed delivered", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const dir = tempDirs.make("openclaw-bg-payload-");
      const storePath = path.join(dir, "agents", "main", "sessions", "sessions.json");
      await replaceSessionEntry(
        { sessionKey: DESTINATION_KEY, storePath },
        { sessionId: DESTINATION_SESSION_ID, updatedAt: 1 },
      );
      const result = await commitBackgroundPayloadsToSession({
        agentId: "main",
        sessionKey: DESTINATION_KEY,
        expectedGeneration: { sessionId: DESTINATION_SESSION_ID, lifecycleRevision: undefined },
        payloads: [{ text: "Voice note", mediaUrls: ["data:audio/ogg;base64,not-valid!"] }],
        idempotencyKey: "unconfirmed-delivery:0",
        config: {
          session: { store: storePath },
          agents: { defaults: { workspace: state.workspaceDir } },
        },
      });
      expect(result).toEqual({ ok: true });
      const messages = (
        await loadTranscriptEvents({
          sessionKey: DESTINATION_KEY,
          sessionId: DESTINATION_SESSION_ID,
          storePath,
        })
      )
        .map(readTranscriptEventMessage)
        .filter(Boolean);
      expect(messages).toHaveLength(1);
      const display = readAssistantDisplayContent(messages[0]);
      expect(display).toContainEqual({
        type: "attachment_error",
        attachment: { code: "delivery-failed", kind: "audio", label: "Generated audio 1" },
      });
    });
  });

  describe("retainDeliveredMediaReferences", () => {
    it("converts a false delivery-failed block and keeps the name in the display text", () => {
      const retained = retainDeliveredMediaReferences([
        { type: "text", text: "Voice note" },
        {
          type: "attachment_error",
          attachment: { code: "delivery-failed", kind: "audio", label: "Generated audio 1" },
        },
      ]);
      expect(retained).toEqual([
        { type: "text", text: "Voice note\nGenerated audio 1" },
        { type: "attachment", attachment: { kind: "audio", label: "Generated audio 1" } },
      ]);
    });

    it("prepends a text reference when the content has no text block", () => {
      expect(
        retainDeliveredMediaReferences([
          {
            type: "attachment_error",
            attachment: { code: "delivery-failed", kind: "video", label: "clip.mp4" },
          },
        ]),
      ).toEqual([
        { type: "text", text: "clip.mp4" },
        { type: "attachment", attachment: { kind: "video", label: "clip.mp4" } },
      ]);
    });

    it("preserves independently meaningful preparation failures", () => {
      const block = {
        type: "attachment_error" as const,
        attachment: { code: "unsupported-format", kind: "document", label: "script.js" },
      };
      expect(retainDeliveredMediaReferences([block])).toEqual([block]);
    });
  });
});
