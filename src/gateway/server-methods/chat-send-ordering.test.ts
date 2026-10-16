import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as replyAdmission from "../../auto-reply/reply/reply-admission-ticket.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import * as skillSelection from "../../skills/library/selection.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  dispatchInboundMessageMock,
  gatewayReplyMock,
  installGatewayTestHooks,
} from "../test-helpers.js";
import { handleTrustedInternalChatSend } from "./chat-send-handler.js";
import {
  setClientProfile,
  useBrowserFollowupFixture,
} from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

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
    // Keep the handler, reply dispatcher, admission FIFO, and transcript stores real.
    dispatchInboundMessageMock.mockReset();
    let retried = false;
    gatewayReplyMock.mockImplementation(async (ctx) => {
      if (retry && !retried && ctx.MessageSid === params.idempotencyKey) {
        retried = true;
        throw new SessionTranscriptProjectionUnavailableError(scope.sessionId);
      }
      return { text: `Reply to ${ctx.MessageSid}` };
    });
    const firstPreparationEntered = createDeferred();
    const releaseFirstPreparation = createDeferred();
    const laterAdmissionEntered = createDeferred();
    const seed = skillSelection.prepareSkillLibrarySession;
    const seedSpy = vi
      .spyOn(skillSelection, "prepareSkillLibrarySession")
      .mockImplementationOnce(async (...args) => {
        firstPreparationEntered.resolve();
        await releaseFirstPreparation.promise;
        return seed(...args);
      });
    const reserve = replyAdmission.reserveReplyAdmissionTicket;
    const tickets = new Set<NonNullable<ReturnType<typeof reserve>>>();
    let firstPreparationHeld = true;
    const reservationSpy = vi
      .spyOn(replyAdmission, "reserveReplyAdmissionTicket")
      .mockImplementation((keys) => {
        const ticket = reserve(keys);
        if (ticket) {
          tickets.add(ticket);
          const wait = ticket.wait.bind(ticket);
          vi.spyOn(ticket, "wait").mockImplementation((abortSignal) => {
            if (firstPreparationHeld) {
              laterAdmissionEntered.resolve();
            }
            return wait(abortSignal);
          });
        }
        return ticket;
      });
    const firstResponse = vi.fn<RespondFn>();
    const secondResponse = vi.fn<RespondFn>();
    const firstSending = fixture.send(firstResponse);
    let secondSending: ReturnType<typeof fixture.send> | undefined;
    const secondParams = {
      ...params,
      idempotencyKey: `ordered-second-${retry}`,
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
      await withinTest(laterAdmissionEntered.promise, signal);
      expect(secondResponse.mock.calls[0]?.[1]).toMatchObject({
        runId: secondParams.idempotencyKey,
        status: "started",
      });
      expect(gatewayReplyMock).not.toHaveBeenCalled();

      firstPreparationHeld = false;
      releaseFirstPreparation.resolve();
      await Promise.all([firstSending, secondSending]);
      await withinTest(fixture.finishDispatch(), signal);
      expect(gatewayReplyMock.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual([
        params.idempotencyKey,
        ...(retry ? [params.idempotencyKey] : []),
        secondParams.idempotencyKey,
      ]);
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
      firstPreparationHeld = false;
      releaseFirstPreparation.resolve();
      for (const ticket of tickets) {
        ticket.release();
      }
      await Promise.allSettled([firstSending, secondSending]);
      await fixture.cleanup();
      seedSpy.mockRestore();
      reservationSpy.mockRestore();
    }
  },
);
