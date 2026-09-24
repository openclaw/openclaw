import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import { guardSessionManager } from "../../agents/session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import type { AgentSessionEvent } from "../../agents/sessions/agent-session-types.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import type { ReplyBackendMessageInjectionV2 } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import {
  listSessionPendingInputs,
  loadExactSessionEntryReadOnly,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatSend } from "./chat-send-handler.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { resolveChatSendCallerContext } from "./gateway-client-identity.js";
import { identifiedClient } from "./sessions-sharing.test-support.js";
import type { RespondFn } from "./types.js";
installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

describe("steering input custody", () => {
  it.each(["same grant", "changed grant", "revoked grant"] as const)(
    "preserves authenticated chat.send steering authority after reconnect (%s)",
    async (scenario) => {
      const fixture = await createBrowserFollowupFixture({ preserveContent: true });
      const profile = ensureProfileForEmail("reconnect-steering@example.test");
      const originalGrant = new AbortController();
      const incomingGrant = new AbortController();
      const client = (connId: string, controller: AbortController, grantId: string) => ({
        ...createOperatorWsClient({ connId, scopes: fixture.client.connect.scopes }),
        authenticatedUserId: "reconnect-steering@example.test",
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          avatarRevision: "synthetic-avatar",
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        },
        connect: { ...fixture.client.connect, caps: ["ui-commands"] },
        internal: {
          operatorAccessAuthority: {
            gatewayAccessGrant: { pluginId: "test-access-policy", grantId },
            signal: controller.signal,
            assertCurrent: () => controller.signal.throwIfAborted(),
          },
        },
      });
      const originalClient = client("original-browser", originalGrant, "original-grant");
      const reconnectedClient = client(
        "reconnected-browser",
        incomingGrant,
        scenario === "changed grant" ? "replacement-grant" : "original-grant",
      );
      const captured = captureGatewayOperatorRunAuthority({
        client: originalClient,
        context: fixture.context,
      });
      let backingRun: Promise<void> | undefined;
      let releaseProvider = () => {};
      try {
        if (!captured || !fixture.activeRun) {
          throw new Error("Expected original operator and active run ownership");
        }
        const operation = fixture.activeRun;
        const run = createQueueTestRun({
          prompt: "Continue the original work",
          originatingChannel: "webchat",
        });
        const cfg = fixture.context.getRuntimeConfig();
        run.operatorAuthority = captured.authority;
        run.directHumanRequesterProfileId = profile.id;
        run.run = {
          ...run.run,
          config: cfg,
          agentId: fixture.scope.agentId,
          sessionId: fixture.scope.sessionId,
          sessionKey: fixture.scope.sessionKey,
          messageProvider: "webchat",
          chatType: "direct",
          clientCaps: ["ui-commands"],
          gatewayUiCommandTarget: { connId: originalClient.connId, profileId: profile.id },
          traceAuthorized: true,
          senderIsOwner: resolveCommandAuthorization({
            cfg,
            ctx: resolveChatSendCallerContext(originalClient),
            commandAuthorized: true,
          }).senderIsOwner,
        };
        operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
        const fingerprint = operation.bindToolAuthorityRoute(run.run);
        operation.setPhase("running");
        const sessionManager = SessionManager.open(
          fixture.scope,
          path.dirname(fixture.scope.storePath),
        );
        guardSessionManager(sessionManager, { ...fixture.scope, runId: "original-backing-run" });
        const { session } = await createTestSession({ sessionManager });
        const providerStarted = createDeferred();
        const response = createAssistantMessageEventStream();
        streamMocks.streamSimple
          .mockImplementationOnce(() => {
            providerStarted.resolve();
            return response;
          })
          .mockImplementation((model) =>
            createAssistantResultStream(
              createAssistant(model, [{ type: "text", text: "Steering consumed" }]),
            ),
          );
        let released = false;
        releaseProvider = () => {
          if (!released) {
            released = true;
            response.push({
              type: "done",
              reason: "stop",
              message: createAssistant(testModel, [{ type: "text", text: "Original work" }]),
            });
            response.end();
          }
        };
        backingRun = session.prompt("Continue the original work");
        await providerStarted.promise;
        fixture.beforeApprove.mockClear();
        const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
          async (text, options, assertCurrent) =>
            steerActiveSessionWithOptionalDeliveryWait(
              session,
              text,
              options,
              fixture.scope.sessionKey,
              () => {
                assertCurrent();
                return true;
              },
            ),
        );
        operation.attachBackend({
          kind: "embedded",
          runId: "original-backing-run",
          toolAuthorityFingerprint: fingerprint,
          cancel: vi.fn(),
          messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
        });
        const dispatch = createDispatchTestHarness({
          connId: reconnectedClient.connId,
          buildRequestContext: () => fixture.context,
          extraHandlers: { "chat.send": handleChatSend },
        });
        if (scenario === "revoked grant") {
          fixture.beforeApprove.mockImplementation(() =>
            incomingGrant.abort(new Error("Access grant ended")),
          );
        }
        await dispatch.dispatcher.dispatch(
          {
            type: "req",
            id: "reconnected-input",
            method: "chat.send",
            params: { ...fixture.params, queueMode: "steer" },
          },
          reconnectedClient,
        );
        if (scenario === "same grant") {
          expect(session.getSteeringMessages()).toEqual([fixture.params.message]);
          expect(queueMessage).toHaveBeenCalledOnce();
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        } else {
          expect(session.getSteeringMessages()).toEqual([]);
          expect(queueMessage).not.toHaveBeenCalled();
          if (scenario === "changed grant") {
            expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
            expect(dispatchInboundMessageMock.mock.calls[0]?.[0]).toMatchObject({
              replyOptions: { messageInjectionDisposition: "rejected" },
            });
          } else {
            expect(fixture.beforeApprove).toHaveBeenCalledOnce();
            expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
          }
        }
        releaseProvider();
        await backingRun;
        await fixture.finishDispatch();
        const input = loadTranscriptEventsSync(fixture.scope).find(
          (event) =>
            isRecord(event) &&
            isRecord(event.message) &&
            event.message.idempotencyKey === `${fixture.params.idempotencyKey}:user`,
        );
        if (scenario === "same grant") {
          expect(input).toMatchObject({
            message: {
              content: fixture.params.message,
              __openclaw: { steerTargetRunId: "original-backing-run" },
            },
          });
          expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
        } else if (scenario === "changed grant") {
          expect(input).toMatchObject({ message: { content: fixture.params.message } });
          expect(input).not.toHaveProperty("message.__openclaw.steerTargetRunId");
          expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
        } else {
          expect(input).toBeUndefined();
          expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
        }
      } finally {
        releaseProvider();
        await backingRun;
        await fixture.cleanup();
        captured?.release();
      }
    },
  );

  it.each([
    "internal fresh",
    "native custody",
    "native committed",
    "browser custody",
    "browser custody session ACL",
    "browser custody lifecycle",
  ] as const)(
    "owns the real backing-run outcome when authority changes at steering commit (%s)",
    async (inputState) => {
      const sharedProfileCustody =
        inputState === "browser custody" || inputState === "browser custody session ACL";
      const creator = sharedProfileCustody
        ? ensureProfileForEmail("steering-session-creator@example.test")
        : undefined;
      const fixture = await createBrowserFollowupFixture({
        preserveContent: true,
        ...(creator
          ? { createdActor: { type: "human", source: "profile", id: creator.id } as const }
          : {}),
      });
      const failures = new Set<unknown>();
      let releaseProviders = () => {};
      let backingRun: Promise<void> | undefined;
      try {
        const browserCustody = sharedProfileCustody || inputState === "browser custody lifecycle";
        fixture.params.queueMode = "steer";
        const operation = fixture.activeRun;
        if (!operation) {
          throw new Error("Expected a captured backing run");
        }
        const email = "steering-commit@example.test";
        const profile = ensureProfileForEmail(email);
        const target = ensureProfileForEmail("steering-commit-target@example.test");
        if (creator) {
          expect(profile.id).not.toBe(creator.id);
          expect(target.id).not.toBe(creator.id);
          fixture.client.connect.scopes = ["operator.read", "operator.write"];
          await patchSessionEntryCore(fixture.scope, () => ({
            visibility: "shared",
          }));
          expect(loadExactSessionEntryReadOnly(fixture.scope)?.entry).toMatchObject({
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: creator.id },
          });
        }
        if (!browserCustody) {
          fixture.client.connect.client = {
            id: "openclaw-ios",
            version: "test",
            platform: "ios",
            mode: "ui",
          };
        }
        if (inputState === "internal fresh") {
          fixture.params.systemInputProvenance = {
            kind: "internal_system",
            sourceTool: "internal-steering-fixture",
          };
        }
        fixture.client.authenticatedUserProfile = {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        };
        const sessionManager = SessionManager.open(
          fixture.scope,
          path.dirname(fixture.scope.storePath),
        );
        const inputKey = `${fixture.params.idempotencyKey}:user`;
        let recorder: UserTurnTranscriptRecorder | undefined;
        let initialRuntimeReceipt: ReturnType<UserTurnTranscriptRecorder["getAdmissionReceipt"]>;
        guardSessionManager(sessionManager, {
          agentId: fixture.scope.agentId,
          sessionKey: fixture.scope.sessionKey,
          runId: "native-backing-run",
          onUserMessagePersisted: (message) => {
            if ("idempotencyKey" in message && message.idempotencyKey === inputKey) {
              initialRuntimeReceipt = structuredClone(recorder?.getAdmissionReceipt());
            }
          },
        });
        const { session } = await createTestSession({ sessionManager });
        const terminals: AgentSessionEvent[] = [];
        session.subscribe((event) => {
          if (event.type === "agent_end" || event.type === "agent_settled") {
            terminals.push(event);
          }
        });
        const firstResponse = createAssistantMessageEventStream();
        const secondResponse = createAssistantMessageEventStream();
        streamMocks.streamSimple
          .mockImplementationOnce(() => firstResponse)
          .mockImplementation((model) =>
            inputState === "native committed"
              ? secondResponse
              : createAssistantResultStream(
                  createAssistant(model, [{ type: "text", text: "accepted steering completed" }]),
                ),
          );
        let released = false;
        const finishProvider = () => {
          if (released) {
            return;
          }
          released = true;
          firstResponse.push({
            type: "done",
            reason: "stop",
            message: createAssistant(testModel, [{ type: "text", text: "backing answer" }]),
          });
          firstResponse.end();
        };
        let secondReleased = false;
        const finishSteeringProvider = () => {
          if (secondReleased) {
            return;
          }
          secondReleased = true;
          secondResponse.push({
            type: "done",
            reason: "stop",
            message: createAssistant(testModel, [
              { type: "text", text: "accepted steering completed" },
            ]),
          });
          secondResponse.end();
        };
        releaseProviders = () => {
          finishProvider();
          finishSteeringProvider();
        };
        backingRun = session.prompt("Continue the original backing work.");
        const cancel = vi.fn();
        const fingerprint = "steering-commit-tools";
        operation.bindToolAuthoritySnapshot({
          fingerprint: () => fingerprint,
          project: () => fingerprint,
        });
        operation.bindToolAuthorityRoute({ provider: "test-provider", model: "test-model" });
        operation.setPhase("running");
        operation.attachBackend({
          kind: "embedded",
          runId: "native-backing-run",
          toolAuthorityFingerprint: fingerprint,
          cancel,
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            queueMessage: async (text, options, assertCurrent) => {
              recorder = options?.userTurnTranscriptRecorder;
              return await steerActiveSessionWithOptionalDeliveryWait(
                session,
                text,
                options,
                fixture.scope.sessionKey,
                () => {
                  assertCurrent();
                  return true;
                },
              );
            },
          },
        });
        await vi.waitFor(() => expect(streamMocks.streamSimple).toHaveBeenCalledOnce());
        const ack = await fixture.send(undefined, { expectedProfileId: profile.id });
        expect(ack.mock.calls[0]?.[1]).toMatchObject({ status: "started" });
        expect(ack).toHaveBeenCalledOnce();
        const originalAck = structuredClone(ack.mock.calls);
        expect(recorder).toBeDefined();
        if (!recorder) {
          throw new Error("The backing runtime did not capture its input recorder");
        }
        expect(recorder.getAdmissionReceipt()).toBeUndefined();
        const persistFallback = vi.spyOn(recorder, "persistFallback");
        const pending = listSessionPendingInputs(fixture.scope);
        expect(pending.total).toBe(inputState === "internal fresh" ? 0 : 1);
        expect(
          fixture.beforeApprove.mock.calls.filter(
            ([message]) => "idempotencyKey" in message && message.idempotencyKey === inputKey,
          ),
        ).toHaveLength(inputState === "internal fresh" ? 0 : 1);
        fixture.beforeApprove.mockClear();
        if (sharedProfileCustody || inputState === "native custody") {
          expect(session.getSteeringMessages()).toEqual([fixture.params.message]);
          expect(session.isStreaming).toBe(true);
          expect(released).toBe(false);
          expect(pending.items[0]).toMatchObject({
            runId: fixture.params.idempotencyKey,
            state: "queued",
            message: { idempotencyKey: inputKey, content: fixture.params.message },
          });
          linkEmail(email, target.id);
          if (inputState === "browser custody session ACL") {
            const visibility = {
              agentId: fixture.scope.agentId,
              sessionKey: fixture.scope.sessionKey,
              visibility: "draft",
            };
            const respond = vi.fn<RespondFn>();
            await handleGatewayRequest({
              req: {
                type: "req",
                id: "revoke-steering-session-access",
                method: "session.visibility.set",
                params: visibility,
              },
              client: identifiedClient(creator!.id),
              context: fixture.context,
              isWebchatConnect: () => true,
              respond,
            });
            expect(respond).toHaveBeenCalledExactlyOnceWith(
              true,
              { ok: true, sessionKey: fixture.scope.sessionKey, visibility: "draft" },
              undefined,
            );
            expect(loadExactSessionEntryReadOnly(fixture.scope)?.entry).toMatchObject({
              visibility: "draft",
              createdActor: { type: "human", source: "profile", id: creator!.id },
            });
            expect(operation.result).toBeNull();
            expect(released).toBe(false);
          }
        } else if (inputState === "browser custody lifecycle") {
          expect(session.getSteeringMessages()).toEqual([fixture.params.message]);
          expect(session.isStreaming).toBe(true);
          expect(released).toBe(false);
          expect(pending.items[0]).toMatchObject({
            runId: fixture.params.idempotencyKey,
            state: "queued",
            message: { idempotencyKey: inputKey, content: fixture.params.message },
          });
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
          rotateAgentEventLifecycleGeneration();
          expect(cancel).toHaveBeenCalledExactlyOnceWith("restart");
          expect(operation.result).toMatchObject({
            kind: "aborted",
            code: "aborted_for_restart",
          });
        } else if (inputState === "internal fresh") {
          fixture.beforeApprove.mockImplementation(() => linkEmail(email, target.id));
        }
        finishProvider();
        if (inputState === "native committed") {
          await vi.waitFor(() => expect(initialRuntimeReceipt).toBeDefined());
          // Source finalization confirms steering metadata after the runtime commit.
          // Keep the backing provider held until that final receipt is observable.
          await vi.waitFor(() =>
            expect(
              fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`),
            ).toMatchObject({
              ok: true,
              payload: { runId: fixture.params.idempotencyKey, status: "ok" },
            }),
          );
          const finalReceipt = structuredClone(recorder.getAdmissionReceipt());
          const committedTranscript = loadTranscriptEventsSync(fixture.scope);
          expect(finalReceipt).toBeDefined();
          expect(operation.result).toBeNull();
          expect(session.isStreaming).toBe(true);
          expect(fixture.beforeApprove).not.toHaveBeenCalled();
          linkEmail(email, target.id);
          expect(await recorder.persistApproved()).toBeUndefined();
          expect(recorder.getAdmissionReceipt()).toEqual(finalReceipt);
          expect(loadTranscriptEventsSync(fixture.scope)).toEqual(committedTranscript);
          expect(fixture.beforeApprove).not.toHaveBeenCalled();
          finishSteeringProvider();
        }
        await backingRun;
        await fixture.finishDispatch();
        if (
          inputState === "browser custody lifecycle" ||
          inputState === "browser custody session ACL"
        ) {
          const sessionRevoked = inputState === "browser custody session ACL";
          const sourceError = sessionRevoked
            ? expect.stringContaining("session is draft for this connection")
            : expect.stringContaining("Pending input ownership ended");
          const backingError = sessionRevoked
            ? expect.stringContaining("Message injection authority is no longer current")
            : sourceError;
          const transcript = loadTranscriptEventsSync(fixture.scope);
          const sourceErrors = vi
            .mocked(fixture.context.broadcast)
            .mock.calls.filter(
              ([event, payload]) =>
                event === "chat" &&
                isRecord(payload) &&
                payload.runId === fixture.params.idempotencyKey &&
                payload.state === "error",
            )
            .map(([, payload]) => payload);
          // Observe the full terminal result even when fallback wrongly dispatches:
          // the original ACK, backing runtime, custody, and source cleanup stay distinct.
          expect({
            ack: ack.mock.calls,
            freshDispatchCalls: dispatchInboundMessageMock.mock.calls.length,
            cancellationCalls: cancel.mock.calls,
            inputHooks: fixture.beforeApprove.mock.calls.length,
            providerCalls: streamMocks.streamSimple.mock.calls.length,
            streaming: session.isStreaming,
            steering: session.getSteeringMessages(),
            terminalEvents: terminals.map((event) => event.type),
            backingTerminal: session.messages.at(-1),
            originalInputs: transcript.filter(
              (entry) =>
                isRecord(entry) &&
                entry.type === "message" &&
                isRecord(entry.message) &&
                entry.message.idempotencyKey === inputKey,
            ),
            receipt: recorder.getAdmissionReceipt(),
            sourceTerminal: fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`),
            sourceErrors,
            pendingInputs: listSessionPendingInputs(fixture.scope),
            abortOwners: fixture.context.chatAbortControllers.size,
            queuedTurns: fixture.context.chatQueuedTurns.size,
          }).toMatchObject({
            ack: originalAck,
            freshDispatchCalls: 0,
            cancellationCalls: sessionRevoked ? [] : [["restart"]],
            inputHooks: 0,
            providerCalls: 1,
            streaming: false,
            steering: [],
            terminalEvents: ["agent_end", "agent_settled"],
            backingTerminal: {
              role: "assistant",
              stopReason: "error",
              errorMessage: backingError,
            },
            originalInputs: [],
            receipt: undefined,
            sourceTerminal: {
              ok: false,
              payload: { runId: fixture.params.idempotencyKey, status: "error" },
              error: { message: sourceError },
            },
            sourceErrors: [
              {
                runId: fixture.params.idempotencyKey,
                state: "error",
                errorMessage: sourceError,
              },
            ],
            pendingInputs: {
              total: 1,
              items: [{ ...pending.items[0], state: "interrupted" }],
            },
            abortOwners: 0,
            queuedTurns: 0,
          });
          expect(transcript).toContainEqual(
            expect.objectContaining({
              type: "message",
              message: expect.objectContaining({
                role: "assistant",
                stopReason: "error",
                __openclaw: expect.objectContaining({ runId: "native-backing-run" }),
              }),
            }),
          );
        } else {
          const refused = inputState === "internal fresh";
          expect(
            fixture.beforeApprove.mock.calls.map(([message]) =>
              "idempotencyKey" in message ? message.idempotencyKey : undefined,
            ),
          ).toEqual(refused ? [inputKey, inputKey] : []);
          if (refused) {
            expect(persistFallback).toHaveBeenCalledOnce();
          }
          expect(ack.mock.calls).toEqual(originalAck);
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
          expect(cancel).not.toHaveBeenCalled();
          expect(session.isStreaming).toBe(false);
          expect(session.getSteeringMessages()).toEqual([]);
          expect(terminals.filter((event) => event.type === "agent_end")).toHaveLength(1);
          expect(terminals.filter((event) => event.type === "agent_settled")).toHaveLength(1);
          expect(streamMocks.streamSimple).toHaveBeenCalledTimes(refused ? 1 : 2);
          const transcript = loadTranscriptEventsSync(fixture.scope);
          const originalInputs = transcript.filter(
            (entry) =>
              isRecord(entry) &&
              entry.type === "message" &&
              isRecord(entry.message) &&
              entry.message.idempotencyKey === `${fixture.params.idempotencyKey}:user`,
          );
          expect(originalInputs).toHaveLength(refused ? 0 : 1);
          if (refused) {
            // Agent-core commits its memory queue before persistence listeners.
            // Refusal must produce the existing backing-run error, not pretend it continued.
            expect(session.messages).toContainEqual(
              expect.objectContaining({
                role: "user",
                content: expect.arrayContaining([
                  expect.objectContaining({ type: "text", text: fixture.params.message }),
                ]),
              }),
            );
            expect(session.messages.at(-1)).toMatchObject({
              role: "assistant",
              stopReason: "error",
              errorMessage: expect.any(String),
            });
            expect(transcript).toContainEqual(
              expect.objectContaining({
                type: "message",
                message: expect.objectContaining({
                  role: "assistant",
                  stopReason: "error",
                  __openclaw: expect.objectContaining({ runId: "native-backing-run" }),
                }),
              }),
            );
            expect(recorder.getAdmissionReceipt()).toBeUndefined();
            expect(fixture.context.broadcast).toHaveBeenCalledWith(
              "chat",
              expect.objectContaining({
                runId: fixture.params.idempotencyKey,
                state: "error",
                errorMessage: expect.stringContaining("Selected account changed"),
              }),
              expect.anything(),
            );
          } else {
            expect(session.messages.at(-1)).toMatchObject({
              role: "assistant",
              stopReason: "stop",
            });
            expect(recorder.getAdmissionReceipt()).toBeDefined();
          }
          const cached = structuredClone(
            fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`),
          );
          expect(cached).toMatchObject({
            ok: !refused,
            payload: { runId: fixture.params.idempotencyKey, status: refused ? "error" : "ok" },
          });
          const staleRetry = await fixture.send(undefined, { expectedProfileId: profile.id });
          expect(staleRetry).toHaveBeenCalledExactlyOnceWith(
            false,
            undefined,
            expect.objectContaining({
              details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "not_started" },
            }),
          );
          expect(fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`)).toEqual(
            cached,
          );
          expect(loadTranscriptEventsSync(fixture.scope)).toEqual(transcript);
          expect(fixture.context.chatAbortControllers.size).toBe(0);
          expect(fixture.context.chatQueuedTurns.size).toBe(0);
          expect(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
        }
      } catch (error) {
        failures.add(error);
      } finally {
        releaseProviders();
        try {
          await backingRun;
        } catch (error) {
          failures.add(error);
        } finally {
          try {
            await fixture.cleanup();
          } catch (error) {
            failures.add(error);
          }
        }
      }
      if (failures.size === 1) {
        throw failures.values().next().value;
      }
      if (failures.size > 1) {
        throw new AggregateError(failures, "Backing-run fixture and cleanup failed", {
          cause: failures.values().next().value,
        });
      }
    },
  );
});
