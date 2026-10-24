import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../../gateway/device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { readSessionSendDeliveryAdmission } from "../../gateway/session-send-delivery.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createReplyTurnParticipants } from "../../sessions/session-controller.tool-authority.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { captureRequesterOrigin } from "../requester-origin.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
  withGatewayPersonalToolUser,
} from "./gateway-caller-context.js";
import * as continuation from "./in-process-gateway.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { readSessionCommunicationEndpoint } from "./sessions-send-communication-endpoint.js";
import { prepareSessionsSendCommunication } from "./sessions-send-communication.js";
import {
  prepareSessionsSendReplyContext,
  startSessionsSendReplyFlow,
} from "./sessions-send-reply-flow.js";
import { createSessionsSendSessionReaders } from "./sessions-send-session-source.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

it.each(["allowed", "revoked", "session changed", "selected Bob"] as const)(
  "preserves requester selection and separate-turn return after invocation closure: %s",
  async (boundary) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg: OpenClawConfig = {
        tools: { sessions: { visibility: "all" } },
        session: { communication: { send: "always", receive: "always" } },
      };
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:main:dashboard:synthetic-requester";
      const peerKey = "agent:main:dashboard:synthetic-peer";
      const requesterEntry = {
        sessionId: "requester-id",
        lifecycleRevision: "requester-v1",
        updatedAt: 1,
      };
      const peerEntry = { sessionId: "peer-id", lifecycleRevision: "peer-v1", updatedAt: 1 };
      await replaceSessionEntry({ agentId: "main", sessionKey }, requesterEntry);
      await replaceSessionEntry({ agentId: "main", sessionKey: peerKey }, peerEntry);
      const client = createOperatorClient({
        profileName: "synthetic-peer-requester",
        scopes: ["operator.read", "operator.write"],
      });
      const context = createContext([], () => cfg);
      const resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
      let connected = true;
      let receiptCurrent = true;
      const device = captureGatewayDeviceRevocation(
        context,
        { deviceId: "synthetic-peer-device", role: "operator" },
        () => connected,
        undefined,
        { isCurrent: () => true, subscribe: () => () => {} },
      );
      const source = await captureGatewayOperatorRunAuthority({
        client,
        context,
        hasCurrentClientAuthority: device.isCurrent,
      });
      const origin = captureRequesterOrigin({
        sessionKey,
        operatorProfileId: client.authenticatedUserProfile?.profileId,
      });
      if (!source || !origin) {
        throw new Error("Expected authenticated requester source");
      }
      const bobClient = createOperatorClient({
        profileName: "synthetic-selected-bob",
        scopes: ["operator.read", "operator.write", "operator.approvals"],
      });
      let bobConnected = true;
      const bobDevice = captureGatewayDeviceRevocation(
        context,
        { deviceId: "synthetic-bob-device", role: "operator" },
        () => bobConnected,
        undefined,
        { isCurrent: () => true, subscribe: () => () => {} },
      );
      const bobSource = await captureGatewayOperatorRunAuthority({
        client: bobClient,
        context,
        hasCurrentClientAuthority: bobDevice.isCurrent,
      });
      const bobOrigin = captureRequesterOrigin({
        sessionKey,
        operatorProfileId: bobClient.authenticatedUserProfile?.profileId,
      });
      if (!bobSource || !bobOrigin) {
        throw new Error("Expected real selected Bob source");
      }
      const participants = createReplyTurnParticipants({
        operatorAuthority: source.authority,
        requesterOrigin: origin,
      });
      participants.accept({ operatorAuthority: bobSource.authority, requesterOrigin: bobOrigin });
      const expectedOrigin =
        boundary === "selected Bob"
          ? { ...bobOrigin, delegatedCreatorProfileId: source.authority.profileId }
          : origin;
      const peerWaiting = createDeferredCore();
      const releasePeer = createDeferredCore();
      const returned = createDeferredCore();
      const effects: Array<{
        origin: ReturnType<typeof captureRequesterOrigin>;
        profileId: string | undefined;
        scopes: readonly string[] | undefined;
        receipt: unknown;
        invocation: unknown;
        fullPermission: unknown;
        delivery: unknown;
        request: Parameters<AgentToolGatewayRequestCaller>[0];
      }> = [];
      const callGateway: AgentToolGatewayRequestCaller = async <T>(
        request: Parameters<AgentToolGatewayRequestCaller>[0],
      ) => {
        if (request.method === "agent.wait") {
          peerWaiting.resolve();
          await releasePeer.promise;
          return {
            status: "ok",
            terminalReply: { disposition: "visible", text: "Synthetic peer result" },
          } as T;
        }
        request.sessionMutationCommitGuard?.();
        request.assertDispatchCurrent?.();
        if (
          request.method === "agent" &&
          isRecord(request.params) &&
          request.params.sessionKey === sessionKey
        ) {
          const caller = getGatewayToolCallerIdentity();
          effects.push({
            origin: caller?.requesterOrigin,
            profileId: caller?.operatorAuthority?.profileId,
            scopes: caller?.operatorAuthority?.scopes,
            receipt: caller?.receiptAuthority,
            invocation: caller?.operationalRunInstance,
            fullPermission: caller?.fullPermission,
            delivery: readSessionSendDeliveryAdmission({
              agentId: "main",
              sessionKey,
              sessionId: requesterEntry.sessionId,
              runId: String(request.params.idempotencyKey),
            })?.delivery,
            request,
          });
        }
        return { runId: isRecord(request.params) ? request.params.idempotencyKey : undefined } as T;
      };
      const originalContinuation = continuation.runWithGatewayToolContinuationContext;
      vi.spyOn(continuation, "runWithGatewayToolContinuationContext").mockImplementation(
        async <T>(run: () => Promise<T>, options?: { retainRequester?: true }): Promise<T> => {
          try {
            return await originalContinuation(run, options);
          } finally {
            returned.resolve();
          }
        },
      );
      try {
        await withPluginRuntimeGatewayRequestScope(
          {
            client,
            context,
            resolveGatewayContext,
            hasCurrentClientAuthority: device.isCurrent,
            isWebchatConnect: () => false,
          },
          () =>
            withOperatorToolGatewayAuthority({ scopes: client.connect.scopes ?? [] }, () =>
              withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey,
                  requesterOrigin: origin,
                  operatorAuthority: source.authority,
                  operationalRunInstance: createOperationalRunInstanceRef("closed-invocation"),
                  receiptAuthority: () => receiptCurrent,
                  fullPermission: true,
                  personalToolParticipants: participants,
                },
                () =>
                  withGatewayPersonalToolUser(
                    boundary === "selected Bob" ? bobSource.authority.profileId : undefined,
                    async () => {
                      const endpoint = (key: string) =>
                        readSessionCommunicationEndpoint({
                          config: cfg,
                          endpoint: { agentId: "main", sessionKey: key, storePath: "" },
                          assertCurrent: source.authority.assertCurrent,
                        });
                      const [requester, peer] = await Promise.all([
                        endpoint(sessionKey),
                        endpoint(peerKey),
                      ]);
                      const inputProvenance = {
                        kind: "inter_session" as const,
                        sourceTool: "sessions_send",
                        sourceSessionKey: sessionKey,
                      };
                      const accepted = await prepareSessionsSendCommunication({
                        config: cfg,
                        source: requester,
                        target: peer,
                        message: "Synthetic request",
                        inputProvenance,
                        assertSourceCurrent: source.authority.assertCurrent,
                        callGateway,
                      });
                      try {
                        await accepted.callGateway({
                          method: "agent",
                          params: {
                            agentId: "main",
                            sessionKey: peerKey,
                            message: "Synthetic request",
                            inputProvenance,
                            idempotencyKey: "synthetic-peer-run",
                          },
                        });
                        const requesterTarget = await createSessionsSendSessionReaders(
                          cfg,
                        ).readRequester(sessionKey, "main");
                        if (!requesterTarget) {
                          throw new Error("Canonical requester target unavailable");
                        }
                        const replyContext = prepareSessionsSendReplyContext({
                          callerOwnsCompletion: false,
                          requesterIsSubagent: false,
                          ownedTask: false,
                          isIsolatedCronRequester: false,
                          targetIsSubagent: false,
                          requesterSessionKey: sessionKey,
                          targetSession: peerEntry,
                          requesterTarget,
                          context: {
                            callGateway,
                            targetSessionKey: peerKey,
                            targetAgentId: "main",
                            replyAdmission: accepted.captureReplyAdmission("synthetic-peer-run"),
                            displayKey: "synthetic-peer",
                            replyTimeoutMs: 1_000,
                            requesterSessionKey: sessionKey,
                            requesterAgentId: "main",
                          },
                        });
                        await startSessionsSendReplyFlow({
                          ...replyContext,
                          skip: false,
                          runId: "synthetic-peer-run",
                        });
                        await peerWaiting.promise;
                      } finally {
                        accepted.close();
                      }
                    },
                  ),
              ),
            ),
        );
        // The peer returns only after ordinary invocation and transport ownership end.
        receiptCurrent = false;
        connected = false;
        source.release();
        device.release();
        bobConnected = false;
        bobSource.release();
        bobDevice.release();
        participants.close();
        if (boundary === "revoked") {
          invalidateGatewayDeviceRevocation(context, "synthetic-peer-device", "operator");
        } else if (boundary === "session changed") {
          await replaceSessionEntry(
            { agentId: "main", sessionKey },
            { ...requesterEntry, lifecycleRevision: "requester-v2" },
          );
        }
        releasePeer.resolve();
        await returned.promise;
        if (boundary === "revoked" || boundary === "session changed") {
          expect(effects).toEqual([]);
          return;
        }
        expect(effects).toHaveLength(1);
        expect(effects[0]).toMatchObject({
          origin: expectedOrigin,
          profileId:
            boundary === "selected Bob"
              ? bobSource.authority.profileId
              : source.authority.profileId,
          scopes: ["operator.read", "operator.write"],
          receipt: undefined,
          invocation: undefined,
          fullPermission: undefined,
          delivery: {
            source: { sessionKey: peerKey, sessionId: peerEntry.sessionId },
            target: { sessionKey, sessionId: requesterEntry.sessionId },
            returnedResult: { extraSystemPrompt: expect.stringContaining("delivered once") },
          },
          request: {
            replyExpectation: "optional",
            agentToolCaller: { agentId: "main", sessionKey, requesterOrigin: expectedOrigin },
            params: {
              sessionKey,
              expectedExistingSessionId: requesterEntry.sessionId,
              expectedExistingSessionLifecycleRevision: requesterEntry.lifecycleRevision,
              inputProvenance: { sourceSessionKey: peerKey, sourceTool: "sessions_send" },
            },
          },
        });
      } finally {
        releasePeer.resolve();
        source.release();
        device.release();
        bobSource.release();
        bobDevice.release();
        participants.close();
      }
    });
  },
);
