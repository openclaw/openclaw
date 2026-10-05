import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
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
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createExpectedProfileBinding } from "../expected-profile.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import {
  setClientProfile,
  setNativeIosClient,
  useBrowserFollowupFixture,
} from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

describe("native profile-bound steering", () => {
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
      setNativeIosClient(fixture.client);
      setClientProfile(fixture.client, profile);
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
        await fixture.cleanup();
      }
    },
  );

  it.each(["backend", "question dispatcher"] as const)(
    "queues original operator input without an explicit profile binding when the %s is V1",
    async (sink) => {
      const fixture = await createBrowserFollowupFixture({ preserveContent: true });
      try {
        fixture.params.queueMode = "steer";
        setNativeIosClient(fixture.client);
        const profile = ensureProfileForEmail("v1-steering@example.test");
        setClientProfile(fixture.client, profile);
        const operation = fixture.activeRun!;
        const fingerprint = "v1-steering-tools";
        let originalOperatorAuthority: AdmittedRunOperatorAuthority | undefined;
        operation.bindToolAuthoritySnapshot({
          fingerprint: () => fingerprint,
          project: (incoming) => {
            originalOperatorAuthority = incoming.operatorAuthority;
            return fingerprint;
          },
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
        const respond = await fixture.send(undefined, {});
        expect(operation.result).toBeNull();
        expect(write).not.toHaveBeenCalled();
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        expect(respond.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
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
        expect(authority.profileId).toBe(profile.id);
        expect(authority.scopes).toEqual(fixture.client.connect.scopes);
        expect(authority.assertCurrent).not.toThrow();
        expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
          total: 1,
          items: [{ state: "queued", runId: fixture.params.idempotencyKey }],
        });
        expect(cancel).not.toHaveBeenCalled();
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
        await fixture.finishDispatch();
        expect(authority.assertCurrent).toThrow("operator execution authority is no longer active");
      } finally {
        await fixture.cleanup();
      }
    },
  );

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
        setClientProfile(fixture.client, profile);
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
        const attempt = await beginReplyMessageInjectionTarget(target, "answer", {
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
          expect(result).toMatchObject({
            status: "failed",
            error: expect.objectContaining({
              error: expect.objectContaining({
                details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "not_started" },
              }),
            }),
          });
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
});
