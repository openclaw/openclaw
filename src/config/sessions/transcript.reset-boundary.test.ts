// Session transcript tests cover recent conversation text across a reset boundary.
import { describe, expect, it } from "vitest";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import {
  appendTranscriptEvent,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import {
  readCurrentSessionUserAssistantText,
  readRecentUserAssistantTextForSession,
} from "./transcript.js";
import type { SessionEntry } from "./types.js";

describe("recent conversation text across a session reset", () => {
  const fixture = useTempSessionsFixture("transcript-reset-boundary-");
  const sessionId = "test-session-id";
  const sessionKey = "agent:main:test-session";
  function createFixtureTranscriptScope() {
    return { agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() };
  }

  async function writeTranscriptStore(entry: Partial<SessionEntry> = {}) {
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath: fixture.storePath() },
      normalizeLegacySessionEntryDelivery({
        sessionId,
        chatType: "direct",
        updatedAt: 1,
        ...entry,
      } as SessionEntry),
    );
  }

  // Message timestamps deliberately contradict the reset order: the retained tail is
  // stamped after the boundary and the post-reset turn before it, so a reader that
  // used timestamps as a session-membership proxy would get both cases wrong.
  async function writeResetBoundaryTranscript() {
    await writeTranscriptStore({ sessionStartedAt: 5_000 });
    await persistSessionTranscriptTurn(createFixtureTranscriptScope(), {
      updateMode: "none",
      messages: [
        {
          eventId: "pre-reset-user",
          parentId: null,
          message: { role: "user", content: "pre-reset question", timestamp: 9_000 },
        },
        {
          eventId: "pre-reset-assistant",
          parentId: "pre-reset-user",
          message: { role: "assistant", content: "pre-reset answer", timestamp: 9_100 },
        },
      ],
    });
    await appendTranscriptEvent(createFixtureTranscriptScope(), {
      type: "reset",
      id: "reset-boundary",
      parentId: "pre-reset-assistant",
      timestamp: "2026-08-15T00:00:00.000Z",
      reason: "new",
      firstKeptEntryId: "pre-reset-user",
    });
    await persistSessionTranscriptTurn(createFixtureTranscriptScope(), {
      updateMode: "none",
      messages: [
        {
          eventId: "post-reset-user",
          parentId: "reset-boundary",
          message: { role: "user", content: "post-reset question", timestamp: 1_000 },
        },
      ],
    });
  }

  it("reads only what the reset boundary admitted, ignoring message timestamp order", async () => {
    await writeResetBoundaryTranscript();

    await expect(
      readCurrentSessionUserAssistantText({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
      }),
    ).resolves.toEqual([
      { id: "post-reset-user", role: "user", text: "post-reset question", timestamp: 1_000 },
    ]);
  });

  it("keeps the retained replay tail in the plugin SDK reader, which reads across resets", async () => {
    await writeResetBoundaryTranscript();

    await expect(
      readRecentUserAssistantTextForSession({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
      }),
    ).resolves.toEqual([
      { id: "pre-reset-user", role: "user", text: "pre-reset question", timestamp: 9_000 },
      {
        id: "pre-reset-assistant",
        role: "assistant",
        text: "pre-reset answer",
        timestamp: 9_100,
      },
      { id: "post-reset-user", role: "user", text: "post-reset question", timestamp: 1_000 },
    ]);
  });

  it("leaves same-session history whole when no reset boundary exists", async () => {
    await writeTranscriptStore();
    await persistSessionTranscriptTurn(createFixtureTranscriptScope(), {
      updateMode: "none",
      messages: [
        { message: { role: "user", content: "first", timestamp: 1_000 } },
        { message: { role: "assistant", content: "second", timestamp: 2_000 } },
      ],
    });

    await expect(
      readCurrentSessionUserAssistantText({
        agentId: "main",
        sessionKey,
        storePath: fixture.storePath(),
      }),
    ).resolves.toEqual([
      { id: expect.any(String), role: "user", text: "first", timestamp: 1_000 },
      { id: expect.any(String), role: "assistant", text: "second", timestamp: 2_000 },
    ]);
  });
});
