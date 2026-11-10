import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { commitBackgroundPayloadsToSession } from "./background-result-payloads.js";

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
    });
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
      const entry = loadSessionEntryReadOnly({ sessionKey: DESTINATION_KEY, storePath });
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
});
