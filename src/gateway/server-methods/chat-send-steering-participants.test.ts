import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createAssistantMessageEventStream, type Context } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { installRuntimeContextMessageForPrompt } from "../../agents/embedded-agent-runner/run/attempt-llm-boundary.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import { buildRuntimeContextCustomMessage } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import type { CurrentInboundPromptContext } from "../../agents/internal-runtime-context.js";
import { guardSessionManager } from "../../agents/session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createScreenTool } from "../../agents/tools/screen-tool.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { runReplyAgent } from "../../auto-reply/reply/agent-runner-run.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import { callPersonalToolUiCommand } from "../../auto-reply/reply/personal-tool-turn.test-support.js";
import { buildReplyPromptEnvelopeBase } from "../../auto-reply/reply/prompt-prelude.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../auto-reply/reply/queue.test-helpers.js";
import { clearFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import type { ReplyBackendMessageInjectionV2 } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.operation.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { createTypingController } from "../../auto-reply/reply/typing.js";
import {
  listSessionPendingInputs,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  setUserProfileRole,
} from "../../state/user-profiles.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "../server/ws-connection/connect-operator-access.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatSend } from "./chat-send-handler.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { resolveChatSendCallerContext } from "./gateway-client-identity.js";
installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

describe("steering input custody", () => {
  it.each([
    "shared-secret owner",
    "same grant",
    "changed grant",
    "revoked grant",
    "same permissions across profiles",
    "queued same permissions across profiles",
    "no native admission across profiles",
    "different scopes across profiles",
    "same role permissions across profiles",
    "different role session caps across profiles",
    "queued different role session caps across profiles",
    "different role agents across profiles",
    "different role sandbox across profiles",
  ] as const)(
    "preserves authenticated chat.send steering authority across callers (%s)",
    async (variant) => {
      const queuedPromotion = variant.startsWith("queued ");
      const scenario = variant.replace(/^queued /u, "");
      const startOwnerTurn = scenario === "same permissions across profiles";
      const sharedSecretOwner = scenario === "shared-secret owner";
      const profile = sharedSecretOwner
        ? ensureGatewayOwnerProfile("Gateway Owner")
        : ensureProfileForEmail("reconnect-steering@example.test");
      const acrossProfiles = scenario.endsWith("across profiles");
      const withRoles = scenario.includes("role");
      const incomingProfile = acrossProfiles
        ? ensureProfileForEmail("other-steering@example.test")
        : profile;
      const fixture = await createBrowserFollowupFixture({
        preserveContent: true,
        active: !startOwnerTurn,
        sandbox: scenario === "different role sandbox across profiles" ? "required" : undefined,
        // Both callers may write here; their caps still differ for other sessions.
        ...(withRoles
          ? { createdActor: { type: "human", source: "profile", id: incomingProfile.id } as const }
          : {}),
      });
      if (queuedPromotion) {
        // The real queue retains recent message IDs beyond queue disposal. These
        // independent scenarios must not impersonate retries of one source.
        fixture.params.idempotencyKey = `manual-${variant}`;
      }
      if (withRoles) {
        const role: GatewayOperatorRoleDefinition = {
          scopes: ["operator.read", "operator.write"],
          sessions: { others: "write" },
          agents: ["main", "other"],
          modelPolicy: { allow: ["openai/gpt-test"] },
        };
        const cfg = fixture.context.getRuntimeConfig();
        const roleConfig: typeof cfg = {
          ...cfg,
          gateway: {
            ...cfg.gateway,
            roles: {
              definitions: {
                writer: role,
                participant: {
                  ...role,
                  sessions: {
                    others:
                      scenario === "different role session caps across profiles" ? "view" : "write",
                  },
                  agents:
                    scenario === "different role agents across profiles"
                      ? ["main"]
                      : scenario === "same role permissions across profiles"
                        ? ["other", "main"]
                        : role.agents,
                  sandbox:
                    scenario === "different role sandbox across profiles"
                      ? "required"
                      : scenario === "same role permissions across profiles"
                        ? "inherit"
                        : role.sandbox,
                },
              },
            },
          },
        };
        fixture.context.getRuntimeConfig = () => roleConfig;
        fixture.client.connect.scopes = role.scopes;
        setUserProfileRole(profile.id, "writer");
        setUserProfileRole(incomingProfile.id, "participant");
      }
      const accepted =
        sharedSecretOwner ||
        scenario === "same grant" ||
        scenario === "same permissions across profiles" ||
        scenario === "same role permissions across profiles";
      const queued = !accepted && scenario !== "revoked grant";
      const originalGrant = new AbortController();
      const incomingGrant = new AbortController();
      const client = (connId: string, controller: AbortController, grantId: string) => ({
        ...createOperatorWsClient({ connId, scopes: fixture.client.connect.scopes }),
        usesSharedGatewayAuth: sharedSecretOwner,
        authenticatedUserId: sharedSecretOwner ? undefined : "reconnect-steering@example.test",
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          avatarRevision: "synthetic-avatar",
          hasAvatar: false,
          updatedAt: profile.updatedAt,
        },
        connect: { ...fixture.client.connect, caps: ["ui-commands"] },
        internal: sharedSecretOwner
          ? { authenticatedOperator: true as const, operatorRoleActor: { kind: "system" as const } }
          : {
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
      if (sharedSecretOwner) {
        prepareGatewayConnectOperatorAccess(originalClient);
        prepareGatewayConnectOperatorAccess(reconnectedClient);
        expect(originalClient.internal.operatorAccessAuthority).toBeUndefined();
        expect(reconnectedClient.internal.operatorAccessAuthority).toBeUndefined();
      }
      if (acrossProfiles) {
        reconnectedClient.authenticatedUserId = "other-steering@example.test";
        reconnectedClient.authenticatedUserProfile = {
          ...reconnectedClient.authenticatedUserProfile,
          profileId: incomingProfile.id,
          updatedAt: incomingProfile.updatedAt,
        };
        if (scenario === "different scopes across profiles") {
          reconnectedClient.connect.scopes = ["operator.read", "operator.write"];
        }
        prepareGatewayConnectOperatorAccess(originalClient);
        prepareGatewayConnectOperatorAccess(reconnectedClient);
        expect(originalClient.internal.operatorAccessAuthority).toBeNull();
        expect(reconnectedClient.internal.operatorAccessAuthority).toBeNull();
      }
      let captured: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
      let operation = fixture.activeRun;
      let ownerContext: CurrentInboundPromptContext | undefined;
      let cleanupOwnerContext = () => {};
      let backingRun: Promise<void> | undefined;
      let releaseProvider = () => {};
      try {
        if (startOwnerTurn) {
          const ownerDispatch = createDispatchTestHarness({
            connId: originalClient.connId,
            buildRequestContext: () => fixture.context,
            extraHandlers: { "chat.send": handleChatSend },
          });
          await ownerDispatch.dispatcher.dispatch(
            {
              type: "req",
              id: "owner-input",
              method: "chat.send",
              params: {
                ...fixture.params,
                message: "Continue the original work",
                idempotencyKey: "owner-input",
              },
            },
            originalClient,
          );
          await fixture.dispatchedRecorder;
          const ownerDispatchParams = dispatchInboundMessageMock.mock.calls[0]![0] as Parameters<
            typeof dispatchInboundMessage
          >[0];
          const ownerCtx = ownerDispatchParams.ctx;
          expect(ownerCtx).not.toHaveProperty("SenderId");
          ownerContext = buildReplyPromptEnvelopeBase({
            ctx: ownerCtx,
            sessionCtx: ownerCtx,
            baseBody: ownerCtx.BodyForAgent!,
            hasUserBody: true,
            inboundUserContext: buildInboundUserContextPrefix(ownerCtx),
            isBareSessionReset: false,
            startupAction: "new",
          }).currentInboundContext;
          dispatchInboundMessageMock.mockClear();
          operation = createReplyOperation({ ...fixture.scope, resetTriggered: false });
        }
        captured = await captureGatewayOperatorRunAuthority({
          client: originalClient,
          context: fixture.context,
        });
        if (!captured || !operation) {
          throw new Error("Expected original operator and active run ownership");
        }
        if (acrossProfiles) {
          expect(captured.authority.gatewayAccessGrant).toBeNull();
          expect(incomingProfile.id).not.toBe(captured.authority.profileId);
        }
        const run = createQueueTestRun({
          prompt: "Continue the original work",
          originatingChannel: "webchat",
        });
        const cfg = fixture.context.getRuntimeConfig();
        run.operatorAuthority = captured.authority;
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
          traceAuthorized: !withRoles,
          senderIsOwner: resolveCommandAuthorization({
            cfg,
            ctx: resolveChatSendCallerContext(originalClient),
            commandAuthorized: true,
          }).senderIsOwner,
        };
        operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
        const fingerprint = operation.bindToolAuthorityRoute(run.run);
        if (sharedSecretOwner) {
          const incoming = await captureGatewayOperatorRunAuthority({
            client: reconnectedClient,
            context: fixture.context,
          });
          if (!incoming) {
            throw new Error("Expected authenticated owner authority");
          }
          try {
            expect(incoming.authority.source).not.toBe(captured.authority.source);
            expect(
              prepareReplyToolAuthority({
                ...run,
                operatorAuthority: incoming.authority,
              }).fingerprint(run.run),
            ).toBe(fingerprint);
          } finally {
            incoming.release();
          }
        }
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
        cleanupOwnerContext = installRuntimeContextMessageForPrompt({
          session,
          message: buildRuntimeContextCustomMessage(ownerContext?.text, ownerContext?.fragments),
          persistedUserIdempotencyKey: startOwnerTurn ? "owner-input:user" : undefined,
        });
        backingRun = session.prompt("Continue the original work", {
          persistedUserIdempotencyKey: startOwnerTurn ? "owner-input:user" : undefined,
        });
        await providerStarted.promise;
        if (startOwnerTurn) {
          const firstContext = streamMocks.streamSimple.mock.calls[0]![1] as Context;
          const ownerUserContext = JSON.stringify(
            firstContext.messages
              .filter((message) => message.role === "user")
              .map((message) => message.content),
          );
          expect(ownerUserContext).toContain("requester_profile");
          expect(ownerUserContext).toContain(profile.id);
          expect(ownerUserContext).not.toContain(incomingProfile.id);
        }
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
        const cancelBackingRun = vi.fn();
        operation.attachBackend({
          kind: "embedded",
          runId: "original-backing-run",
          toolAuthorityFingerprint: fingerprint,
          supportsCrossProfileSteering:
            scenario !== "same grant" && scenario !== "no native admission across profiles",
          cancel: cancelBackingRun,
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
        const queuedSourceReady = createDeferred();
        if (queuedPromotion) {
          // Keep ingress, source lifecycle, queue ownership, control RPC, runtime injection,
          // transcript, and personal-tool authority real; replace only model preparation.
          dispatchInboundMessageMock.mockImplementation(async (input: unknown) => {
            const { ctx, replyOptions } = input as Parameters<typeof dispatchInboundMessage>[0];
            if (!replyOptions?.turnAdoptionLifecycle || !replyOptions.operatorAuthority) {
              throw new Error("Missing original admitted input ownership");
            }
            const source = createQueueTestRun({
              prompt: ctx.BodyForAgent!,
              messageId: fixture.params.idempotencyKey,
              originatingChannel: "webchat",
            });
            source.run = {
              ...run.run,
              gatewayUiCommandTarget: {
                connId: reconnectedClient.connId,
                profileId: incomingProfile.id,
              },
            };
            source.operatorAuthority = replyOptions.operatorAuthority;
            source.turnAdoptionLifecycle = replyOptions.turnAdoptionLifecycle;
            source.userTurnTranscriptRecorder = replyOptions.userTurnTranscriptRecorder;
            source.abortSignal = replyOptions.abortSignal;
            source.currentInboundContext = buildReplyPromptEnvelopeBase({
              ctx,
              sessionCtx: ctx,
              baseBody: source.prompt,
              hasUserBody: true,
              inboundUserContext: buildInboundUserContextPrefix(ctx),
              isBareSessionReset: false,
              startupAction: "new",
            }).currentInboundContext;
            await runReplyAgent({
              commandBody: source.prompt,
              followupRun: source,
              opts: replyOptions,
              queueKey: fixture.scope.sessionKey,
              resolvedQueue: createQueueSettings({ mode: "followup" }),
              shouldSteer: false,
              shouldFollowup: true,
              isActive: true,
              typing: createTypingController({}),
              sessionCtx: ctx,
              sessionKey: fixture.scope.sessionKey,
              defaultModel: "gpt-test",
              resolvedVerboseLevel: "off",
              isNewSession: false,
              blockStreamingEnabled: false,
              resolvedBlockStreamingBreak: "text_end",
              shouldInjectGroupIntro: false,
              typingMode: "never",
            });
            queuedSourceReady.resolve();
            return {};
          });
        }
        await dispatch.dispatcher.dispatch(
          {
            type: "req",
            id: "reconnected-input",
            method: "chat.send",
            params: { ...fixture.params, queueMode: queuedPromotion ? "followup" : "steer" },
          },
          reconnectedClient,
        );
        if (queuedPromotion) {
          await queuedSourceReady.promise;
          expect(
            fixture.context.chatQueuedTurns.get(fixture.params.idempotencyKey)?.steer,
          ).toBeTypeOf("function");
          expect(queueMessage).not.toHaveBeenCalled();
          await dispatch.dispatcher.dispatch(
            {
              type: "req",
              id: "promote-original-input",
              method: "chat.steer",
              params: {
                sessionKey: fixture.scope.sessionKey,
                sessionId: fixture.scope.sessionId,
                runId: fixture.params.idempotencyKey,
              },
            },
            reconnectedClient,
          );
          expect(await dispatch.awaitResponseFrame("promote-original-input")).toMatchObject({
            ok: true,
            payload: { status: accepted ? "accepted" : "queued" },
          });
        }
        if (accepted || queued) {
          expect(dispatch.send).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
        }
        if (accepted) {
          expect(session.getSteeringMessages()).toEqual([
            expect.stringContaining(fixture.params.message),
          ]);
          expect(queueMessage).toHaveBeenCalledOnce();
          expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(queuedPromotion ? 1 : 0);
          if (acrossProfiles) {
            const inboundContext = queueMessage.mock.calls[0]?.[1]?.currentInboundContext?.text;
            expect(inboundContext).toContain('"requester_profile"');
            const conversationInfo = JSON.parse(
              inboundContext!.match(/```json\n([\s\S]*?)\n```/u)![1]!,
            ) as {
              requester_profile: { id: string };
            };
            expect(conversationInfo.requester_profile.id).toBe(incomingProfile.id);
            const results: Awaited<ReturnType<typeof callPersonalToolUiCommand>>[] = [];
            const screen = createScreenTool({
              callGateway: async <T>(
                _method: string,
                params: Record<string, unknown>,
              ): Promise<T> => {
                const result = await callPersonalToolUiCommand(params, [
                  originalClient,
                  reconnectedClient,
                ]);
                results.push(result);
                return { ok: true } as T;
              },
            });
            await withGatewayToolCallerIdentity(
              {
                agentId: fixture.scope.agentId,
                sessionKey: fixture.scope.sessionKey,
                operatorAuthority: captured.authority,
                personalToolParticipants: operation.personalToolParticipants,
              },
              async () => {
                await screen.execute("unnamed", { action: "sidebar_hide" });
                const ambiguous = results.at(-1)!;
                for (const id of [profile.id, incomingProfile.id]) {
                  expect(ambiguous.respond).toHaveBeenCalledWith(
                    false,
                    undefined,
                    expect.objectContaining({ message: expect.stringContaining(`(user: ${id})`) }),
                  );
                }
                expect(ambiguous.broadcastToConnIds).not.toHaveBeenCalled();
                await screen.execute("selected", {
                  action: "sidebar_hide",
                  user: conversationInfo.requester_profile.id,
                });
                const selected = results.at(-1)!;
                expect(selected.respond).toHaveBeenCalledWith(true, { ok: true });
                expect(selected.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
                  "ui.command",
                  { command: { kind: "sidebar", visible: false } },
                  new Set([reconnectedClient.connId]),
                );
              },
            );
          }
        } else {
          expect(session.getSteeringMessages()).toEqual([]);
          expect(queueMessage).not.toHaveBeenCalled();
          if (queued) {
            expect(operation.personalToolParticipants?.resolve()?.profileId).toBe(profile.id);
            expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
            if (!queuedPromotion) {
              expect(dispatchInboundMessageMock.mock.calls[0]?.[0]).toMatchObject({
                replyOptions: { messageInjectionDisposition: "rejected" },
              });
            }
            expect(listSessionPendingInputs(fixture.scope)).toMatchObject({
              total: 1,
              items: [{ runId: fixture.params.idempotencyKey, state: "queued" }],
            });
          } else {
            expect(fixture.beforeApprove).toHaveBeenCalledOnce();
            expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
          }
        }
        if (queuedPromotion && queued) {
          await dispatch.dispatcher.dispatch(
            {
              type: "req",
              id: "withdraw-original-input",
              method: "chat.abort",
              params: {
                sessionKey: fixture.scope.sessionKey,
                runId: fixture.params.idempotencyKey,
                discardPendingInput: true,
              },
            },
            reconnectedClient,
          );
          expect(await dispatch.awaitResponseFrame("withdraw-original-input")).toMatchObject({
            ok: true,
          });
          expect(fixture.context.chatQueuedTurns.has(fixture.params.idempotencyKey)).toBe(false);
          expect(cancelBackingRun).not.toHaveBeenCalled();
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
        if (accepted) {
          expect(input).toMatchObject({
            message: {
              content: fixture.params.message,
              __openclaw: { steerTargetRunId: "original-backing-run" },
            },
          });
          expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
          if (acrossProfiles) {
            const modelContext = streamMocks.streamSimple.mock.calls[1]![1] as Context;
            const steeredUser = modelContext.messages.findLast(
              (message) => message.role === "user",
            );
            const userText = JSON.stringify(steeredUser?.content);
            expect(userText).toContain("requester_profile");
            expect(userText).toContain(incomingProfile.id);
            expect(userText).not.toContain(profile.id);
          }
        } else if (queued) {
          if (queuedPromotion) {
            // Withdrawal retains its cancellation receipt, not a visible transcript input.
            expect(input).toBeUndefined();
            expect(listSessionPendingInputs(fixture.scope)).toMatchObject({
              total: 1,
              items: [
                {
                  runId: fixture.params.idempotencyKey,
                  state: "cancelled",
                  message: { display: false },
                },
              ],
            });
          } else {
            expect(input).toMatchObject({ message: { content: fixture.params.message } });
            expect(input).not.toHaveProperty("message.__openclaw.steerTargetRunId");
          }
          expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
        } else {
          expect(input).toBeUndefined();
          expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
        }
      } finally {
        try {
          releaseProvider();
          await backingRun;
        } finally {
          cleanupOwnerContext();
          if (queuedPromotion) {
            clearFollowupQueue(fixture.scope.sessionKey);
          }
          operation?.complete();
          try {
            await fixture.cleanup();
          } finally {
            captured?.release();
          }
        }
      }
    },
  );
});
