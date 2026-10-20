import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as pendingInputs from "../../config/sessions/session-accessor.pending-inputs.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileDisplayName,
} from "../../state/user-profile-writes.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
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

describe("private completion sender replay", () => {
  const fixture = useTempSessionsFixture("private-input-sender-native-");

  it.each(["Original requester", null])(
    "retains accepted sender presentation after a profile rename (%s)",
    async (originalName) => {
      const sessionKey = "agent:main:private-sender";
      const sessionId = "private-sender-session";
      const runId = "announce:private-sender";
      const target = { agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() };
      await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
      const profileOptions = {
        path: path.resolve(fixture.sessionsDir(), "../../../state/openclaw.sqlite"),
      };
      const profile = await ensureCanonicalUserProfileForEmail(
        "private-sender@example.test",
        profileOptions,
      );
      const { profile: original } = await setCanonicalUserProfileDisplayName(
        profile.id,
        originalName,
        profileOptions,
      );
      const clientFor = (displayName: string | null, profileId = profile.id) =>
        createSyntheticPluginRuntimeClient({
          authenticatedUserProfile: {
            profileId,
            displayName,
            avatarRevision: "0",
            hasAvatar: false,
            updatedAt: original.updatedAt,
          },
        });
      const params = {
        assertCurrent: () => {},
        onUserTurnMediaPersisted: () => {},
        privateCompletion: true,
        request: {
          message: "Retained private result",
          idempotencyKey: runId,
          expectedExistingSessionId: sessionId,
          deliver: false,
        },
        cfg: { session: { store: target.storePath } },
        resolvedSessionKey: sessionKey,
        admittedSessionId: sessionId,
        activeSessionAgentId: "main",
        suppressVisibleSessionEffects: false,
        requestedPromptPersistenceSuppression: false,
        canUseInternalRuntimeHandoff: false,
        message: "Retained private result",
        effectiveTranscriptInputText: "Retained private result",
        inputProvenance: {
          kind: "inter_session",
          sourceTool: "subagent_announce",
          sourceSessionKey: "agent:main:subagent:sender-child",
        },
        images: [],
        offloadedRefs: [],
        runId,
        client: clientFor(original.displayName),
        context: createTrackedDispatch().context,
      } satisfies Parameters<typeof prepareAgentRunUserTurn>[0];
      const first = await prepareAgentRunUserTurn(params);
      const accepted = expectDefined(first.recorder?.getPendingInputMessage?.(), "accepted input");
      try {
        expect(accepted["__openclaw"]).toMatchObject({
          senderId: profile.id,
          senderIsOwner: false,
        });
        if (originalName === null) {
          expect(accepted["__openclaw"]).not.toHaveProperty("senderName");
        } else {
          expect(accepted["__openclaw"]).toHaveProperty("senderName", originalName);
        }
        await first.recorder!.completeProcessingAsync!(
          buildAgentRunTerminalOutcome({ status: "error", stopReason: "restart" }),
        );
      } finally {
        await releasePreparedAgentRunUserTurn(first);
      }
      const { profile: renamed } = await setCanonicalUserProfileDisplayName(
        profile.id,
        "Renamed requester",
        profileOptions,
      );
      const replayParams = { ...params, client: clientFor(renamed.displayName) };
      const replay = await prepareAgentRunUserTurn(replayParams);
      try {
        expect(replay.recorder?.getPendingInputMessage?.()).toEqual(accepted);
      } finally {
        await releasePreparedAgentRunUserTurn(replay);
      }
      const retained = await pendingInputs.listSessionPendingInputs(target);
      expect(retained.items).toMatchObject([{ state: "interrupted", message: accepted }]);
      const prepareAndRelease = async (
        candidate: Parameters<typeof prepareAgentRunUserTurn>[0],
      ) => {
        const turn = await prepareAgentRunUserTurn(candidate);
        await releasePreparedAgentRunUserTurn(turn);
        return turn;
      };
      await expect(
        prepareAndRelease({
          ...replayParams,
          message: "Changed result",
          effectiveTranscriptInputText: "Changed result",
        }),
      ).rejects.toThrow("conflicts with the accepted input");
      await expect(
        prepareAndRelease({
          ...replayParams,
          client: clientFor(original.displayName, "different-profile"),
        }),
      ).rejects.toThrow("conflicts with the accepted input");
      const readSubmitted = pendingInputs.readSessionSubmittedInput;
      let current = true;
      const read = vi
        .spyOn(pendingInputs, "readSessionSubmittedInput")
        .mockImplementationOnce(async (...args) => {
          const submitted = await readSubmitted(...args);
          current = false;
          return submitted;
        });
      try {
        await expect(
          prepareAndRelease({
            ...replayParams,
            assertCurrent: () => {
              if (!current) {
                throw new Error("Private source revoked");
              }
            },
          }),
        ).rejects.toThrow("Private source revoked");
      } finally {
        read.mockRestore();
      }
      expect(await pendingInputs.listSessionPendingInputs(target)).toEqual(retained);
      expect(await loadTranscriptEvents(target)).toEqual([]);
    },
  );
});
