import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendTranscriptEvent,
  persistSessionTranscriptTurn,
  readActiveTranscriptEntryAnchor,
} from "./session-accessor.js";
import {
  everySessionTranscriptUserInputFrom,
  readSessionTranscriptMessageEvents,
} from "./session-accessor.sqlite-active-events.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
describe("SQLite admitted input reset fence", () => {
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };
  beforeEach(() => {
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-admission-fence-") },
      sessionId: "admission-fence-test",
      sessionKey: "agent:main:admission-fence-test",
    };
  });
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it.each([false, true])(
    "rejects a completion source reset before admission (retained=%s)",
    async (retained) => {
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("source", null, {
            role: "user",
            content: "completed child",
            idempotencyKey: "source:user",
          }),
        ],
        touchSessionEntry: false,
      });
      expect(everySessionTranscriptUserInputFrom(scope, "source:user", () => true)).toBe(true);
      await appendTranscriptEvent(scope, {
        type: "reset",
        id: "before-admission-reset",
        parentId: "source",
        timestamp: "2026-09-14T00:00:00.000Z",
        reason: "new",
        ...(retained ? { firstKeptEntryId: "source" } : {}),
      });
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("admitted", "before-admission-reset", {
            role: "user",
            content: "admitted",
            idempotencyKey: "admitted:user",
          }),
        ],
        touchSessionEntry: false,
      });
      expect(
        readSessionTranscriptMessageEvents(scope).some(
          ({ event }) =>
            typeof event === "object" && event !== null && "id" in event && event.id === "source",
        ),
      ).toBe(retained);
      const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "admitted" });
      if (!anchor) {
        throw new Error("missing real admission anchor");
      }
      const accept = () => everySessionTranscriptUserInputFrom(scope, "source:user", () => true);
      expect(accept()).toBe(false);
      expect(
        runWithSessionTranscriptReadFence(
          { ...anchor, logicalTurnId: "recovery", role: "user" },
          accept,
        ),
      ).toBe(false);
    },
  );

  it.each([false, true])(
    "keeps pre-fence control facts through a later reset (human=%s)",
    async (human) => {
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("source", null, {
            role: "user",
            content: "result",
            idempotencyKey: "source:user",
          }),
          ...(human
            ? [
                transcriptMessage("human", "source", {
                  role: "user",
                  content: "new work",
                  idempotencyKey: "human:user",
                }),
              ]
            : []),
          transcriptMessage("admitted", human ? "human" : "source", {
            role: "user",
            content: "admitted",
            idempotencyKey: "admitted:user",
          }),
        ],
        touchSessionEntry: false,
      });
      const anchor = readActiveTranscriptEntryAnchor({ ...scope, entryId: "admitted" });
      if (!anchor) {
        throw new Error("missing real admission anchor");
      }
      await appendTranscriptEvent(scope, {
        type: "reset",
        id: "later-reset",
        parentId: "admitted",
        timestamp: "2026-09-14T00:00:00.000Z",
        reason: "new",
      });
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("after-reset", "later-reset", { role: "user", content: "fresh" }),
        ],
        touchSessionEntry: false,
      });
      expect(everySessionTranscriptUserInputFrom(scope, "source:user", () => true)).toBe(false);
      const seen: unknown[] = [];
      const result = runWithSessionTranscriptReadFence(
        { ...anchor, logicalTurnId: "fenced", role: "user" },
        () =>
          everySessionTranscriptUserInputFrom(scope, "source:user", (message) => {
            seen.push(message);
            return (message as { idempotencyKey?: string }).idempotencyKey !== "human:user";
          }),
      );
      expect(result).toBe(!human);
      expect(
        seen.map((message) => (message as { idempotencyKey?: string }).idempotencyKey),
      ).toEqual(human ? ["source:user", "human:user"] : ["source:user"]);
    },
  );
});
