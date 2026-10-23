import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
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
import {
  beginReplyMessageInjectionTarget,
  bindSessionControllerSourceTurnId,
  captureReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
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
          await native.withPreparedCurrent!(() => {
            enqueued(text);
            options?.onQueueAccepted?.(true);
          }, [preparation]);
        },
      },
    });
    const request = fixture.send();
    const settlement = request.then(
      () => {},
      () => {},
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          request,
          "Native final preparation was not reached",
        ),
        signal,
      );
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
      const respond = await request;
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
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      await fixture.finishDispatch();
    } finally {
      release.resolve();
      await settlement;
    }
  },
);

it.each(["same profile", "profile merge", "target closed"] as const)(
  "keeps bound native V2 steering on its captured owner after preparation (%s)",
  async (change) => {
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
    const enqueued = vi.fn();
    const cancel = vi.fn();
    operation.attachBackend({
      ...backend("native-steering-owner", fingerprint, cancel),
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage: async (text, options, assertCurrent) => {
          entered.resolve();
          await release.promise;
          assertCurrent();
          enqueued(text);
          options?.onQueueAccepted?.(true);
        },
      },
    });
    const request = fixture.send(undefined, { expectedProfileId: profile.id });
    try {
      await awaitGateBeforeSettlement(entered.promise, request, "Steering preparation not reached");
      expect(enqueued).not.toHaveBeenCalled();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      if (change === "profile merge") {
        merge();
      } else if (change === "target closed") {
        operation.complete();
      }
      release.resolve();
      const respond = await request;
      if (change === "same profile") {
        expect(enqueued).toHaveBeenCalledExactlyOnceWith(fixture.approvedContent);
        expect(respond.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
      } else {
        expect.soft(enqueued).not.toHaveBeenCalled();
        expect.soft(respond.mock.calls[0]?.[0]).toBe(false);
        expect
          .soft(respond.mock.calls[0]?.[1])
          .not.toEqual(expect.objectContaining({ status: "started" }));
        if (change === "profile merge") {
          expect.soft(respond.mock.calls[0]?.[2]).toMatchObject({
            details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
          });
        }
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
        expect.soft(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      }
    } finally {
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
