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
import type { AgentSessionEvent } from "../../agents/sessions/agent-session-types.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import { buildReplyPromptEnvelopeBase } from "../../auto-reply/reply/prompt-prelude.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import type { ReplyBackendMessageInjectionV2 } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.operation.js";
import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import {
  listSessionPendingInputs,
  loadExactSessionEntryReadOnly,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { assertNoRetainedSessionSharingReads } from "../../config/sessions/session-accessor.sqlite-diagnostics.test-support.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { linkEmail, setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../../state/user-profiles.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "../server/ws-connection/connect-operator-access.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { bindSteeringTools } from "./chat-send-authority.test-support.js";
import { handleChatSend } from "./chat-send-handler.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { resolveChatSendCallerContext } from "./gateway-client-identity.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import { identifiedClient } from "./sessions-sharing.test-support.js";
import type { RespondFn } from "./types.js";
installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

describe("steering input custody", () => {
  it.for([
    "shared-secret owner",
    "same grant",
    "changed grant",
    "revoked grant",
    "same permissions across profiles",
    "no native admission across profiles",
    "different scopes across profiles",
    "same role permissions across profiles",
    "different role session caps across profiles",
    "different role agents across profiles",
    "different role sandbox across profiles",
  ] as const)(
    "preserves authenticated chat.send steering authority across callers (%s)",
    async (scenario, { signal }) => {
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
        const toolAuthority = prepareReplyToolAuthority(run);
        await toolAuthority.fingerprintAsync(run.run);
        operation.bindToolAuthoritySnapshot(toolAuthority);
        const fingerprint = operation.bindToolAuthorityRoute(run.run);
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
          supportsCrossProfileSteering:
            scenario !== "same grant" && scenario !== "no native admission across profiles",
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
        if (accepted || queued) {
          expect(dispatch.send).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
        }
        if (accepted) {
          expect(session.getSteeringMessages()).toEqual([
            expect.stringContaining(fixture.params.message),
          ]);
          expect(queueMessage).toHaveBeenCalledOnce();
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
          if (acrossProfiles) {
            const inboundContext = queueMessage.mock.calls[0]?.[1]?.currentInboundContext?.text;
            expect(inboundContext).toContain('"requester_profile"');
            const conversationInfo = JSON.parse(
              inboundContext!.match(/```json\n([\s\S]*?)\n```/u)![1]!,
            ) as {
              requester_profile: { id: string };
            };
            expect(conversationInfo.requester_profile.id).toBe(incomingProfile.id);
            expect(
              operation.personalToolParticipants?.resolve(incomingProfile.id)
                ?.gatewayUiCommandTarget,
            ).toEqual({
              connId: reconnectedClient.connId,
              profileId: incomingProfile.id,
            });
          }
        } else {
          expect(session.getSteeringMessages()).toEqual([]);
          expect(queueMessage).not.toHaveBeenCalled();
          if (queued) {
            await withinTest(fixture.dispatchedRecorder, signal);
            expect(operation.personalToolParticipants?.resolve()?.profileId).toBe(profile.id);
            expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
            expect(dispatchInboundMessageMock.mock.calls[0]?.[0]).toMatchObject({
              replyOptions: { messageInjectionDisposition: "rejected" },
            });
            expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
              total: 1,
              items: [{ runId: fixture.params.idempotencyKey, state: "queued" }],
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
            const steeredUserIndex = modelContext.messages.findLastIndex(
              (message) => message.role === "user" && !Reflect.get(message, "runtimeContext"),
            );
            const steeredUser = modelContext.messages[steeredUserIndex];
            const runtimeContext = modelContext.messages[steeredUserIndex - 1];
            const userText = JSON.stringify(steeredUser?.content);
            const runtimeText = JSON.stringify(runtimeContext?.content);
            expect(runtimeText).toContain("requester_profile");
            expect(runtimeText).toContain(incomingProfile.id);
            expect(runtimeText).not.toContain(profile.id);
            expect(userText).not.toContain("requester_profile");
          }
        } else if (queued) {
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

  it.each([
    "internal fresh",
    "native custody",
    "native committed",
    "browser custody",
    "browser custody workspace",
    "browser custody session ACL",
    "browser custody lifecycle",
  ] as const)(
    "owns the real backing-run outcome when authority changes at steering commit (%s)",
    async (inputState) => {
      const sharedProfileCustody =
        inputState === "browser custody" ||
        inputState === "browser custody workspace" ||
        inputState === "browser custody session ACL";
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
        if (inputState === "browser custody workspace") {
          await patchSessionEntryCore(fixture.scope, () => ({
            pendingProjectGitUrl: "file:///synthetic/missing-project.git",
          }));
        }
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
        const backingProvider = holdAssistantResponse("backing answer");
        const steeringProvider = holdAssistantResponse("accepted steering completed");
        streamMocks.streamSimple
          .mockImplementationOnce(() => backingProvider.response)
          .mockImplementation((model) =>
            inputState === "native committed"
              ? steeringProvider.response
              : createAssistantResultStream(
                  createAssistant(model, [{ type: "text", text: "accepted steering completed" }]),
                ),
          );
        releaseProviders = () => {
          backingProvider.release();
          steeringProvider.release();
        };
        backingRun = session.prompt("Continue the original backing work.");
        const cancel = vi.fn();
        const fingerprint = "steering-commit-tools";
        bindSteeringTools(operation, fingerprint);
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
        const pending = await listSessionPendingInputs(fixture.scope);
        expect(pending.total).toBe(inputState === "internal fresh" ? 0 : 1);
        expect(
          fixture.beforeApprove.mock.calls.filter(
            ([message]) => "idempotencyKey" in message && message.idempotencyKey === inputKey,
          ),
        ).toHaveLength(inputState === "internal fresh" ? 0 : 1);
        fixture.beforeApprove.mockClear();
        if (
          sharedProfileCustody ||
          inputState === "native custody" ||
          inputState === "browser custody lifecycle"
        ) {
          expect(session.getSteeringMessages()).toEqual([fixture.params.message]);
          expect(session.isStreaming).toBe(true);
          expect(backingProvider.isReleased()).toBe(false);
          expect(pending.items[0]).toMatchObject({
            runId: fixture.params.idempotencyKey,
            state: "queued",
            message: { idempotencyKey: inputKey, content: fixture.params.message },
          });
        }
        if (sharedProfileCustody || inputState === "native custody") {
          linkEmail(email, target.id);
          if (inputState === "browser custody session ACL") {
            await initializeSessionReadContext(fixture.context);
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
            expect(backingProvider.isReleased()).toBe(false);
          }
        } else if (inputState === "browser custody lifecycle") {
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
        backingProvider.release();
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
          steeringProvider.release();
        }
        await backingRun;
        await fixture.finishDispatch();
        const revoked =
          inputState === "browser custody lifecycle" ||
          inputState === "browser custody session ACL";
        const refused = inputState === "internal fresh";
        const failed = revoked || refused;
        const transcript = loadTranscriptEventsSync(fixture.scope);
        const originalInputs = transcript.filter(
          (entry) =>
            isRecord(entry) &&
            entry.type === "message" &&
            isRecord(entry.message) &&
            entry.message.idempotencyKey === inputKey,
        );
        const cached = structuredClone(
          fixture.context.dedupe.get(`chat:${fixture.params.idempotencyKey}`),
        );
        expect(ack.mock.calls).toEqual(originalAck);
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(cancel.mock.calls).toEqual(
          inputState === "browser custody lifecycle" ? [["restart"]] : [],
        );
        expect(session.isStreaming).toBe(false);
        expect(session.getSteeringMessages()).toEqual([]);
        expect(streamMocks.streamSimple).toHaveBeenCalledTimes(failed ? 1 : 2);
        expect(
          fixture.beforeApprove.mock.calls.map(([message]) =>
            "idempotencyKey" in message ? message.idempotencyKey : undefined,
          ),
        ).toEqual(refused ? [inputKey, inputKey] : []);
        expect(originalInputs).toHaveLength(failed ? 0 : 1);
        expect(cached).toMatchObject({
          ok: !failed,
          payload: { runId: fixture.params.idempotencyKey, status: failed ? "error" : "ok" },
        });
        expect([
          fixture.context.chatAbortControllers.size,
          fixture.context.chatQueuedTurns.size,
        ]).toEqual([0, 0]);
        if (failed) {
          expect(recorder.getAdmissionReceipt()).toBeUndefined();
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
        }
        if (revoked) {
          const sessionRevoked = inputState === "browser custody session ACL";
          const sourceError = expect.stringContaining(
            sessionRevoked
              ? "session is draft for this connection"
              : "Pending input ownership ended",
          );
          expect(terminals.map((event) => event.type)).toEqual(["agent_end", "agent_settled"]);
          expect(session.messages.at(-1)).toMatchObject({
            role: "assistant",
            stopReason: "error",
            errorMessage: sessionRevoked
              ? expect.stringContaining("Message injection authority is no longer current")
              : sourceError,
          });
          expect(cached).toMatchObject({ error: { message: sourceError } });
          expect(
            vi
              .mocked(fixture.context.broadcast)
              .mock.calls.filter(
                ([event, payload]) =>
                  event === "chat" &&
                  isRecord(payload) &&
                  payload.runId === fixture.params.idempotencyKey &&
                  payload.state === "error",
              )
              .map(([, payload]) => payload),
          ).toMatchObject([
            {
              runId: fixture.params.idempotencyKey,
              state: "error",
              errorMessage: sourceError,
            },
          ]);
          expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
            total: 1,
            items: [{ ...pending.items[0], state: "interrupted" }],
          });
        } else {
          expect(terminals.filter((event) => event.type === "agent_end")).toHaveLength(1);
          expect(terminals.filter((event) => event.type === "agent_settled")).toHaveLength(1);
          if (refused) {
            expect(persistFallback).toHaveBeenCalledOnce();
            // Memory consumption precedes persistence; refusal terminates the backing run.
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
          if (inputState === "browser custody workspace") {
            expect(loadExactSessionEntryReadOnly(fixture.scope)?.entry).toMatchObject({
              pendingProjectGitUrl: "file:///synthetic/missing-project.git",
            });
          }
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
          expect([
            fixture.context.chatAbortControllers.size,
            fixture.context.chatQueuedTurns.size,
          ]).toEqual([0, 0]);
          expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
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
