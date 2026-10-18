import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { executeAgentTurn } from "../../auto-reply/reply/agent-runner-execution.js";
import { readReplySourceInput } from "../../auto-reply/reply/reply-source-binding.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import type { SessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import * as skillSelection from "../../skills/library/selection.js";
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

it.for([false, true])(
  "dispatches acknowledged inputs in order when the first skill preparation stalls (retry: %s)",
  async (retry, { signal }) => {
    const fixture = await createFixture({ active: false });
    const { scope, params } = fixture;
    params.idempotencyKey = `ordered-first-${retry}`;
    const profile = ensureProfileForEmail("ordered-preparation@example.test");
    setClientProfile(fixture.client, profile, "Ordering fixture");
    // Keep reply preparation and queue policy real; observe execution after their admission.
    dispatchInboundMessageMock.mockReset();
    const actualReply = await vi.importActual<typeof import("../../auto-reply/reply/get-reply.js")>(
      "../../auto-reply/reply/get-reply.js",
    );
    const executionOrder: string[] = [];
    let retried = false;
    let firstSource: SessionControllerInput | undefined;
    const firstOwners: ReplyOperation[] = [];
    gatewayReplyMock.mockImplementation(async (ctx, options, configOverride) => {
      if (ctx.MessageSid === params.idempotencyKey) {
        const owner = expectDefined(options?.replyOperation, "admitted first turn");
        const source = expectDefined(readReplySourceInput(options), "original first source");
        expect(source).toBe(firstSource);
        expect(source.claim?.operation).toBe(owner);
        expect(source.retirementRequested).not.toBe(true);
        expect(owner.result).toBeNull();
        firstOwners.push(owner);
      }
      if (retry && !retried && ctx.MessageSid === params.idempotencyKey) {
        retried = true;
        throw new SessionTranscriptProjectionUnavailableError(scope.sessionId);
      }
      return await actualReply.getReplyFromConfig(ctx, options, configOverride);
    });
    runtime.execute.mockImplementation(async ({ followupRun, opts, replyOperation }) => {
      const runId = expectDefined(opts?.runId, "executing input");
      const operation = expectDefined(replyOperation, "admitted execution");
      if (runId === params.idempotencyKey) {
        expect(operation).toBe(firstOwners[0]);
      }
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
    const secondAcknowledged = createDeferred();
    const seed = skillSelection.prepareSkillLibrarySession;
    const seedSpy = vi
      .spyOn(skillSelection, "prepareSkillLibrarySession")
      .mockImplementationOnce(async (...args) => {
        firstPreparationEntered.resolve();
        await releaseFirstPreparation.promise;
        return seed(...args);
      });
    const firstResponse = vi.fn<RespondFn>();
    const secondResponse = vi.fn<RespondFn>((...response) => {
      if (response[0]) {
        secondAcknowledged.resolve();
      }
    });
    const firstSending = fixture.send(firstResponse);
    let secondSending: ReturnType<typeof fixture.send> | undefined;
    const secondParams = {
      ...params,
      idempotencyKey: `ordered-second-${retry}`,
      message: "Run this only after the first message.",
    };
    try {
      await withinTest(firstPreparationEntered.promise, signal);
      firstSource = expectDefined(
        rpcSourceTesting.get(params.idempotencyKey),
        "first admission",
      ).input;
      expect(firstResponse.mock.calls[0]?.[1]).toMatchObject({
        runId: params.idempotencyKey,
        status: "started",
        messageSeq: 2,
      });
      secondSending = fixture.send(secondResponse, undefined, secondParams);
      await withinTest(
        awaitGateBeforeSettlement(
          secondAcknowledged.promise,
          secondSending,
          "Second input was not acknowledged",
        ),
        signal,
      );
      expect(secondResponse.mock.calls[0]?.[1]).toMatchObject({
        runId: secondParams.idempotencyKey,
        status: "started",
      });
      expect(gatewayReplyMock).not.toHaveBeenCalled();
      expect(runtime.execute).not.toHaveBeenCalled();

      releaseFirstPreparation.resolve();
      await Promise.all([firstSending, secondSending]);
      await withinTest(fixture.finishDispatch(), signal);
      expect(gatewayReplyMock).toHaveBeenCalledTimes(retry ? 3 : 2);
      // A successor may prepare its queue entry during retry, but execution remains FIFO.
      expect(executionOrder).toEqual([params.idempotencyKey, secondParams.idempotencyKey]);
      expect(runtime.execute).toHaveBeenCalledTimes(2);
      expect(new Set(firstOwners).size).toBe(1);
      expect(firstOwners).toHaveLength(retry ? 2 : 1);
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
  },
);
