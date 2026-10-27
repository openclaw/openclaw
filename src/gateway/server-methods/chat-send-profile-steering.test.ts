import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import {
  resolveAgentQuestionGatewayCall,
  type AgentQuestionDispatcher,
} from "../../agents/harness/gateway-question-dispatch.js";
import { createNativeSessionBindingAuthority } from "../../agents/harness/native-session/binding-authority.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { beginRestartRecoveryTerminalDelivery } from "../../config/sessions/restart-recovery-receipt.js";
import {
  listSessionPendingInputs,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as controllerDiagnostics from "../../sessions/session-controller.diagnostics.js";
import {
  beginReplyMessageInjectionTarget,
  bindSessionControllerSourceTurnId,
  captureReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { retireSessionControllerInput } from "../../sessions/session-controller.mailbox-source.js";
import { reserveSessionControllerSource } from "../../sessions/session-controller.mailbox.js";
import { createExpectedProfileBinding } from "../expected-profile.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { bindChatProfile } from "./chat-send-admission-fixtures.test-support.js";
import { bindSteeringTools } from "./chat-send-authority.test-support.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();
type Fixture = Awaited<ReturnType<typeof createFixture>>;
type Operation = NonNullable<Fixture["activeRun"]>;

function activeOperation(fixture: Fixture) {
  const operation = fixture.activeRun;
  if (!operation) {
    throw new Error("Expected the steering fixture to own an active run");
  }
  return operation;
}

function backend(runId: string, toolAuthorityFingerprint: string, cancel = vi.fn()) {
  return { kind: "embedded" as const, runId, toolAuthorityFingerprint, cancel };
}

function expectUntouched(fixture: Fixture, operation: Operation, cancel: ReturnType<typeof vi.fn>) {
  expect(cancel).not.toHaveBeenCalled();
  expect(operation.result).toBeNull();
  expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
}

it.for(["terminal-pending", "matching-tombstone", "unrelated-tombstone"] as const)(
  "rechecks Gateway terminal delivery inside native final preparation: %s",
  async (change, { signal }) => {
    await using fixture = await createFixture();
    fixture.params.queueMode = "steer";
    fixture.params.idempotencyKey = `gateway-native-receipt-${change}`;
    const operation = activeOperation(fixture);
    const sourceTurnId = "native-active-source";
    await upsertSessionEntryCore(fixture.scope, {
      restartRecoveryDeliveryRunId: "native-receipt-owner",
      restartRecoveryDeliverySourceRunId: sourceTurnId,
    });
    const entered = createDeferred();
    const release = createDeferred();
    const finished = createDeferred();
    const fingerprint = "native-receipt-tools";
    let preparingNative = false;
    let held = false;
    bindSteeringTools(operation, fingerprint, {
      projectAsync: async () => {
        if (preparingNative && !held) {
          held = true;
          entered.resolve();
          await withinTest(release.promise, signal);
        }
        return fingerprint;
      },
    });
    bindSessionControllerSourceTurnId(operation, sourceTurnId);
    operation.setPhase("running");
    const native = createNativeSessionBindingAuthority(
      [
        {
          read: fixture.scope,
          sessionId: fixture.scope.sessionId,
          createSupersededError: () => new Error("Native steering session was replaced"),
        },
      ],
      () => operation.abortSignal.throwIfAborted(),
    );
    const enqueued = vi.fn();
    operation.attachBackend({
      ...backend("native-receipt-owner", fingerprint),
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        async queueMessage() {
          throw new Error("Expected prepared native steering");
        },
        async queueMessageAsync(text, options, preparation) {
          preparingNative = true;
          try {
            await native.withPreparedCurrent!(() => {
              enqueued(text);
              options?.onQueueAccepted?.(true);
            }, [preparation]);
          } finally {
            finished.resolve();
          }
        },
      },
    });
    const request = fixture.send();
    const settlement = request.then(
      () => {},
      () => {},
    );
    try {
      const respond = await withinTest(request, signal);
      expect(respond.mock.calls[0]).toMatchObject({ 0: true, 1: { status: "started" } });
      await withinTest(entered.promise, signal);
      expect(enqueued).not.toHaveBeenCalled();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      if (change === "terminal-pending") {
        await expect(
          beginRestartRecoveryTerminalDelivery({
            ...fixture.scope,
            sourceTurnId,
            toolCallId: "native-terminal-delivery",
          }),
        ).resolves.toBe("started");
      } else {
        await upsertSessionEntryCore(fixture.scope, {
          restartRecoveryTerminalRunIds: [
            change === "matching-tombstone" ? sourceTurnId : "prior-source",
          ],
        });
      }
      expect(operation.phase).toBe("running");
      release.resolve();
      await withinTest(finished.promise, signal);
      expect(operation.result).toBeNull();
      if (change === "unrelated-tombstone") {
        expect(enqueued).toHaveBeenCalledExactlyOnceWith(fixture.approvedContent);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      } else {
        expect(enqueued).not.toHaveBeenCalled();
        const recorder = await withinTest(fixture.dispatchedRecorder, signal);
        expect((await recorder.resolveMessage())?.content).toBe(fixture.approvedContent);
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      }
      await fixture.finishDispatch();
    } finally {
      release.resolve();
      await settlement;
    }
  },
);

it.for([
  { change: "same profile", boundary: "native" },
  { change: "profile merge", boundary: "native" },
  { change: "target closed", boundary: "native" },
  { change: "same profile", boundary: "mailbox" },
  { change: "profile merge", boundary: "mailbox" },
] as const)(
  "keeps bound native V2 steering on its captured owner ($change at $boundary)",
  async ({ change, boundary }, { signal }) => {
    await using fixture = await createFixture();
    fixture.params.queueMode = "steer";
    const operation = activeOperation(fixture);
    const { profile, merge } = bindChatProfile(
      fixture.client,
      "native-steering@example.test",
      true,
    );
    const fingerprint = "native-steering-tools";
    bindSteeringTools(operation, fingerprint);
    operation.setPhase("running");
    const entered = createDeferred();
    const release = createDeferred();
    const finished = createDeferred();
    const terminal = createDeferred();
    const nativeEntered = vi.fn();
    const enqueued = vi.fn();
    const cancel = vi.fn();
    const older =
      boundary === "mailbox"
        ? reserveSessionControllerSource(fixture.scope.sessionKey, {
            policy: { mode: "followup" },
            target: captureSessionTarget({
              storeScope: fixture.scope.storePath,
              sessionKey: fixture.scope.sessionKey,
              incarnation: fixture.scope.sessionId,
              agentId: fixture.scope.agentId,
            }),
          })
        : undefined;
    const logPhase = controllerDiagnostics.logSessionControllerPhase;
    const phaseObserver = vi
      .spyOn(controllerDiagnostics, "logSessionControllerPhase")
      .mockImplementation((event) => {
        logPhase(event);
        if (
          older &&
          event.phase === "injection-predecessor" &&
          event.status === "waiting" &&
          event.sourceId === fixture.params.idempotencyKey
        ) {
          entered.resolve();
        }
      });
    vi.mocked(fixture.context.broadcast).mockImplementation((event, payload) => {
      if (
        event === "chat" &&
        isRecord(payload) &&
        payload.runId === fixture.params.idempotencyKey &&
        (payload.state === "final" || payload.state === "error")
      ) {
        terminal.resolve();
      }
    });
    operation.attachBackend({
      ...backend("native-steering-owner", fingerprint, cancel),
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage: async (text, options, assertCurrent) => {
          nativeEntered();
          if (!older) {
            entered.resolve();
          }
          try {
            await withinTest(release.promise, signal);
            assertCurrent();
            enqueued(text);
            options?.onQueueAccepted?.(true);
          } finally {
            finished.resolve();
          }
        },
      },
    });
    const request = fixture.send(undefined, { expectedProfileId: profile.id });
    try {
      const respond = await withinTest(request, signal);
      expect(respond.mock.calls[0]).toMatchObject({ 0: true, 1: { status: "started" } });
      await withinTest(entered.promise, signal);
      if (older) {
        expect(older.mailbox.owner.active).toBe(operation);
        expect(older.injectionOrder.resolved).toBe(false);
        expect(nativeEntered).not.toHaveBeenCalled();
      }
      expect(enqueued).not.toHaveBeenCalled();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      if (change === "profile merge") {
        merge();
      } else if (change === "target closed") {
        operation.complete();
      }
      release.resolve();
      if (older) {
        retireSessionControllerInput(older);
      } else {
        await withinTest(finished.promise, signal);
      }
      await withinTest(terminal.promise, signal);
      if (change === "same profile") {
        expect(nativeEntered).toHaveBeenCalledOnce();
        expect(enqueued).toHaveBeenCalledExactlyOnceWith(fixture.approvedContent);
      } else {
        expect(nativeEntered).toHaveBeenCalledTimes(older ? 0 : 1);
        expect.soft(enqueued).not.toHaveBeenCalled();
        const errorMessage = expect.stringContaining(
          boundary === "mailbox"
            ? "operator source identity changed; start a new request"
            : change === "profile merge"
              ? "Selected account changed"
              : "authority is no longer current",
        );
        const failure = fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`);
        expect.soft(failure).toMatchObject({
          ok: false,
          payload: { runId: fixture.params.idempotencyKey, status: "error" },
        });
        expect.soft(fixture.context.broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({
            runId: fixture.params.idempotencyKey,
            state: "error",
            errorMessage,
          }),
          expect.anything(),
        );
        expect.soft(failure?.error).toMatchObject({
          code: "UNAVAILABLE",
          message: errorMessage,
        });
      }
      expect.soft(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect.soft(cancel).not.toHaveBeenCalled();
      expect.soft(fixture.client).not.toHaveProperty("invalidated", true);
      if (change !== "target closed") {
        expect.soft(operation.result).toBeNull();
      }
      await fixture.finishDispatch();
      expect.soft(respond).toHaveBeenCalledOnce();
      if (change !== "same profile") {
        const transcript = loadTranscriptEventsSync(fixture.scope);
        expect
          .soft(transcript.slice(0, fixture.activeTranscript.length))
          .toEqual(fixture.activeTranscript);
        const appended = transcript.slice(fixture.activeTranscript.length);
        expect.soft(appended).toMatchObject([
          {
            type: "message",
            message: {
              role: "user",
              content: fixture.approvedContent,
              idempotencyKey: `${fixture.params.idempotencyKey}:user`,
              __openclaw: { requesterOrigin: { operatorProfileId: profile.id } },
            },
          },
          {
            type: "custom_message",
            customType: "run-failed-before-reply",
            display: true,
            excludeFromContext: true,
            details: { runId: fixture.params.idempotencyKey, error: expect.any(String) },
          },
        ]);
        expect.soft(appended[0]).not.toHaveProperty("message.__openclaw.steerTargetRunId");
      }
    } finally {
      phaseObserver.mockRestore();
      if (older) {
        retireSessionControllerInput(older);
      }
      release.resolve();
      await request;
    }
  },
);

it.each(["backend", "question dispatcher"] as const)(
  "queues original operator input without an explicit profile binding when the %s is V1",
  async (sink) => {
    await using fixture = await createFixture({ preserveContent: true });
    fixture.params.queueMode = "steer";
    const { profile } = bindChatProfile(fixture.client, "v1-steering@example.test", true);
    const operation = activeOperation(fixture);
    const fingerprint = "v1-steering-tools";
    let originalOperatorAuthority: AdmittedRunOperatorAuthority | undefined;
    bindSteeringTools(operation, fingerprint, {
      project: (incoming) => {
        originalOperatorAuthority = incoming.operatorAuthority;
        return fingerprint;
      },
    });
    operation.setPhase("running");
    const write = vi.fn(async () => undefined);
    const questionCall = resolveAgentQuestionGatewayCall(write);
    const cancel = vi.fn();
    operation.attachBackend({
      ...backend("v1-backing-run", fingerprint, cancel),
      ...(sink === "backend"
        ? {
            messageInjection: {
              isAvailable: () => true,
              queueMessage: async (_text, options) => {
                await write();
                await options?.userTurnTranscriptRecorder?.persistApproved();
              },
            },
          }
        : {
            messageInjectionV2: {
              version: 2,
              isAvailable: () => true,
              queueMessage: async (_text, options, assertCurrent, kind) => {
                await questionCall(
                  "question.resolve",
                  {},
                  {},
                  { dispatchAuthority: { version: 2, kind, assertCurrent } },
                );
                await options?.userTurnTranscriptRecorder?.persistApproved();
              },
            },
          }),
    });
    const respond = await fixture.send(undefined, {});
    expect(operation.result).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]).toMatchObject({ 0: true, 1: { status: "started" } });
    await fixture.dispatchedRecorder;
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    const dispatched = dispatchInboundMessageMock.mock.calls[0]?.[0];
    if (!isRecord(dispatched) || !isRecord(dispatched.replyOptions)) {
      throw new Error("Expected normal followup dispatch after unsupported steering");
    }
    expect(dispatched.replyOptions.messageInjectionDisposition).toBe("rejected");
    const authority = dispatched.replyOptions.operatorAuthority;
    assertAdmittedRunOperatorAuthority(authority);
    expect(authority).toBe(originalOperatorAuthority);
    expect(authority).toMatchObject({
      profileId: profile.id,
      scopes: fixture.client.connect.scopes,
    });
    expect(authority.assertCurrent).not.toThrow();
    expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
      total: 1,
      items: [{ state: "queued", runId: fixture.params.idempotencyKey }],
    });
    expectUntouched(fixture, operation, cancel);
    await fixture.finishDispatch();
    expect(authority.assertCurrent).toThrow("operator execution authority is no longer active");
  },
);

it.each([false, true])(
  "fences deferred custom question cancellation after a profile merge (bound: %s)",
  async (bound) => {
    await using fixture = await createFixture();
    const entered = createDeferred();
    const release = createDeferred();
    let outcome: Promise<unknown> | undefined;
    try {
      const { profile, merge } = bindChatProfile(fixture.client, "deferred-source@example.test");
      const binding = (await createExpectedProfileBinding(profile.id, fixture.client))!;
      const write = vi.fn();
      const questionCall = resolveAgentQuestionGatewayCall({
        version: 2,
        call: async ({ authority }: Parameters<AgentQuestionDispatcher["call"]>[0]) => {
          entered.resolve();
          await release.promise;
          if (authority.kind === "source-bound") {
            authority.assertCurrent();
          }
          write();
          return {};
        },
      });
      const cancelBacking = vi.fn();
      const operation = activeOperation(fixture);
      operation.setPhase("running");
      operation.attachBackend({
        ...backend("deferred-backing-run", "active-tools", cancelBacking),
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          queueMessage: async () => {
            throw new Error("Expected question cancellation, not steering");
          },
          cancelPendingUserInput: async (_resolvedBy, assertCurrent, kind) => {
            await questionCall(
              "question.resolve",
              {},
              {},
              { dispatchAuthority: { version: 2, kind, assertCurrent } },
            );
            return true;
          },
        },
      });
      const target = captureReplyMessageInjectionTarget(operation)!;
      const attempt = await beginReplyMessageInjectionTarget(target, "answer", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: "active-tools",
        pendingInputAuthorityFingerprint: "active-tools",
        images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
        ...(bound ? { assertCurrent: binding.assertCurrent } : {}),
      });
      outcome = attempt.outcome.catch((error: unknown) => error);
      await Promise.race([entered.promise, outcome]);
      expect(write).not.toHaveBeenCalled();
      merge();
      release.resolve();
      const result = await outcome;
      expect(write).toHaveBeenCalledTimes(bound ? 0 : 1);
      if (bound) {
        expect(result).toMatchObject({
          status: "failed",
          error: {
            error: { details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "not_started" } },
          },
        });
      } else {
        expect(result).toMatchObject({ status: "rejected" });
      }
      expectUntouched(fixture, operation, cancelBacking);
    } finally {
      release.resolve();
      await outcome;
    }
  },
);
