import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
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
    const respond = vi.fn<RespondFn>();
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
      await sending;
      await fixture.cleanup();
      preparationSpy.mockRestore();
    }
  },
);
