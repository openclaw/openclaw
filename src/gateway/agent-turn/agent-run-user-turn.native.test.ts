import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
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

type TurnParams = Parameters<typeof prepareAgentRunUserTurn>[0];
type Recorder = NonNullable<Awaited<ReturnType<typeof prepareAgentRunUserTurn>>["recorder"]>;
function makeTurnParams(
  target: { sessionKey: string; sessionId: string; storePath: string },
  message: string,
  runId: string,
  overrides: Partial<Omit<TurnParams, "request">> & {
    request?: Partial<TurnParams["request"]>;
  } = {},
): TurnParams {
  return {
    assertCurrent: () => {},
    onUserTurnMediaPersisted: () => {},
    cfg: { session: { store: target.storePath } },
    resolvedSessionKey: target.sessionKey,
    admittedSessionId: target.sessionId,
    activeSessionAgentId: "main",
    suppressVisibleSessionEffects: false,
    requestedPromptPersistenceSuppression: false,
    canUseInternalRuntimeHandoff: false,
    message,
    effectiveTranscriptInputText: message,
    images: [],
    offloadedRefs: [],
    runId,
    client: null,
    context: createTrackedDispatch().context,
    ...overrides,
    request: { message, idempotencyKey: runId, ...overrides.request },
  };
}
async function withTurn<T>(params: TurnParams, body: (recorder: Recorder) => Promise<T>) {
  const turn = await prepareAgentRunUserTurn(params);
  try {
    return await body(expectDefined(turn.recorder, "prepared recorder"));
  } finally {
    await releasePreparedAgentRunUserTurn(turn);
  }
}

const fixture = useTempSessionsFixture("user-turn-native-");

it("keeps the committed child target and later owner metadata through input persistence", async () => {
  const sessionKey = "agent:main:subagent:fresh-child";
  const sessionId = "fresh-child-session";
  const sessionEntry = { sessionId, updatedAt: 1, label: "Created child" };
  const target = { agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() };
  await upsertSessionEntryCore(target, sessionEntry);
  await upsertSessionEntryCore(target, { ...sessionEntry, updatedAt: 2, label: "Renamed child" });
  const reroutedTarget = {
    ...target,
    sessionId: "unrelated-session",
    storePath: path.resolve(fixture.sessionsDir(), "../../../rerouted/sessions.json"),
  };
  await upsertSessionEntryCore(reroutedTarget, {
    sessionId: reroutedTarget.sessionId,
    updatedAt: 1,
  });
  const params = makeTurnParams(target, "Child task", "fresh-child-run", {
    cfg: { session: { store: reroutedTarget.storePath } },
    sessionEntry,
    freshChildStorePath: target.storePath,
  });
  await withTurn(params, async (recorder) => {
    expect(recorder.getPendingInputMessage?.()).toMatchObject({ content: "Child task" });
    expect(await loadTranscriptEvents(target)).toEqual([]);
    expect(await recorder.persistApproved()).toMatchObject({ appended: true });
    expect(await recorder.persistApproved()).toMatchObject({ appended: true });
    const messages = (await loadTranscriptEvents(target)).filter(
      (event) => isIndexedSessionEntry(event) && event.type === "message",
    );
    expect(messages).toMatchObject([{ message: { role: "user", content: "Child task" } }]);
    expect(loadSessionEntry(target)).toMatchObject({ sessionId, label: "Renamed child" });
    expect(await loadTranscriptEvents(reroutedTarget)).toEqual([]);
  });
});

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
    const rename = (name: string | null) =>
      setCanonicalUserProfileDisplayName(profile.id, name, profileOptions);
    const { profile: original } = await rename(originalName);
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
    const params = makeTurnParams(target, "Retained private result", runId, {
      privateCompletion: true,
      request: {
        expectedExistingSessionId: sessionId,
        deliver: false,
      },
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "subagent_announce",
        sourceSessionKey: "agent:main:subagent:sender-child",
      },
      client: clientFor(original.displayName),
    });
    const accepted = await withTurn(params, async (recorder) => {
      const input = expectDefined(recorder.getPendingInputMessage?.(), "accepted input");
      expect(input["__openclaw"]).toMatchObject({ senderId: profile.id, senderIsOwner: false });
      if (originalName === null) {
        expect(input["__openclaw"]).not.toHaveProperty("senderName");
      } else {
        expect(input["__openclaw"]).toHaveProperty("senderName", originalName);
      }
      await recorder.completeProcessingAsync!(
        buildAgentRunTerminalOutcome({ status: "error", stopReason: "restart" }),
      );
      return input;
    });
    const { profile: renamed } = await rename("Renamed requester");
    const replayParams = { ...params, client: clientFor(renamed.displayName) };
    await withTurn(replayParams, async (recorder) => {
      expect(recorder.getPendingInputMessage?.()).toEqual(accepted);
    });
    const retained = await pendingInputs.listSessionPendingInputs(target);
    expect(retained.items).toMatchObject([{ state: "interrupted", message: accepted }]);
    const prepareAndRelease = (candidate: TurnParams) => withTurn(candidate, async () => {});
    for (const mismatch of [
      { message: "Changed result", effectiveTranscriptInputText: "Changed result" },
      { client: clientFor(original.displayName, "different-profile") },
    ]) {
      await expect(prepareAndRelease({ ...replayParams, ...mismatch })).rejects.toThrow(
        "conflicts with the accepted input",
      );
    }
    const readSubmitted = pendingInputs.readSessionSubmittedInput;
    let current = true;
    using _ = vi
      .spyOn(pendingInputs, "readSessionSubmittedInput")
      .mockImplementationOnce(async (...args) => {
        const submitted = await readSubmitted(...args);
        current = false;
        return submitted;
      });
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
    expect(await pendingInputs.listSessionPendingInputs(target)).toEqual(retained);
    expect(await loadTranscriptEvents(target)).toEqual([]);
  },
);
