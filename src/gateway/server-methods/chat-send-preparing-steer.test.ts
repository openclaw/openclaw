import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import type {
  ReplyBackendHandle,
  ReplyBackendMessageInjectionV2,
} from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  createReplyOperation,
  replyRunRegistry,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import {
  listSessionPendingInputs,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatAbortRequest } from "./chat-abort-handler.js";
import { handleChatSend } from "./chat-send-handler.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
const createBrowserFollowupFixture = useBrowserFollowupFixture();
type BrowserFixture = Awaited<ReturnType<typeof createBrowserFollowupFixture>>;
const sourceTurnId = "preparing-source-turn";
const backendRunId = "prepared-backend-run";
const fingerprint = "preparing-steer-tools";

async function createPreparingFixture(options: { preserveContent?: boolean } = {}) {
  const fixture = await createBrowserFollowupFixture(options);
  fixture.activeRun?.complete();
  const operation = createReplyOperation({ ...fixture.scope, resetTriggered: false });
  replyRunRegistry.bindSourceTurnId(operation, sourceTurnId);
  fixture.params.queueMode = "steer";
  return {
    ...fixture,
    operation,
    cleanup: async () => {
      operation.complete();
      await fixture.cleanup();
    },
  };
}

function createBackend(options: { rejected?: boolean; available?: boolean } = {}) {
  const entered = createDeferred();
  const cancel = vi.fn();
  // Keep the transport boundary synthetic; the supplied live-authority guard,
  // input custody, approval, and transcript persistence remain production owners.
  const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
    async (_text, queueOptions, assertCurrent) => {
      assertCurrent();
      entered.resolve();
      if (options.rejected) {
        throw new Error("Runtime refused this steering input");
      }
      if (!queueOptions?.userTurnTranscriptRecorder) {
        throw new Error("The injected input must retain its transcript recorder");
      }
      queueOptions.onQueueAccepted?.(true);
      await queueOptions.userTurnTranscriptRecorder.persistApproved();
    },
  );
  const handle: ReplyBackendHandle = {
    kind: "embedded",
    runId: backendRunId,
    toolAuthorityFingerprint: fingerprint,
    cancel,
    messageInjectionV2: {
      version: 2,
      isAvailable: () => options.available !== false,
      queueMessage,
    },
  };
  return { handle, queueMessage, cancel, entered: entered.promise };
}

function attachBackend(
  operation: ReplyOperation,
  backend: ReturnType<typeof createBackend>,
  incomingFingerprint = fingerprint,
) {
  operation.bindToolAuthoritySnapshot({
    fingerprint: () => fingerprint,
    project: () => incomingFingerprint,
  });
  operation.bindToolAuthorityRoute({ provider: "test-provider", model: "test-model" });
  operation.setPhase("running");
  operation.attachBackend(backend.handle);
}

function admissionReleased(fixture: BrowserFixture) {
  return getSessionWorkAdmissionRelease({
    scope: fixture.scope.storePath,
    identities: [fixture.scope.sessionKey, fixture.scope.sessionId],
  });
}

async function expectFallback(fixture: BrowserFixture) {
  await fixture.dispatchedRecorder;
  expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
  const dispatch = dispatchInboundMessageMock.mock.calls[0]?.[0] as
    | Parameters<typeof dispatchInboundMessage>[0]
    | undefined;
  expect(dispatch?.replyOptions?.messageInjectionDisposition).toBe("rejected");
  expect(listSessionPendingInputs(fixture.scope)).toMatchObject({
    total: 1,
    items: [{ state: "queued", runId: fixture.params.idempotencyKey }],
  });
  expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
}

describe("chat.send steering while its captured reply owner prepares", () => {
  it.each([
    "queued",
    "waiting_for_deferred_maintenance",
    "waiting_for_global_lane",
    "preflight_compacting",
    "memory_flushing",
    "running",
  ] as const)(
    "acknowledges before %s readiness and injects once into that owner",
    async (phase) => {
      const fixture = await createPreparingFixture();
      const backend = createBackend();
      fixture.operation.setPhase(phase);
      try {
        const ack = await fixture.send();
        expect(ack).toHaveBeenCalledOnce();
        expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
        expect(backend.queueMessage).not.toHaveBeenCalled();
        expect(listSessionPendingInputs(fixture.scope)).toMatchObject({
          total: 1,
          items: [{ state: "queued", message: { content: fixture.approvedContent } }],
        });
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
        const released = admissionReleased(fixture);
        attachBackend(fixture.operation, backend);
        // A regressed handler goes to normal dispatch. Race these real boundaries
        // so that failure is immediate instead of hanging behind the held fixture.
        await Promise.race([backend.entered, fixture.dispatchedRecorder]);
        expect(backend.queueMessage).toHaveBeenCalledOnce();
        expect(backend.queueMessage.mock.calls[0]?.[0]).toBe(fixture.approvedContent);
        await released;
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(backend.cancel).not.toHaveBeenCalled();
        expect(fixture.operation.result).toBeNull();
        expect(listSessionPendingInputs(fixture.scope)).toEqual({ total: 0, items: [] });
        const transcript = loadTranscriptEventsSync(fixture.scope);
        expect(transcript).toHaveLength(fixture.activeTranscript.length + 1);
        expect(transcript.at(-1)).toMatchObject({
          message: {
            role: "user",
            content: fixture.approvedContent,
            idempotencyKey: `${fixture.params.idempotencyKey}:user`,
          },
        });
        expect(fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`)).toMatchObject({
          ok: true,
          payload: { status: "ok" },
        });
        const retry = await fixture.send();
        expect(retry.mock.calls[0]?.[1]).toMatchObject({ status: "ok" });
        expect(backend.queueMessage).toHaveBeenCalledOnce();
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(transcript);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("does not lose readiness published synchronously with the started ACK", async () => {
    const fixture = await createPreparingFixture();
    const backend = createBackend();
    const respond = vi.fn<RespondFn>((ok, payload) => {
      expect(ok).toBe(true);
      expect(payload).toMatchObject({ status: "started" });
      expect(backend.queueMessage).not.toHaveBeenCalled();
      attachBackend(fixture.operation, backend);
    });
    try {
      await fixture.send(respond);
      await Promise.race([backend.entered, fixture.dispatchedRecorder]);
      expect(backend.queueMessage).toHaveBeenCalledOnce();
      await admissionReleased(fixture);
      expect(respond).toHaveBeenCalledOnce();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(listSessionPendingInputs(fixture.scope)).toEqual({ total: 0, items: [] });
      expect(loadTranscriptEventsSync(fixture.scope).at(-1)).toMatchObject({
        message: { content: fixture.approvedContent },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("waits for running when the backend attached before admission", async () => {
    const fixture = await createPreparingFixture();
    const backend = createBackend();
    fixture.operation.bindToolAuthoritySnapshot({
      fingerprint: () => fingerprint,
      project: () => fingerprint,
    });
    fixture.operation.bindToolAuthorityRoute({ provider: "test-provider", model: "test-model" });
    fixture.operation.attachBackend(backend.handle);
    try {
      const ack = await fixture.send();
      expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
      expect(backend.queueMessage).not.toHaveBeenCalled();
      fixture.operation.setPhase("running");
      await Promise.race([backend.entered, fixture.dispatchedRecorder]);
      expect(backend.queueMessage).toHaveBeenCalledOnce();
      await admissionReleased(fixture);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("injects a burst in admission order without replaying any input", async () => {
    const fixture = await createPreparingFixture({ preserveContent: true });
    const backend = createBackend();
    const messages = ["First correction", "Second correction", "Third correction"];
    try {
      for (const [index, message] of messages.entries()) {
        const params = { ...fixture.params, message, idempotencyKey: `burst-${index}` };
        const respond = vi.fn<RespondFn>();
        await handleChatSend({
          req: { type: "req", id: params.idempotencyKey, method: "chat.send", params },
          params,
          client: fixture.client,
          context: fixture.context,
          respond,
          isWebchatConnect: () => true,
        });
        expect(respond.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
      }
      expect(backend.queueMessage).not.toHaveBeenCalled();
      const released = admissionReleased(fixture);
      attachBackend(fixture.operation, backend);
      await released;
      expect(backend.queueMessage.mock.calls.map(([text]) => text)).toEqual(messages);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(listSessionPendingInputs(fixture.scope)).toEqual({ total: 0, items: [] });
      expect(
        loadTranscriptEventsSync(fixture.scope).slice(fixture.activeTranscript.length),
      ).toEqual(
        messages.map((content, index) =>
          expect.objectContaining({
            message: expect.objectContaining({ content, idempotencyKey: `burst-${index}:user` }),
          }),
        ),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("revalidates the original native profile after waiting for backend readiness", async () => {
    const fixture = await createPreparingFixture();
    const backend = createBackend();
    const email = "preparing-steer-source@example.test";
    const profile = ensureProfileForEmail(email);
    const target = ensureProfileForEmail("preparing-steer-target@example.test");
    fixture.client.connect.client = {
      id: "openclaw-ios",
      version: "test",
      platform: "ios",
      mode: "ui",
    };
    fixture.client.authenticatedUserProfile = {
      profileId: profile.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    };
    try {
      const ack = await fixture.send(undefined, { expectedProfileId: profile.id });
      expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
      const originalAck = structuredClone(ack.mock.calls);
      const released = admissionReleased(fixture);
      linkEmail(email, target.id);
      attachBackend(fixture.operation, backend);
      await released;
      expect(ack.mock.calls).toEqual(originalAck);
      expect(backend.queueMessage).not.toHaveBeenCalled();
      expect(backend.cancel).not.toHaveBeenCalled();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      // The ACK already accepted this input. Keep its original attribution and
      // report the refused execution; account changes must not erase that history.
      expect(
        loadTranscriptEventsSync(fixture.scope).slice(fixture.activeTranscript.length),
      ).toEqual([
        expect.objectContaining({
          message: expect.objectContaining({
            role: "user",
            content: fixture.approvedContent,
            __openclaw: expect.objectContaining({ senderId: profile.id }),
          }),
        }),
        expect.objectContaining({
          type: "custom_message",
          customType: "run-failed-before-reply",
          details: expect.objectContaining({ runId: fixture.params.idempotencyKey }),
        }),
      ]);
      expect(fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`)).toMatchObject({
        ok: false,
        payload: { status: "error" },
        error: { message: expect.stringContaining("Selected account changed") },
      });
      expect(fixture.context.chatAbortControllers.size).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("withdraws canceled input without waiting for backend attachment", async () => {
    const fixture = await createPreparingFixture();
    const backend = createBackend();
    try {
      await fixture.send();
      const released = admissionReleased(fixture);
      const params = {
        sessionKey: fixture.scope.sessionKey,
        runId: fixture.params.idempotencyKey,
      };
      const respond = vi.fn<RespondFn>();
      await handleChatAbortRequest({
        params,
        req: { type: "req", id: "abort-preparing-steer", method: "chat.abort", params },
        client: fixture.client,
        context: fixture.context,
        respond,
        isWebchatConnect: () => true,
      });
      expect(respond).toHaveBeenCalledWith(true, {
        ok: true,
        aborted: true,
        runIds: [fixture.params.idempotencyKey],
      });
      await released;
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(listSessionPendingInputs(fixture.scope)).toMatchObject({
        total: 1,
        items: [{ state: "cancelled" }],
      });
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      attachBackend(fixture.operation, backend);
      expect(backend.queueMessage).not.toHaveBeenCalled();
      expect(fixture.operation.result).toBeNull();
      expect(fixture.context.chatAbortControllers.size).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["completed", "rekeyed"] as const)(
    "does not steer a successor when the admitted owner is %s",
    async (change) => {
      const fixture = await createPreparingFixture();
      const originalBackend = createBackend();
      const successorBackend = createBackend();
      let successor: ReplyOperation | undefined;
      try {
        await fixture.send();
        if (change === "completed") {
          fixture.operation.complete();
        } else {
          fixture.operation.updateSessionKey("agent:main:adopted");
        }
        successor = createReplyOperation({ ...fixture.scope, resetTriggered: false });
        attachBackend(successor, successorBackend);
        if (change === "rekeyed") {
          attachBackend(fixture.operation, originalBackend);
        }
        await expectFallback(fixture);
        expect(originalBackend.queueMessage).not.toHaveBeenCalled();
        expect(successorBackend.queueMessage).not.toHaveBeenCalled();
        expect(successorBackend.cancel).not.toHaveBeenCalled();
        expect(successor.result).toBeNull();
      } finally {
        successor?.complete();
        await fixture.cleanup();
      }
    },
  );

  it.each([
    "unavailable",
    "runtime rejection",
    "tool authority mismatch",
    "terminal fence",
  ] as const)(
    "preserves followup custody after readiness with %s without replaying injection",
    async (reason) => {
      const fixture = await createPreparingFixture();
      const backend = createBackend({
        available: reason !== "unavailable",
        rejected: reason === "runtime rejection",
      });
      try {
        await fixture.send();
        if (reason === "terminal fence") {
          await patchSessionEntryCore(fixture.scope, () => ({
            restartRecoveryTerminalRunIds: [sourceTurnId],
          }));
        }
        attachBackend(
          fixture.operation,
          backend,
          reason === "tool authority mismatch" ? "different-tools" : fingerprint,
        );
        await expectFallback(fixture);
        expect(backend.queueMessage).toHaveBeenCalledTimes(reason === "runtime rejection" ? 1 : 0);
        expect(backend.cancel).not.toHaveBeenCalled();
        expect(fixture.operation.result).toBeNull();
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(["followup", "no owner"] as const)(
    "leaves %s dispatch independent of subsequent backend readiness",
    async (mode) => {
      const fixture = await createPreparingFixture();
      const backend = createBackend();
      let successor: ReplyOperation | undefined;
      try {
        if (mode === "followup") {
          fixture.params.queueMode = "followup";
        } else {
          fixture.operation.complete();
        }
        const ack = await fixture.send();
        expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
        await fixture.dispatchedRecorder;
        if (mode === "no owner") {
          successor = createReplyOperation({ ...fixture.scope, resetTriggered: false });
          attachBackend(successor, backend);
        } else {
          attachBackend(fixture.operation, backend);
        }
        await fixture.finishDispatch();
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
        expect(backend.queueMessage).not.toHaveBeenCalled();
      } finally {
        successor?.complete();
        await fixture.cleanup();
      }
    },
  );
});
