import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Context } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  installRuntimeContextMessageForPrompt,
  normalizeMessagesForLlmBoundary,
} from "../../agents/embedded-agent-runner/run/attempt-llm-boundary.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../../agents/embedded-agent-runner/run/attempt-queue-message.js";
import { buildRuntimeContextCustomMessage } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import type { CurrentInboundPromptContext } from "../../agents/internal-runtime-context.js";
import { guardSessionManager } from "../../agents/session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  holdAssistantResponse,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { buildCommandContext } from "../../auto-reply/reply/commands.js";
import { prepareReplyRunContext } from "../../auto-reply/reply/get-reply-run-context.js";
import { baseParams } from "../../auto-reply/reply/get-reply-run.test-support.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { readReplySourceInput } from "../../auto-reply/reply/reply-source-binding.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import {
  listSessionPendingInputs,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import { assertNoRetainedSessionSharingReads } from "../../config/sessions/session-accessor.sqlite-diagnostics.test-support.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { ReplyBackendMessageInjectionV2 } from "../../sessions/session-controller.contracts.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  type SessionControllerMailboxClaim,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../../state/user-profiles.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { gatewayRequest } from "../request-frame.test-support.js";
import { dispatchProfile } from "../server/client-fixtures.test-support.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "../server/ws-connection/connect-operator-access.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatSend } from "./chat-send-handler.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { registerChatSteeringCommitCases } from "./chat-send-steering-commit.test-support.js";
import { resolveChatSendCallerContext } from "./gateway-client-identity.js";
installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

describe("steering input custody", () => {
  it.for([
    ...(
      [
        "shared-secret owner",
        "same grant",
        "changed grant",
        "revoked grant",
        "same permissions across profiles",
        "no native admission across profiles",
      ] as const
    ).map((scenario) => ({
      scenario,
      allowCollaborativeSteering:
        scenario === "revoked grant"
          ? undefined
          : scenario === "no native admission across profiles",
    })),
    { scenario: "different scopes across profiles", allowCollaborativeSteering: undefined },
    { scenario: "different role session caps across profiles", allowCollaborativeSteering: true },
  ])(
    "preserves authenticated chat.send steering authority across callers ($scenario, collaboration: $allowCollaborativeSteering)",
    async ({ scenario, allowCollaborativeSteering }, { signal }) => {
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
        // This matrix compares task collaborators; main requester changes have separate coverage.
        sessionKey: "agent:main:dashboard:steering-collaboration",
        preserveContent: true,
        active: !startOwnerTurn,
        // Both callers may write here; their caps still differ for other sessions.
        ...(withRoles
          ? { createdActor: { type: "human", source: "profile", id: incomingProfile.id } as const }
          : {}),
      });
      const initialConfig = fixture.context.getRuntimeConfig();
      const initialQueue = { ...initialConfig.messages?.queue };
      delete initialQueue.allowCollaborativeSteering;
      const steeringConfig: typeof initialConfig = {
        ...initialConfig,
        agents: {
          ...initialConfig.agents,
          defaults: {
            ...initialConfig.agents?.defaults,
            model: { primary: "openai/gpt-test" },
          },
        },
        messages: {
          ...initialConfig.messages,
          queue: {
            ...initialQueue,
            ...(allowCollaborativeSteering !== undefined ? { allowCollaborativeSteering } : {}),
          },
        },
      };
      fixture.context.getRuntimeConfig = () => steeringConfig;
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
                participant: { ...role, sessions: { others: "view" } },
              },
            },
          },
        };
        fixture.context.getRuntimeConfig = () => roleConfig;
        fixture.client.connect.scopes = role.scopes;
        setUserProfileRole(profile.id, "writer");
        setUserProfileRole(incomingProfile.id, "participant");
      }
      const collaborative = allowCollaborativeSteering === true && acrossProfiles;
      const accepted =
        sharedSecretOwner ||
        scenario === "same grant" ||
        (collaborative && scenario !== "no native admission across profiles");
      const refused = acrossProfiles && allowCollaborativeSteering !== true;
      const forwarded = !accepted && scenario !== "revoked grant";
      const originalGrant = new AbortController();
      const incomingGrant = new AbortController();
      const client = (connId: string, controller: AbortController, grantId: string) => ({
        ...createOperatorWsClient({ connId, scopes: fixture.client.connect.scopes }),
        usesSharedGatewayAuth: sharedSecretOwner,
        authenticatedUserId: sharedSecretOwner ? undefined : "reconnect-steering@example.test",
        authenticatedUserProfile: dispatchProfile(profile.id, {
          avatarRevision: "synthetic-avatar",
          updatedAt: profile.updatedAt,
        }),
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
      let ownerClaim: SessionControllerMailboxClaim | undefined;
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
            gatewayRequest("owner-input", "chat.send", {
              ...fixture.params,
              message: "Continue the original work",
              idempotencyKey: "owner-input",
            }),
            originalClient,
          );
          await fixture.dispatchedRecorder;
          const ownerDispatchParams = dispatchInboundMessageMock.mock.calls[0]![0] as Parameters<
            typeof dispatchInboundMessage
          >[0];
          const ownerCtx = ownerDispatchParams.ctx;
          expect(ownerCtx).not.toHaveProperty("SenderId");
          const ownerConfig = fixture.context.getRuntimeConfig();
          const prepared = await prepareReplyRunContext(
            baseParams({
              ctx: ownerCtx,
              sessionCtx: ownerCtx,
              cfg: ownerConfig,
              agentId: fixture.scope.agentId,
              sessionKey: fixture.scope.sessionKey,
              sessionId: fixture.scope.sessionId,
              storePath: fixture.scope.storePath,
              isNewSession: false,
              systemSent: true,
              provider: "openai",
              model: "gpt-test",
              opts: ownerDispatchParams.replyOptions,
              commandAuthorized: ownerCtx.CommandAuthorized === true,
              command: buildCommandContext(
                {
                  ctx: ownerCtx,
                  cfg: ownerConfig,
                  agentId: fixture.scope.agentId,
                  sessionKey: fixture.scope.sessionKey,
                  isGroup: false,
                  triggerBodyNormalized: ownerCtx.commandText ?? ownerCtx.Body ?? "",
                },
                resolveCommandAuthorization({
                  cfg: ownerConfig,
                  ctx: ownerCtx,
                  commandAuthorized: ownerCtx.CommandAuthorized === true,
                }),
              ),
            }),
          );
          if (prepared.kind !== "ready") {
            throw new Error("Expected prepared owner reply context");
          }
          ownerContext = prepared.buildPromptBodies({}).currentInboundContext;
          dispatchInboundMessageMock.mockClear();
          const ownerInput = readReplySourceInput(ownerDispatchParams.replyOptions);
          if (!ownerInput) {
            throw new Error("Expected original RPC source");
          }
          ownerClaim = await claimSessionControllerTask(ownerInput, (claim) => {
            operation = createReplyOperation({
              ...fixture.scope,
              resetTriggered: false,
              mailboxClaim: claim,
              target: ownerInput.mailbox.owner.target,
            });
          });
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
          gitContributorProfileId: profile.id,
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
        const toolAuthority = prepareReplyToolAuthority(run);
        await toolAuthority.fingerprintAsync(run.run);
        operation.bindToolAuthoritySnapshot(toolAuthority);
        const fingerprint = operation.bindToolAuthorityRoute(run.run);
        const requesterPrincipalKey = operation.requesterPrincipalKey;
        if (sharedSecretOwner) {
          const incoming = await captureGatewayOperatorRunAuthority({
            client: reconnectedClient,
            context: fixture.context,
          });
          if (!incoming) {
            throw new Error("Expected authenticated owner authority");
          }
          const incomingTools = prepareReplyToolAuthority({
            ...run,
            operatorAuthority: incoming.authority,
          });
          try {
            expect(incoming.authority.source).not.toBe(captured.authority.source);
            expect(await incomingTools.fingerprintAsync(run.run)).toBe(fingerprint);
          } finally {
            incomingTools.close();
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
        const convertToLlm = session.agent.convertToLlm.bind(session.agent);
        session.agent.convertToLlm = (messages) =>
          convertToLlm(
            normalizeMessagesForLlmBoundary(messages, {
              sessionVersion: sessionManager.getHeader()?.version,
            }),
          );
        const providerStarted = createDeferred();
        const provider = holdAssistantResponse("Original work");
        streamMocks.streamSimple
          .mockImplementationOnce(() => {
            providerStarted.resolve();
            return provider.response;
          })
          .mockImplementation((model) =>
            createAssistantResultStream(
              createAssistant(model, [{ type: "text", text: "Steering consumed" }]),
            ),
          );
        releaseProvider = provider.release;
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
        const steeringAccepted = createDeferred();
        const queueMessage = vi.fn<
          NonNullable<ReplyBackendMessageInjectionV2["queueMessageAsync"]>
        >(async (text, options, preparation, authorityKind) =>
          steerActiveSessionWithOptionalDeliveryWait(
            session,
            text,
            {
              ...options,
              onQueueAccepted: (nativeAccepted) => {
                options?.onQueueAccepted?.(nativeAccepted);
                if (nativeAccepted) {
                  steeringAccepted.resolve();
                }
              },
            },
            fixture.scope.sessionKey,
            () => {
              preparation.assertCurrent();
              return true;
            },
            {
              kind: authorityKind,
              assertCurrent: preparation.assertCurrent,
              toolAuthorityPreparation: preparation,
            },
            preparation.prepareCurrent,
          ),
        );
        operation.attachBackend({
          kind: "embedded",
          supportsTranscriptCommitWait: true,
          runId: "original-backing-run",
          toolAuthorityFingerprint: fingerprint,
          supportsCrossProfileSteering:
            scenario !== "same grant" && scenario !== "no native admission across profiles",
          cancel: vi.fn(),
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            queueMessage: async () => {
              throw new Error("Expected the current prepared embedded steering boundary");
            },
            queueMessageAsync: queueMessage,
          },
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
        const followupDispatched = createDeferred();
        const dispatchInput = dispatchInboundMessageMock.getMockImplementation();
        if (!dispatchInput) {
          throw new Error("Expected the fixture to own input dispatch");
        }
        // The owner turn may already have resolved the fixture's first-dispatch signal.
        dispatchInboundMessageMock.mockImplementationOnce(async (params) => {
          followupDispatched.resolve();
          return await dispatchInput(params);
        });
        await dispatch.dispatcher.dispatch(
          gatewayRequest("reconnected-input", "chat.send", {
            ...fixture.params,
            queueMode: "steer",
          }),
          reconnectedClient,
        );
        if (accepted || forwarded) {
          expect(dispatch.send).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
        }
        if (accepted) {
          await withinTest(steeringAccepted.promise, signal);
          expect(
            session.getSteeringMessages(),
            JSON.stringify(vi.mocked(fixture.context.logGateway.warn).mock.calls),
          ).toEqual([expect.stringContaining(fixture.params.message)]);
          expect(queueMessage).toHaveBeenCalledOnce();
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        } else {
          expect(session.getSteeringMessages()).toEqual([]);
          expect(queueMessage).not.toHaveBeenCalled();
          if (forwarded) {
            await withinTest(followupDispatched.promise, signal);
            expect(operation.personalToolParticipants?.resolve()?.profileId).toBe(profile.id);
            expect(operation.result).toBeNull();
            expect(provider.isReleased()).toBe(false);
            expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
            expect(dispatchInboundMessageMock.mock.calls[0]?.[0]).toMatchObject({
              replyOptions: {
                messageInjectionDisposition: refused
                  ? "collaborative-steering-disabled"
                  : "rejected",
                operatorAuthority: { profileId: incomingProfile.id },
              },
            });
            // The execution stub holds staged custody; the real dispatch refusal test
            // separately verifies durable cancellation and duplicate/recovery refusal.
            expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
              total: 1,
              items: [
                {
                  runId: fixture.params.idempotencyKey,
                  state: "queued",
                  message: {
                    __openclaw: { requesterOrigin: { operatorProfileId: incomingProfile.id } },
                  },
                },
              ],
            });
          } else {
            expect(fixture.beforeApprove).toHaveBeenCalledOnce();
            expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
          }
        }
        expect(operation.toolAuthorityFingerprint).toBe(fingerprint);
        expect(operation.requesterPrincipalKey).toBe(requesterPrincipalKey);
        expect(
          operation.personalToolParticipants?.resolve(undefined, { allowTurnOwner: () => true })
            ?.operatorAuthority,
        ).toBe(captured.authority);
        if (accepted && acrossProfiles) {
          const participants = operation.personalToolParticipants;
          expect(participants?.resolve(incomingProfile.id)?.profileId).toBe(incomingProfile.id);
          expect(() => participants?.resolve()).toThrow("Several people have steered this turn");
          expect(queueMessage.mock.calls[0]?.[1]?.isInboundUserMessage).toBe(false);
        }
        releaseProvider();
        await backingRun;
        if (ownerClaim) {
          operation.complete();
          releaseSessionControllerClaim(ownerClaim);
        }
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
          if (acrossProfiles) {
            expect(input).toHaveProperty(
              "message.__openclaw.requesterOrigin.operatorProfileId",
              incomingProfile.id,
            );
          }
          expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
        } else if (forwarded) {
          expect(input).toMatchObject({ message: { content: fixture.params.message } });
          expect(input).not.toHaveProperty("message.__openclaw.steerTargetRunId");
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
          operation?.complete();
          if (ownerClaim) {
            releaseSessionControllerClaim(ownerClaim);
          }
          try {
            await fixture.cleanup();
          } finally {
            captured?.release();
          }
        }
      }
      assertNoRetainedSessionSharingReads();
    },
  );

  registerChatSteeringCommitCases(createBrowserFollowupFixture);
});
