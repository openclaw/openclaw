import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  resolveAgentQuestionGatewayCall,
  type AgentQuestionDispatcher,
} from "../../agents/harness/gateway-question-dispatch.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  beginReplyMessageInjectionTarget,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { createExpectedProfileBinding } from "../expected-profile.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { admitChatSend } from "./chat-send-admission.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession } from "./chat-send-session.js";
installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

describe("native profile-bound input admission", () => {
  it.each(["reservation", "writer"] as const)(
    "rejects a native account merge at %s without accepting or terminalizing input",
    async (boundary) => {
      const fixture = await createBrowserFollowupFixture();
      const email = "native-source@example.test";
      const source = ensureProfileForEmail(email);
      const target = ensureProfileForEmail("native-target@example.test");
      fixture.client.connect.client = {
        id: "openclaw-ios",
        version: "test",
        platform: "ios",
        mode: "ui",
      };
      fixture.client.authenticatedUserProfile = {
        profileId: source.id,
        displayName: null,
        hasAvatar: false,
        updatedAt: source.updatedAt,
      };
      const before = loadSessionEntry(fixture.scope);
      const release = createDeferred();
      let writer: Promise<void> | undefined;
      let request: ReturnType<typeof fixture.send> | undefined;
      try {
        if (boundary === "reservation") {
          const normalized = normalizeChatSendRequest({
            params: fixture.params,
            client: fixture.client,
          });
          if (!normalized.ok) {
            throw new Error(normalized.error);
          }
          const prepared = prepareChatSendSession({
            request: normalized.value,
            client: fixture.client,
            context: fixture.context,
          });
          if (!prepared.ok) {
            throw new Error("Native session preparation failed");
          }
          const binding = createExpectedProfileBinding(source.id, fixture.client)!;
          binding.markInvoked();
          linkEmail(email, target.id);
          await expect(
            admitChatSend({
              request: normalized.value,
              session: prepared.value,
              client: fixture.client,
              context: fixture.context,
              respond: vi.fn(),
              assertCurrent: binding.assertCurrent,
            }),
          ).rejects.toMatchObject({
            error: {
              details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
            },
          });
          expect(fixture.context.dedupe.size).toBe(0);
        } else {
          const entered = createDeferred();
          writer = runExclusiveSessionStoreWrite(fixture.scope.storePath, async () => {
            entered.resolve();
            await release.promise;
          });
          await entered.promise;
          request = fixture.send(undefined, { expectedProfileId: source.id });
          await vi.waitFor(() =>
            expect(
              fixture.context.dedupe.has(
                `${PENDING_CHAT_SEND_DEDUPE_PREFIX}${fixture.params.idempotencyKey}`,
              ),
            ).toBe(true),
          );
          linkEmail(email, target.id);
          release.resolve();
          await writer;
          const respond = await request;
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
            }),
          );
        }
        expect(loadSessionEntry(fixture.scope)).toEqual(before);
        expect(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
        expect(fixture.context.chatAbortControllers.size).toBe(0);
        expect(fixture.context.chatQueuedTurns.size).toBe(0);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        const cached = fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`);
        expect(cached?.payload).toBeUndefined();
        expect(cached?.error).toBeUndefined();
      } finally {
        release.resolve();
        await writer;
        await request;
        await fixture.cleanup();
      }
    },
  );

  it("terminalizes a native account merge during dispatch transcript approval without rewriting the ACK", async () => {
    const fixture = await createBrowserFollowupFixture({ persistDuringDispatch: true });
    const email = "native-approval@example.test";
    const source = ensureProfileForEmail(email);
    const target = ensureProfileForEmail("native-approval-target@example.test");
    fixture.client.connect.client = {
      id: "openclaw-ios",
      version: "test",
      platform: "ios",
      mode: "ui",
    };
    fixture.client.authenticatedUserProfile = {
      profileId: source.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: source.updatedAt,
    };
    try {
      const ack = await fixture.send(undefined, { expectedProfileId: source.id });
      expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
      expect(fixture.beforeApprove).not.toHaveBeenCalled();
      const recorder = await fixture.dispatchedRecorder;
      const acceptedAck = structuredClone(ack.mock.calls);
      fixture.beforeApprove.mockImplementation(() => linkEmail(email, target.id));
      await fixture.finishDispatch();
      expect(fixture.beforeApprove).toHaveBeenCalledOnce();
      expect.soft(recorder.getAdmissionReceipt()).toBeUndefined();
      expect.soft(ack.mock.calls).toEqual(acceptedAck);
      expect.soft(ack).toHaveBeenCalledOnce();
      expect.soft(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      const transcript = loadTranscriptEventsSync(fixture.scope);
      expect
        .soft(transcript.filter((entry) => isRecord(entry) && entry.type === "message"))
        .toEqual(
          fixture.activeTranscript.filter((entry) => isRecord(entry) && entry.type === "message"),
        );
      expect.soft(transcript).toContainEqual(
        expect.objectContaining({
          type: "custom_message",
          customType: "run-failed-before-reply",
          display: true,
          details: expect.objectContaining({ runId: fixture.params.idempotencyKey }),
        }),
      );
      expect.soft(loadSessionEntry(fixture.scope)).toMatchObject({
        status: "failed",
        lastRunId: fixture.params.idempotencyKey,
      });
      expect
        .soft(fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`))
        .toMatchObject({
          ok: false,
          payload: { runId: fixture.params.idempotencyKey, status: "error" },
          error: { message: expect.stringContaining("Selected account changed") },
        });
      expect.soft(fixture.context.broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({
          runId: fixture.params.idempotencyKey,
          state: "error",
          errorMessage: expect.stringContaining("Selected account changed"),
        }),
        expect.anything(),
      );
      expect.soft(fixture.context.chatAbortControllers.size).toBe(0);
      expect.soft(fixture.context.chatQueuedTurns.size).toBe(0);
      expect.soft(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["request-signal abort", "profile merge"] as const)(
    "preserves accepted native input across %s without adopting the retry socket",
    async (change) => {
      const fixture = await createBrowserFollowupFixture();
      const profile = ensureProfileForEmail("native-accepted@example.test");
      fixture.client.connect.client = {
        id: "openclaw-macos",
        version: "test",
        platform: "darwin",
        mode: "ui",
      };
      fixture.client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: null,
        hasAvatar: false,
        updatedAt: profile.updatedAt,
      };
      const requestAbort = new AbortController();
      try {
        const ack = await fixture.send(undefined, {
          expectedProfileId: profile.id,
          signal: requestAbort.signal,
        });
        expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
        const recorder = await fixture.dispatchedRecorder;
        const committed = await recorder.persistApproved();
        expect(committed).toMatchObject({ appended: true });
        const receipt = recorder.getAdmissionReceipt();
        expect(receipt).toBeDefined();
        const accepted = loadTranscriptEventsSync(fixture.scope);
        expect(accepted).toHaveLength(fixture.activeTranscript.length + 1);
        expect(accepted.at(-1)).toMatchObject({
          message: { content: fixture.approvedContent },
        });
        const owner = fixture.context.chatAbortControllers.get(fixture.params.idempotencyKey);
        expect(owner).toBeDefined();
        const ownerConnId = owner?.ownerConnId;
        const cached = structuredClone(
          fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`),
        );
        if (change === "request-signal abort") {
          requestAbort.abort();
        }
        fixture.client.connId = "native-reconnected";
        if (change === "profile merge") {
          const target = ensureProfileForEmail("native-accepted-target@example.test");
          linkEmail("native-accepted@example.test", target.id);
        }
        const retry = await fixture.send(undefined, { expectedProfileId: profile.id });
        if (change === "profile merge") {
          expect(retry).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "not_started" },
            }),
          );
        } else {
          expect(retry.mock.calls[0]?.[1]).toMatchObject({ status: "in_flight" });
        }
        expect(fixture.context.chatAbortControllers.get(fixture.params.idempotencyKey)).toBe(owner);
        expect(owner?.ownerConnId).toBe(ownerConnId);
        expect(owner?.controller.signal.aborted).toBe(false);
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(accepted);
        expect(recorder.getAdmissionReceipt()).toEqual(receipt);
        expect(fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`)).toEqual(cached);
        expect(await recorder.persistApproved()).toEqual(committed);
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(accepted);
        expect(recorder.getAdmissionReceipt()).toEqual(receipt);
        expect(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(["same profile", "profile merge", "target closed"] as const)(
    "keeps bound native V2 steering on its captured owner after preparation (%s)",
    async (change) => {
      const fixture = await createBrowserFollowupFixture();
      fixture.params.queueMode = "steer";
      const operation = fixture.activeRun;
      if (!operation) {
        throw new Error("Expected the steering fixture to own an active run");
      }
      const email = "native-steering@example.test";
      const profile = ensureProfileForEmail(email);
      const target = ensureProfileForEmail("native-steering-target@example.test");
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
      const fingerprint = "native-steering-tools";
      operation.bindToolAuthoritySnapshot({
        fingerprint: () => fingerprint,
        project: () => fingerprint,
      });
      operation.bindToolAuthorityRoute({ provider: "test-provider", model: "test-model" });
      operation.setPhase("running");
      const entered = createDeferred();
      const release = createDeferred();
      const enqueued = vi.fn();
      const cancel = vi.fn();
      let preparing = false;
      operation.attachBackend({
        kind: "embedded",
        runId: "native-steering-owner",
        toolAuthorityFingerprint: fingerprint,
        cancel,
        messageInjectionV2: {
          version: 2,
          isAvailable: () => true,
          queueMessage: async (text, options, assertCurrent) => {
            preparing = true;
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
        await Promise.race([entered.promise, request]);
        expect(preparing).toBe(true);
        expect(enqueued).not.toHaveBeenCalled();
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        if (change === "profile merge") {
          linkEmail(email, target.id);
        } else if (change === "target closed") {
          operation.complete();
        }
        release.resolve();
        const respond = await request;
        if (change === "same profile") {
          expect(enqueued).toHaveBeenCalledExactlyOnceWith(fixture.params.message);
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
        await fixture.cleanup();
      }
    },
  );

  it.each(
    (["backend", "question dispatcher"] as const).flatMap((sink) =>
      [false, true].map((bound) => ({ sink, bound })),
    ),
  )("keeps V1 steering opt-in at the $sink boundary (bound: $bound)", async ({ sink, bound }) => {
    const fixture = await createBrowserFollowupFixture({ preserveContent: true });
    try {
      fixture.params.queueMode = "steer";
      fixture.client.connect.client = {
        id: "openclaw-ios",
        version: "test",
        platform: "ios",
        mode: "ui",
      };
      const profile = ensureProfileForEmail("v1-steering@example.test");
      fixture.client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: null,
        hasAvatar: false,
        updatedAt: profile.updatedAt,
      };
      const operation = fixture.activeRun!;
      const fingerprint = "v1-steering-tools";
      operation.bindToolAuthoritySnapshot({
        fingerprint: () => fingerprint,
        project: () => fingerprint,
      });
      operation.bindToolAuthorityRoute({ provider: "test-provider", model: "test-model" });
      operation.setPhase("running");
      const write = vi.fn(async () => undefined);
      const questionCall = resolveAgentQuestionGatewayCall(write);
      const cancel = vi.fn();
      operation.attachBackend({
        kind: "embedded",
        runId: "v1-backing-run",
        toolAuthorityFingerprint: fingerprint,
        cancel,
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
                    {
                      dispatchAuthority: { version: 2, kind, assertCurrent },
                    },
                  );
                  await options?.userTurnTranscriptRecorder?.persistApproved();
                },
              },
            }),
      });
      const respond = await fixture.send(undefined, {
        expectedProfileId: bound ? profile.id : undefined,
      });
      expect(operation.result).toBeNull();
      await fixture.finishDispatch();
      expect(write).toHaveBeenCalledTimes(bound ? 0 : 1);
      expect(respond).toHaveBeenCalledOnce();
      expect(respond.mock.calls[0]?.[0]).toBe(!bound);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      if (bound) {
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      } else {
        expect(respond.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(
    (["queue", "claim", "cancel"] as const).flatMap((sink) =>
      [false, true].map((bound) => ({ sink, bound })),
    ),
  )(
    "fences deferred custom question I/O through registry $sink (bound: $bound)",
    async ({ sink, bound }) => {
      const fixture = await createBrowserFollowupFixture();
      const entered = createDeferred();
      const release = createDeferred();
      let outcome: Promise<unknown> | undefined;
      try {
        const email = "deferred-source@example.test";
        const profile = ensureProfileForEmail(email);
        const successor = ensureProfileForEmail("deferred-successor@example.test");
        fixture.client.authenticatedUserProfile = {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        };
        const binding = createExpectedProfileBinding(profile.id, fixture.client)!;
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
        const dispatch = async (assertCurrent: () => void, kind: "run" | "source-bound") => {
          await questionCall(
            "question.resolve",
            {},
            {},
            {
              dispatchAuthority: { version: 2, kind, assertCurrent },
            },
          );
          return true;
        };
        const cancelBacking = vi.fn();
        const operation = fixture.activeRun!;
        operation.setPhase("running");
        operation.attachBackend({
          kind: "embedded",
          runId: "deferred-backing-run",
          toolAuthorityFingerprint: "active-tools",
          cancel: cancelBacking,
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            queueMessage: async (_text, _options, assertCurrent, kind) => {
              await dispatch(assertCurrent, kind);
            },
            claimPendingUserInputAnswer: async (_text, _options, assertCurrent, kind) =>
              dispatch(assertCurrent, kind),
            cancelPendingUserInput: async (_resolvedBy, assertCurrent, kind) =>
              dispatch(assertCurrent, kind),
          },
        });
        const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(
          fixture.scope.sessionKey,
        )!;
        const attempt = beginReplyMessageInjectionTarget(target, "answer", {
          isInboundUserMessage: true,
          toolAuthorityFingerprint: sink === "claim" ? "other-tools" : "active-tools",
          pendingInputAuthorityFingerprint: "active-tools",
          ...(sink === "cancel"
            ? { images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] }
            : {}),
          ...(bound ? { assertCurrent: binding.assertCurrent } : {}),
        });
        outcome = attempt.outcome.catch((error: unknown) => error);
        await Promise.race([entered.promise, outcome]);
        expect(write).not.toHaveBeenCalled();
        linkEmail(email, successor.id);
        release.resolve();
        const result = await outcome;
        expect(write).toHaveBeenCalledTimes(bound ? 0 : 1);
        if (bound) {
          if (sink === "cancel") {
            expect(result).toMatchObject({ name: "MessageInjectionAuthorityError" });
          } else {
            expect(result).toMatchObject({
              status: "failed",
              error: expect.objectContaining({
                error: expect.objectContaining({
                  details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "not_started" },
                }),
              }),
            });
          }
        } else {
          expect(result).toMatchObject({ status: sink === "cancel" ? "rejected" : "accepted" });
        }
        expect(cancelBacking).not.toHaveBeenCalled();
        expect(operation.result).toBeNull();
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      } finally {
        release.resolve();
        try {
          await outcome;
        } finally {
          await fixture.cleanup();
        }
      }
    },
  );

  it.each(["host", "session ACL", "lifecycle"] as const)(
    "retains original %s authority after committed browser custody and profile merge",
    async (boundary) => {
      const fixture = await createBrowserFollowupFixture({
        preserveContent: true,
        persistDuringDispatch: true,
      });
      let hostCurrent = true;
      try {
        const email = "retained-authority@example.test";
        const profile = ensureProfileForEmail(email);
        const target = ensureProfileForEmail("retained-authority-target@example.test");
        fixture.client.authenticatedUserProfile = {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        };
        if (boundary === "session ACL") {
          fixture.client.connect.scopes = ["operator.read", "operator.write"];
        }
        const ack = await fixture.send(undefined, {
          expectedProfileId: profile.id,
          sessionMutationCommitGuard: () => {
            if (!hostCurrent) {
              throw new Error("The original input host has closed.");
            }
          },
        });
        expect(ack).toHaveBeenCalledOnce();
        expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
        const originalAck = structuredClone(ack.mock.calls);
        const pending = listSessionPendingInputs(fixture.scope);
        expect(pending).toMatchObject({
          total: 1,
          items: [{ state: "queued", message: { content: fixture.params.message } }],
        });
        await fixture.dispatchedRecorder;
        linkEmail(email, target.id);
        if (boundary === "host") {
          hostCurrent = false;
        } else if (boundary === "session ACL") {
          await patchSessionEntryCore(fixture.scope, () => ({ visibility: "draft" }));
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        await fixture.finishDispatch();
        expect(ack.mock.calls).toEqual(originalAck);
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
        expect(
          loadTranscriptEventsSync(fixture.scope).filter(
            (entry) =>
              isRecord(entry) &&
              entry.type === "message" &&
              isRecord(entry.message) &&
              entry.message.idempotencyKey === `${fixture.params.idempotencyKey}:user`,
          ),
        ).toEqual([]);
        expect(listSessionPendingInputs(fixture.scope)).toMatchObject({
          total: 1,
          items: [
            {
              id: pending.items[0]?.id,
              state: "interrupted",
              message: pending.items[0]?.message,
            },
          ],
        });
        const cached = structuredClone(
          fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`),
        );
        expect(cached).toMatchObject({
          ok: false,
          payload: { runId: fixture.params.idempotencyKey, status: "error" },
        });
        expect(fixture.context.broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({
            runId: fixture.params.idempotencyKey,
            state: "error",
            errorMessage: expect.any(String),
          }),
          expect.anything(),
        );
        const retry = await fixture.send(undefined, { expectedProfileId: profile.id });
        expect(retry).toHaveBeenCalledExactlyOnceWith(
          false,
          undefined,
          expect.objectContaining({
            details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "not_started" },
          }),
        );
        expect(fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`)).toEqual(cached);
        expect(fixture.context.chatAbortControllers.size).toBe(0);
        expect(fixture.context.chatQueuedTurns.size).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
