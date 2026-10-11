import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import * as skillSelection from "../../skills/library/selection.js";
import * as skillService from "../../skills/library/service.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();

it("acknowledges durable chat input while unrelated history cannot dispatch", async ({
  signal,
}) => {
  const fixture = await createFixture({ active: false });
  const profile = ensureProfileForEmail("history-independent-ack@example.test");
  fixture.client.authenticatedUserProfile = {
    profileId: profile.id,
    displayName: "History contention fixture",
    hasAvatar: false,
    updatedAt: profile.updatedAt,
  };
  const releaseHistory = createDeferred();
  const acknowledged = createDeferred();
  const runHistory = historyLane.pool.run.bind(historyLane.pool);
  const blockedHistory = vi.spyOn(historyLane.pool, "run").mockImplementation(async (...args) => {
    await releaseHistory.promise;
    return runHistory(...args);
  });
  const respond = vi.fn<RespondFn>(() => acknowledged.resolve());
  const sending = fixture.send(respond, {});
  try {
    await withinTest(acknowledged.promise, signal);
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      expect.objectContaining({
        runId: fixture.params.idempotencyKey,
        status: "started",
        messageSeq: 2,
      }),
      undefined,
      expect.anything(),
    );
    const transcript = loadTranscriptEventsSync(fixture.scope);
    expect(transcript).toHaveLength(fixture.activeTranscript.length + 1);
    expect(transcript.at(-1)).toMatchObject({
      message: {
        role: "user",
        content: fixture.params.message,
        idempotencyKey: `${fixture.params.idempotencyKey}:user`,
      },
    });
  } finally {
    releaseHistory.resolve();
    blockedHistory.mockRestore();
    await sending;
    await fixture.cleanup();
  }
});

it.for([
  { preparation: "selection", outcome: "dispatch" },
  { preparation: "authoring", outcome: "dispatch" },
  { preparation: "authoring", outcome: "failure" },
  { preparation: "authoring", outcome: "cancel" },
] as const)(
  "acknowledges durable input before skill $preparation preparation ($outcome)",
  async ({ preparation, outcome }, { signal }) => {
    const fixture = await createFixture({ active: false });
    const profile = ensureProfileForEmail("preparation-ack@example.test");
    fixture.client.authenticatedUserProfile = {
      profileId: profile.id,
      displayName: "Preparation fixture",
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    };
    const entered = createDeferred();
    const release = createDeferred();
    const waitForPreparation = async () => {
      entered.resolve();
      await release.promise;
      if (outcome === "failure") {
        throw new Error("Skill authoring preparation failed");
      }
    };
    const seed = skillSelection.seedSkillLibrarySelection;
    const presentation = skillService.resolveSkillLibraryPresentation;
    const preparationSpy =
      preparation === "selection"
        ? vi
            .spyOn(skillSelection, "seedSkillLibrarySelection")
            .mockImplementation(async (...args) => {
              await waitForPreparation();
              return seed(...args);
            })
        : vi
            .spyOn(skillService, "resolveSkillLibraryPresentation")
            .mockImplementation(async (...args) => {
              await waitForPreparation();
              return presentation(...args);
            });
    const observer = new DatabaseSync(
      resolveSqliteTargetFromSessionStorePath(fixture.scope.storePath, { agentId: "main" }).path,
      { readOnly: true },
    );
    const readClaim = observer.prepare(
      `SELECT current_session_id AS sessionId, status,
        json_extract(entry_json, '$.lifecycleRunId') AS lifecycleRunId,
        json_extract(entry_json, '$.restartRecoveryDeliveryRunId') AS runId,
        json_extract(entry_json, '$.restartRecoveryDeliverySourceRunId') AS sourceRunId
       FROM session_nodes WHERE session_key = ?`,
    );
    const readUserTurn = observer.prepare(
      `SELECT json_extract(event_json, '$.message.content') AS content,
        json_extract(event_json, '$.message.idempotencyKey') AS idempotencyKey
       FROM transcript_events WHERE session_id = ?
       AND json_extract(event_json, '$.type') = 'message'
       AND json_extract(event_json, '$.message.role') = 'user'
       AND json_extract(event_json, '$.message.idempotencyKey') = ?`,
    );
    let acknowledged: { claim: unknown; userTurns: unknown[] } | undefined;
    const respond = vi.fn<RespondFn>(() => {
      // Observe committed state at ACK emission, before any response-delivery await.
      acknowledged = {
        claim: readClaim.get(fixture.scope.sessionKey),
        userTurns: readUserTurn.all(
          fixture.scope.sessionId,
          `${fixture.params.idempotencyKey}:user`,
        ),
      };
    });
    const sending = fixture.send(respond);
    try {
      await withinTest(entered.promise, signal);
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        expect.objectContaining({
          runId: fixture.params.idempotencyKey,
          status: "started",
          messageSeq: 2,
        }),
        undefined,
        expect.anything(),
      );
      expect(acknowledged).toEqual({
        claim: {
          sessionId: fixture.scope.sessionId,
          // #165733: admission clears the prior outcome; the run registry owns liveness.
          status: null,
          lifecycleRunId: fixture.params.idempotencyKey,
          runId: fixture.params.idempotencyKey,
          sourceRunId: fixture.params.idempotencyKey,
        },
        userTurns: [
          {
            content: fixture.params.message,
            idempotencyKey: `${fixture.params.idempotencyKey}:user`,
          },
        ],
      });
      const admittedTranscript = loadTranscriptEventsSync(fixture.scope);
      expect(admittedTranscript).toHaveLength(fixture.activeTranscript.length + 1);
      expect(admittedTranscript.at(-1)).toMatchObject({
        message: {
          role: "user",
          content: fixture.params.message,
          idempotencyKey: `${fixture.params.idempotencyKey}:user`,
        },
      });
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

      if (outcome === "cancel") {
        const params = {
          sessionKey: fixture.scope.sessionKey,
          runId: fixture.params.idempotencyKey,
        };
        const abortResponse = vi.fn<RespondFn>();
        await handleChatAbortRequest({
          params,
          req: { type: "req", id: "cancel-preparation", method: "chat.abort", params },
          client: fixture.client,
          context: fixture.context,
          respond: abortResponse,
          isWebchatConnect: () => true,
        });
        expect(abortResponse).toHaveBeenCalledWith(true, {
          ok: true,
          aborted: true,
          runIds: [fixture.params.idempotencyKey],
        });
      }

      release.resolve();
      await sending;
      if (outcome === "dispatch") {
        await withinTest(fixture.dispatchedRecorder, signal);
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
        const dispatch = dispatchInboundMessageMock.mock.calls[0]?.[0] as Parameters<
          typeof dispatchInboundMessage
        >[0];
        expect(dispatch.ctx).toMatchObject({
          Body: fixture.params.message,
          MessageSid: fixture.params.idempotencyKey,
        });
        expect(dispatch.replyOptions?.skillLibraryAuthoring).toMatchObject({ target: "personal" });
      }
      await fixture.finishDispatch();
      expect(respond).toHaveBeenCalledOnce();
      expect(loadTranscriptEventsSync(fixture.scope).slice(0, admittedTranscript.length)).toEqual(
        admittedTranscript,
      );
      if (outcome !== "dispatch") {
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      }
      if (outcome === "failure") {
        expect(fixture.context.broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({
            runId: fixture.params.idempotencyKey,
            state: "error",
            errorMessage: expect.stringContaining("Skill authoring preparation failed"),
          }),
          expect.anything(),
        );
      }
    } finally {
      release.resolve();
      try {
        await sending;
      } finally {
        observer.close();
        preparationSpy.mockRestore();
        await fixture.cleanup();
      }
    }
  },
);
