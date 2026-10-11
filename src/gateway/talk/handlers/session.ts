import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkSessionAcknowledgeMarkParams,
  validateTalkSessionAppendAudioParams,
  validateTalkSessionCancelOutputParams,
  validateTalkSessionCloseParams,
  validateTalkSessionCreateParams,
  validateTalkSessionSteerParams,
  validateTalkSessionSubmitToolResultParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import { assertSecretOwnerAvailable } from "../../../secrets/runtime-degraded-state.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../../talk/agent-run-control-shared.js";
import { ensureClientVoiceAgentSessionEntry } from "../../../talk/client-voice-session-write.js";
import {
  projectInternalRealtimeVoicePublicConfig,
  resolveInternalRealtimeVoiceGatewayRelayLaunchError,
} from "../../../talk/provider-internal.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../../talk/provider-resolver.js";
import { ADMIN_SCOPE, hasGatewayAdminScope } from "../../operator-scopes.js";
import { resolveSandboxedSessionCreation } from "../../operator-session-run.js";
import { readGatewayRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import type { GatewayRequestHandlers, RespondFn } from "../../server-methods/types.js";
import { defineValidatedGatewayHandler } from "../../server-methods/validation.js";
import { resolveOperatorSessionCreation } from "../../session-creation-provenance.js";
import { getSessionRowProjection } from "../../session-row-projection-access.js";
import { withPreparedSessionResolve } from "../../sessions-resolve.js";
import { resolveTalkAgentConsultAuthority } from "../client-gateway-control.js";
import { createTalkHandoff, getTalkHandoff, revokeTalkHandoff } from "../handoff.js";
import {
  acknowledgeTalkRealtimeRelayMark,
  cancelTalkRealtimeRelayTurn,
  sendTalkRealtimeRelayAudio,
  steerTalkRealtimeRelayAgentRun,
  stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult,
} from "../relay/operations.js";
import { createTalkRealtimeRelaySession } from "../relay/session-create.js";
import { talkRequestError } from "../request-error.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  buildTalkTranscriptionConfig,
  resolveConfiguredRealtimeTranscriptionProvider,
  resolveTalkRealtimeProviderInstructions,
} from "../session-config.js";
import {
  buildTalkRealtimeHistoryInstructions,
  readTalkRealtimeInitialItems,
} from "../session-history.js";
import {
  forgetUnifiedTalkSession,
  getUnifiedTalkSession,
  rememberUnifiedTalkSession,
  requireUnifiedTalkSessionConn,
} from "../session-registry.js";
import { requirePreparedTalkSessionTarget } from "../session-target.js";
import {
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "../transcription-relay.js";
import { prepareTalkVoiceReplacement } from "../voice-selection.js";

function respondInvalidRequest(respond: RespondFn, message: string) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

const talkSessionError = (error: unknown) => talkRequestError(error, "session");

function respondOk(respond: RespondFn, payload: unknown = { ok: true }) {
  respond(true, payload, undefined);
}

export const talkSessionHandlers: GatewayRequestHandlers = {
  "talk.session.create": defineValidatedGatewayHandler(
    "talk.session.create",
    validateTalkSessionCreateParams,
    async (request) => {
      const {
        params,
        respond,
        context,
        client,
        sessionMutationAuthorization,
        sessionMutationCommitGuard,
      } = request;
      const requester = readGatewayRequestMutationAuthority(request);
      const mode = params.mode ?? (params.transport === "managed-room" ? "stt-tts" : "realtime");
      const transport = params.transport ?? (mode === "stt-tts" ? "managed-room" : "gateway-relay");
      const brain = params.brain ?? (mode === "transcription" ? "none" : "agent-consult");

      if (transport === "webrtc" || transport === "provider-websocket") {
        respondInvalidRequest(
          respond,
          `talk.session.create is Gateway-managed; use talk.client.create for client transport "${transport}"`,
        );
        return;
      }
      try {
        sessionMutationAuthorization?.assertCurrent();
        if (params.voiceChangeId && (mode !== "realtime" || transport !== "gateway-relay")) {
          respondInvalidRequest(respond, "A voice replacement requires a realtime relay session");
          return;
        }
        if (transport === "managed-room") {
          if (brain === "direct-tools" && !hasGatewayAdminScope(client)) {
            respondInvalidRequest(
              respond,
              `talk.session.create brain="direct-tools" requires gateway scope: ${ADMIN_SCOPE}`,
            );
            return;
          }
          const spawnedBy = normalizeOptionalString(params.spawnedBy);
          const requestedSessionKey = normalizeOptionalString(params.sessionKey);
          if (requestedSessionKey && !spawnedBy && !hasGatewayAdminScope(client)) {
            respondInvalidRequest(
              respond,
              `talk.session.create managed-room sessionKey requires spawnedBy or gateway scope: ${ADMIN_SCOPE}`,
            );
            return;
          }
          const target = requestedSessionKey
            ? requirePreparedTalkSessionTarget(sessionMutationAuthorization?.talkSessionTarget)
            : undefined;
          sessionMutationAuthorization?.assertCurrent();
          const projection = getSessionRowProjection(context);
          if (!projection) {
            respondInvalidRequest(respond, "Session rows are initializing; try again");
            return;
          }
          return await withPreparedSessionResolve(
            {
              projection,
              client,
              isCurrent: () => getSessionRowProjection(context) === projection,
              p: {
                key: target?.canonicalKey,
                ...(target ? { agentId: target.agentId } : {}),
                ...(spawnedBy ? { spawnedBy } : {}),
                includeGlobal: true,
                includeUnknown: true,
              },
            },
            (resolvedSession) => {
              if (!resolvedSession.ok) {
                respond(false, undefined, resolvedSession.error);
                return;
              }
              if ("missing" in resolvedSession || "ambiguous" in resolvedSession) {
                respondInvalidRequest(respond, `No session found: ${params.sessionKey}`);
                return;
              }
              sessionMutationCommitGuard?.();
              sessionMutationAuthorization?.assertCurrent();
              const handoff = createTalkHandoff({
                sessionKey: resolvedSession.key,
                provider: normalizeOptionalString(params.provider),
                model: normalizeOptionalString(params.model),
                voice: normalizeOptionalString(params.voice),
                mode,
                transport,
                brain,
                ttlMs: params.ttlMs,
              });
              rememberUnifiedTalkSession(handoff.id, {
                kind: "managed-room",
                handoffId: handoff.id,
                roomId: handoff.roomId,
              });
              return respondOk(respond, {
                sessionId: handoff.id,
                provider: handoff.provider,
                mode: handoff.mode,
                transport: handoff.transport,
                brain: handoff.brain,
                handoffId: handoff.id,
                roomId: handoff.roomId,
                roomUrl: handoff.roomUrl,
                token: handoff.token,
                model: handoff.model,
                voice: handoff.voice,
                expiresAt: handoff.expiresAt,
              });
            },
          );
        }

        const connId = client?.connId;
        if (!connId) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "Talk session unavailable"));
          return;
        }

        if (mode === "realtime") {
          if (transport !== "gateway-relay" || brain !== "agent-consult") {
            return respondInvalidRequest(
              respond,
              `realtime talk.session.create requires transport="gateway-relay" and brain="agent-consult"`,
            );
          }
          const replacement = prepareTalkVoiceReplacement({
            voiceChangeId: params.voiceChangeId,
            connId,
            sessionKey: params.sessionKey,
          });
          const requested = replacement ? { ...params, ...replacement.launch } : params;
          const runtimeConfig = context.getRuntimeConfig();
          const realtimeConfig = buildTalkRealtimeConfig(
            runtimeConfig,
            requested.provider,
            requested.model,
          );
          const launchOptions = buildRealtimeVoiceLaunchOptions({
            requested,
            defaults: realtimeConfig,
          });
          const target = requirePreparedTalkSessionTarget(
            sessionMutationAuthorization?.talkSessionTarget,
          );
          replacement?.assertCurrent(target);
          const { agentId } = target;
          const assertCommitAllowed = composeSessionSourceAssertion(
            [sessionMutationCommitGuard, sessionMutationAuthorization?.assertCurrent],
            (assertSources) => {
              assertSources();
              replacement?.assertCurrent(target);
            },
          );
          assertCommitAllowed();
          assertSecretOwnerAvailable("capability", "talk:realtime");
          const resolution = resolveConfiguredRealtimeVoiceProvider({
            configuredProviderId: realtimeConfig.provider,
            providerConfigs: realtimeConfig.providers,
            providerConfigOverrides: launchOptions.model ? { model: launchOptions.model } : {},
            cfg: runtimeConfig,
            agentId,
            defaultModel: realtimeConfig.model,
            surface: "gateway-relay",
            autoRespondToAudio: realtimeConfig.consultRouting !== "force-agent-consult",
          });
          const forceAgentConsultOnFinalTranscript =
            realtimeConfig.consultRouting === "force-agent-consult";
          const { model: _model, ...overrides } = launchOptions;
          const providerConfig =
            Object.keys(overrides).length > 0
              ? { ...resolution.providerConfig, ...overrides }
              : resolution.providerConfig;
          const launchError = resolveInternalRealtimeVoiceGatewayRelayLaunchError({
            provider: resolution.provider,
            cfg: runtimeConfig,
            providerConfig,
            model: launchOptions.model,
            autoRespondToAudio: !forceAgentConsultOnFinalTranscript,
          });
          if (launchError) {
            // GPT-Live delegates natively; forced transcript consults are a GA-model mode.
            return respondInvalidRequest(respond, launchError);
          }
          const capabilities = resolution.capabilities;
          const controlSource =
            capabilities?.handlesAgentConsult === true ? "delegation" : "transcript";
          const providerInstructions = await resolveTalkRealtimeProviderInstructions({
            config: runtimeConfig,
            agentId,
            configuredInstructions: realtimeConfig.instructions,
            sessionKey: target.canonicalKey,
            warn: (message) => context.logGateway.warn(`talk realtime context: ${message}`),
          });
          assertCommitAllowed();
          const ensuredSessionId = await ensureClientVoiceAgentSessionEntry({
            agentId,
            sessionKey: target.canonicalKey,
            storePath: target.storePath,
            creation:
              resolveSandboxedSessionCreation(client, runtimeConfig) ??
              resolveOperatorSessionCreation(client),
            requester: composeSessionSourceAssertion([
              requester.assertCurrent,
              replacement?.source(target).assertCurrent,
            ]),
            source: sessionMutationAuthorization?.assertCurrent,
            prepareWorkerGrant: sessionMutationAuthorization?.prepareWorkerGrant,
            assertCurrent: requester.assertPreparationCurrent,
            onCommittedSource: (readSource, entry) =>
              sessionMutationAuthorization?.recordCreatedSession?.({
                agentId,
                sessionKey: target.canonicalKey,
                storePath: target.storePath,
                sessionId: entry.sessionId,
                lifecycleRevision: entry.lifecycleRevision,
                readSource,
              }),
          });
          const assertEnsuredTargetCurrent = () => {
            sessionMutationCommitGuard?.();
            sessionMutationAuthorization?.assertTargetCurrent({
              agentId,
              sessionKey: target.canonicalKey,
              ensuredSessionId,
            });
            replacement?.assertCurrent(target);
          };
          const initialItems = replacement
            ? await readTalkRealtimeInitialItems(target, assertEnsuredTargetCurrent)
            : [];
          assertEnsuredTargetCurrent();
          const model =
            normalizeOptionalString(providerConfig.model) ?? resolution.provider.defaultModel;
          const voices = [
            ...(capabilities?.voices ??
              (model ? capabilities?.voicesByModel?.[model] : undefined) ??
              resolution.provider.voices ??
              []),
          ];
          const session = createTalkRealtimeRelaySession({
            context,
            connId,
            cfg: runtimeConfig,
            consultAuthority: resolveTalkAgentConsultAuthority(client?.connect?.scopes, client),
            provider: resolution.provider,
            providerConfig,
            controlSource,
            capabilities,
            clientCapabilities: params.capabilities,
            voiceChangeId: params.voiceChangeId,
            initialItems,
            voiceSelectionVoices: voices,
            instructions:
              (controlSource === "delegation"
                ? (providerInstructions ?? "")
                : buildRealtimeInstructions(providerInstructions)) +
              buildTalkRealtimeHistoryInstructions(initialItems),
            tools:
              controlSource === "delegation"
                ? []
                : [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL],
            model: launchOptions.model,
            sessionTarget: target,
            voice: launchOptions.voice,
            language: params.language,
            forceAgentConsultOnFinalTranscript,
          });
          rememberUnifiedTalkSession(session.relaySessionId, {
            kind: "realtime-relay",
            connId,
            relaySessionId: session.relaySessionId,
            sessionTarget: target,
          });
          const publicSession = projectInternalRealtimeVoicePublicConfig({
            provider: resolution.provider,
            providerConfig,
            config: session,
          });
          return respondOk(respond, {
            ...publicSession,
            sessionId: session.relaySessionId,
            voiceSessionId: session.relaySessionId,
            mode,
            brain,
          });
        }

        if (mode === "transcription") {
          if (transport !== "gateway-relay" || brain !== "none") {
            respondInvalidRequest(
              respond,
              `transcription talk.session.create requires transport="gateway-relay" and brain="none"`,
            );
            return;
          }
          const runtimeConfig = context.getRuntimeConfig();
          const transcriptionConfig = buildTalkTranscriptionConfig(
            runtimeConfig,
            params.provider,
            params.model,
          );
          const resolution = resolveConfiguredRealtimeTranscriptionProvider({
            config: runtimeConfig,
            configuredProviderId: transcriptionConfig.provider,
            providerConfigs: transcriptionConfig.providers,
            requestedModel: normalizeOptionalString(params.model),
            defaultModel: transcriptionConfig.model,
          });
          const session = createTalkTranscriptionRelaySession({
            context,
            connId,
            provider: resolution.provider,
            providerConfig: resolution.providerConfig,
          });
          rememberUnifiedTalkSession(session.transcriptionSessionId, {
            kind: "transcription-relay",
            connId,
            transcriptionSessionId: session.transcriptionSessionId,
          });
          respondOk(respond, {
            ...session,
            sessionId: session.transcriptionSessionId,
            brain,
          });
          return;
        }

        respondInvalidRequest(
          respond,
          `stt-tts talk.session.create requires transport="managed-room"`,
        );
      } catch (err) {
        respond(false, undefined, talkSessionError(err));
      }
    },
  ),
  "talk.session.appendAudio": defineValidatedGatewayHandler(
    "talk.session.appendAudio",
    validateTalkSessionAppendAudioParams,
    async ({ params, respond, client }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        await sendTalkRealtimeRelayAudio({
          relaySessionId: session.relaySessionId,
          connId,
          audioBase64: params.audioBase64,
          timestamp: params.timestamp,
        });
      } else if (session.kind === "transcription-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        sendTalkTranscriptionRelayAudio({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
          audioBase64: params.audioBase64,
        });
      } else {
        respondInvalidRequest(
          respond,
          "talk.session.appendAudio is not supported for managed-room sessions",
        );
        return;
      }
      respondOk(respond);
    },
    talkSessionError,
  ),
  "talk.session.cancelOutput": defineValidatedGatewayHandler(
    "talk.session.cancelOutput",
    validateTalkSessionCancelOutputParams,
    async ({ params, respond, client }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "realtime-relay") {
        respondInvalidRequest(respond, "talk.session.cancelOutput requires realtime relay");
        return;
      }
      const connId = requireUnifiedTalkSessionConn(session, client?.connId);
      const result = await cancelTalkRealtimeRelayTurn({
        relaySessionId: session.relaySessionId,
        connId,
        reason: normalizeOptionalString(params.reason) ?? "output-cancelled",
        turnId: normalizeOptionalString(params.turnId),
      });
      respondOk(respond, { ok: true, ...result });
    },
    talkSessionError,
  ),
  "talk.session.acknowledgeMark": defineValidatedGatewayHandler(
    "talk.session.acknowledgeMark",
    validateTalkSessionAcknowledgeMarkParams,
    ({ params, respond, client }) => {
      try {
        const session = getUnifiedTalkSession(params.sessionId);
        if (session.kind !== "realtime-relay") {
          respondInvalidRequest(respond, "talk.session.acknowledgeMark requires realtime relay");
          return;
        }
        acknowledgeTalkRealtimeRelayMark({
          relaySessionId: session.relaySessionId,
          connId: requireUnifiedTalkSessionConn(session, client?.connId),
          markName: params.markName,
        });
        respondOk(respond);
      } catch (error) {
        respond(false, undefined, talkRequestError(error, "legacy-relay"));
      }
    },
  ),
  "talk.session.submitToolResult": defineValidatedGatewayHandler(
    "talk.session.submitToolResult",
    validateTalkSessionSubmitToolResultParams,
    async ({ params, respond, client }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind !== "realtime-relay") {
        respondInvalidRequest(
          respond,
          "talk.session.submitToolResult is only supported for realtime relay sessions",
        );
        return;
      }
      const connId = requireUnifiedTalkSessionConn(session, client?.connId);
      await submitTalkRealtimeRelayToolResult({
        relaySessionId: session.relaySessionId,
        connId,
        callId: params.callId,
        result: params.result,
        options: params.options,
      });
      respondOk(respond);
    },
    talkSessionError,
  ),
  "talk.session.steer": defineValidatedGatewayHandler(
    "talk.session.steer",
    validateTalkSessionSteerParams,
    async ({ params, respond, client, sessionMutationAuthorization }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        const assertCurrent = () => {
          sessionMutationAuthorization?.assertCurrent();
          if (
            getUnifiedTalkSession(params.sessionId) !== session ||
            (sessionMutationAuthorization?.talkSessionTarget &&
              sessionMutationAuthorization.talkSessionTarget !== session.sessionTarget)
          ) {
            throw new Error("Talk session changed while steering the agent run");
          }
        };
        assertCurrent();
        const result = await steerTalkRealtimeRelayAgentRun({
          relaySessionId: session.relaySessionId,
          connId,
          authority: resolveTalkAgentConsultAuthority(client?.connect?.scopes, client),
          sessionKey: normalizeOptionalString(params.sessionKey),
          text: params.text,
          mode: params.mode,
          assertCurrent,
        });
        respondOk(respond, result);
        return;
      }
      if (session.kind === "transcription-relay") {
        respondInvalidRequest(respond, "talk.session.steer requires an agent-backed Talk session");
        return;
      }
      // Managed rooms have no client admission route; creating a handoff grants no run authority.
      if (client?.connId) {
        getTalkHandoff(session.handoffId);
      }
      respondInvalidRequest(
        respond,
        "talk.session.steer requires the active managed-room connection",
      );
    },
    talkSessionError,
  ),
  "talk.session.close": defineValidatedGatewayHandler(
    "talk.session.close",
    validateTalkSessionCloseParams,
    async ({ params, respond, client }) => {
      const session = getUnifiedTalkSession(params.sessionId);
      if (session.kind === "realtime-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        await stopTalkRealtimeRelaySession({ relaySessionId: session.relaySessionId, connId });
      } else if (session.kind === "transcription-relay") {
        const connId = requireUnifiedTalkSessionConn(session, client?.connId);
        stopTalkTranscriptionRelaySession({
          transcriptionSessionId: session.transcriptionSessionId,
          connId,
        });
      } else {
        getTalkHandoff(session.handoffId);
        revokeTalkHandoff(session.handoffId);
      }
      forgetUnifiedTalkSession(params.sessionId);
      respondOk(respond);
    },
    talkSessionError,
  ),
};
