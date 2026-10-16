import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";
import { prepareAgentRunUserTurn, releasePreparedAgentRunUserTurn } from "./agent-run-user-turn.js";

describe("fresh child input custody", () => {
  const fixture = useTempSessionsFixture("fresh-child-input-native-");

  it("keeps the committed child target and later owner metadata through input persistence", async () => {
    const sessionKey = "agent:main:subagent:fresh-child";
    const sessionId = "fresh-child-session";
    const sessionEntry = { sessionId, updatedAt: 1, label: "Created child" };
    const target = { agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() };
    await upsertSessionEntryCore(target, sessionEntry);
    // The owner may publish newer metadata after the creation receipt was captured.
    await upsertSessionEntryCore(target, { ...sessionEntry, updatedAt: 2, label: "Renamed child" });
    const reroutedTarget = {
      ...target,
      sessionId: "unrelated-session",
      storePath: path.resolve(
        fixture.sessionsDir(),
        "../../../rerouted/agents/main/sessions/sessions.json",
      ),
    };
    await upsertSessionEntryCore(reroutedTarget, {
      sessionId: reroutedTarget.sessionId,
      updatedAt: 1,
    });
    const context = createTrackedDispatch().context;
    const turn = await prepareAgentRunUserTurn({
      assertCurrent: () => {},
      onUserTurnMediaPersisted: () => {},
      request: { message: "Child task", idempotencyKey: "fresh-child-run" },
      cfg: { session: { store: reroutedTarget.storePath } },
      sessionEntry,
      freshChildStorePath: target.storePath,
      resolvedSessionKey: sessionKey,
      admittedSessionId: sessionId,
      activeSessionAgentId: "main",
      suppressVisibleSessionEffects: false,
      requestedPromptPersistenceSuppression: false,
      canUseInternalRuntimeHandoff: false,
      message: "Child task",
      effectiveTranscriptInputText: "Child task",
      images: [],
      offloadedRefs: [],
      runId: "fresh-child-run",
      client: null,
      context,
    });
    try {
      expect(turn.recorder?.getPendingInputMessage?.()).toMatchObject({ content: "Child task" });
      expect(await loadTranscriptEvents(target)).toEqual([]);
      expect(await turn.recorder!.persistApproved()).toMatchObject({ appended: true });
      expect(await turn.recorder!.persistApproved()).toMatchObject({ appended: true });
      const messages = (await loadTranscriptEvents(target)).filter(
        (event) => isIndexedSessionEntry(event) && event.type === "message",
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ message: { role: "user", content: "Child task" } });
      expect(loadSessionEntry(target)).toMatchObject({ sessionId, label: "Renamed child" });
      expect(await loadTranscriptEvents(reroutedTarget)).toEqual([]);
    } finally {
      await releasePreparedAgentRunUserTurn(turn);
    }
  });
});
