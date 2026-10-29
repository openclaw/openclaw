import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { executeAgentTurn } from "../../auto-reply/reply/agent-runner-execution.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import * as skillSelection from "../../skills/library/selection.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  dispatchInboundMessageMock,
  gatewayReplyMock,
  installGatewayTestHooks,
} from "../test-helpers.js";
import { successfulChatTurn } from "./chat-send-authority.test-support.js";
import { handleTrustedInternalChatSend } from "./chat-send-handler.js";
import {
  setClientProfile,
  useBrowserFollowupFixture,
} from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

const runtime = vi.hoisted(() => ({ execute: vi.fn<typeof executeAgentTurn>() }));

vi.mock("../../auto-reply/reply/agent-runner-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/reply/agent-runner-execution.js")>()),
  executeAgentTurn: runtime.execute,
}));

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();

it.for([false, true])(
  "settles internal run registration before ACK and dispatch (revoked: %s)",
  async (revoked, { signal }) => {
    const fixture = await createFixture({ active: false });
    const registrationEntered = createDeferred();
    const releaseRegistration = createDeferred();
    const respond = vi.fn<RespondFn>();
    const release = vi.fn();
    let current = true;
    const sending = fixture.send(respond, undefined, fixture.params, (request) =>
      handleTrustedInternalChatSend(
        {
          ...request,
          sessionMutationCommitGuard: () => {
            if (!current) {
              throw new Error("Talk requester was revoked during registration");
            }
          },
        },
        undefined,
        {
          beforeDispatch: async ({ runId }) => {
            expect(runId).toBe(fixture.params.idempotencyKey);
            registrationEntered.resolve();
            await releaseRegistration.promise;
            return release;
          },
        },
      ),
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          registrationEntered.promise,
          sending,
          "chat.send returned before awaiting run registration",
        ),
        signal,
      );
      expect(respond).not.toHaveBeenCalled();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      current = !revoked;
      releaseRegistration.resolve();
      await sending;
      if (revoked) {
        expect(respond).toHaveBeenCalledWith(
          false,
          expect.objectContaining({ status: "error" }),
          expect.objectContaining({ message: expect.stringContaining("requester was revoked") }),
          expect.anything(),
        );
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
      } else {
        expect(respond.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
        await withinTest(fixture.dispatchedRecorder, signal);
        expect(release).not.toHaveBeenCalled();
      }
    } finally {
      releaseRegistration.resolve();
      await sending;
      await fixture.cleanup();
    }
  },
);

it("dispatches acknowledged inputs in order through stalled skill preparation and retry", async ({
  signal,
}) => {
  const fixture = await createFixture({ active: false });
  const { scope, params } = fixture;
  params.idempotencyKey = "ordered-first";
  const profile = ensureProfileForEmail("ordered-preparation@example.test");
  onTestFinished((await prepareUserProfileCatalog()).release);
  setClientProfile(fixture.client, profile, "Ordering fixture");
  // Keep reply preparation and queue policy real; observe execution after their admission.
  dispatchInboundMessageMock.mockReset();
  const actualReply = await vi.importActual<typeof import("../../auto-reply/reply/get-reply.js")>(
    "../../auto-reply/reply/get-reply.js",
  );
  const executionOrder: string[] = [];
  let retried = false;
  gatewayReplyMock.mockImplementation(async (ctx, options, configOverride) => {
    if (ctx.MessageSid === params.idempotencyKey && !retried) {
      retried = true;
      throw new SessionTranscriptProjectionUnavailableError(scope.sessionId);
    }
    return await actualReply.getReplyFromConfig(ctx, options, configOverride);
  });
  runtime.execute.mockImplementation(async ({ followupRun, opts }) => {
    const runId = expectDefined(opts?.runId, "executing input");
    executionOrder.push(runId);
    await expectDefined(
      followupRun.userTurnTranscriptRecorder,
      "input transcript",
    ).persistApproved();
    opts?.onAgentRunStart?.(runId);
    return successfulChatTurn(runId, `Reply to ${runId}`);
  });
  const firstPreparationEntered = createDeferred();
  const releaseFirstPreparation = createDeferred();
  const seed = skillSelection.prepareSkillLibrarySession;
  const seedSpy = vi
    .spyOn(skillSelection, "prepareSkillLibrarySession")
    .mockImplementationOnce(async (...args) => {
      firstPreparationEntered.resolve();
      await releaseFirstPreparation.promise;
      return seed(...args);
    });
  const firstResponse = vi.fn<RespondFn>();
  const secondResponse = vi.fn<RespondFn>();
  const firstSending = fixture.send(firstResponse);
  let secondSending: ReturnType<typeof fixture.send> | undefined;
  const secondParams = {
    ...params,
    idempotencyKey: "ordered-second",
    message: "Run this only after the first message.",
  };
  try {
    await withinTest(firstPreparationEntered.promise, signal);
    expect(firstResponse.mock.calls[0]?.[1]).toMatchObject({
      runId: params.idempotencyKey,
      status: "started",
      messageSeq: 2,
    });
    secondSending = fixture.send(secondResponse, undefined, secondParams);
    await withinTest(secondSending, signal);
    expect(secondResponse.mock.calls[0]?.[1]).toMatchObject({
      runId: secondParams.idempotencyKey,
      status: "started",
    });
    expect(gatewayReplyMock).not.toHaveBeenCalled();
    expect(runtime.execute).not.toHaveBeenCalled();

    releaseFirstPreparation.resolve();
    await Promise.all([firstSending, secondSending]);
    await withinTest(fixture.finishDispatch(), signal);
    // A successor may prepare its queue entry during retry, but execution remains FIFO.
    expect(retried).toBe(true);
    expect(executionOrder).toEqual([params.idempotencyKey, secondParams.idempotencyKey]);
    expect(firstResponse).toHaveBeenCalledOnce();
    expect(secondResponse).toHaveBeenCalledOnce();
    expect(
      fixture
        .readTranscript()
        .map((entry) => asOptionalRecord(asOptionalRecord(entry)?.message))
        .filter((message) => message?.role === "user")
        .map((message) => message?.content),
    ).toEqual(["Keep working on the current task.", params.message, secondParams.message]);
  } finally {
    releaseFirstPreparation.resolve();
    await Promise.allSettled([firstSending, secondSending]);
    await fixture.cleanup();
    seedSpy.mockRestore();
    runtime.execute.mockReset();
  }
});
