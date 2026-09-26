import { randomUUID } from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkClientCreateParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  AgentSelectionRequiredError,
  resolveAgentWorkspaceDir,
} from "../../../agents/agent-scope.js";
import { assertSecretOwnerAvailable } from "../../../secrets/runtime-degraded-state.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../../talk/agent-run-control-shared.js";
import {
  appendClientVoiceTranscript,
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
  flushClientVoiceSessionWrites,
} from "../../../talk/client-voice-session.js";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL } from "../../../talk/describe-view-tool.js";
import {
  cancelInternalRealtimeVoiceBrowserSession,
  projectInternalRealtimeVoicePublicConfig,
  type InternalRealtimeVoiceBrowserSessionCreateRequest,
} from "../../../talk/provider-internal.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../../talk/provider-resolver.js";
import { resolveSandboxedSessionCreation } from "../../operator-role-policy.js";
import { resolveOperatorSessionCreation } from "../../server-methods/session-creation-provenance.js";
import type { GatewayRequestHandler } from "../../server-methods/types.js";
import { assertValidParams } from "../../server-methods/validation.js";
import { SessionMutationAuthorizationChangedError } from "../../session-sharing.js";
import { formatForLog } from "../../ws-log.js";
import { createTalkClientAgentConsultRunner } from "../client-agent-consult.js";
import {
  createTalkClientGatewayControlOwner,
  resolveTalkAgentConsultAuthority,
} from "../client-gateway-control.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  isUnsupportedBrowserWebRtcSession,
  resolveTalkRealtimeProviderInstructions,
} from "../session-config.js";
import { readTalkRealtimeInitialItems } from "../session-history.js";
import { requirePreparedTalkSessionTarget } from "../session-target.js";
import {
  markTalkVoiceSessionReady,
  prepareTalkVoiceReplacement,
  registerTalkVoiceSession,
} from "../voice-selection.js";
import {
  forgetLegacyVoiceBinding,
  rememberLegacyVoiceBinding,
} from "./client-legacy-voice-bindings.js";

const REALTIME_VOICE_CLIENT_SESSION_MIN_TTL_MS = 5_000;

export const createTalkClient: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
  sessionMutationAuthorization,
  sessionMutationCommitGuard,
}) => {
  if (!assertValidParams(params, validateTalkClientCreateParams, "talk.client.create", respond)) {
    return;
  }
  const rejectRequest = (code: Parameters<typeof errorShape>[0], message: string): void =>
    respond(false, undefined, errorShape(code, message));
  try {
    sessionMutationAuthorization?.assertCurrent();
    if (params.voiceChangeId && params.voiceSessionId) {
      return rejectRequest(
        ErrorCodes.INVALID_REQUEST,
        "A voice replacement requires a fresh voice session id",
      );
    }
    const replacement = prepareTalkVoiceReplacement({
      voiceChangeId: params.voiceChangeId,
      connId: client?.connId,
      sessionKey: params.sessionKey,
    });
    const requested = replacement
      ? {
          ...params,
          provider: replacement.provider,
          model: replacement.model,
          voice: replacement.voice,
        }
      : params;
    const runtimeConfig = context.getRuntimeConfig();
    const realtimeConfig = buildTalkRealtimeConfig(
      runtimeConfig,
      requested.provider,
      requested.model,
    );
    const mode = normalizeOptionalLowercaseString(params.mode) ?? realtimeConfig.mode ?? "realtime";
    if (mode !== "realtime") {
      return rejectRequest(
        ErrorCodes.INVALID_REQUEST,
        `talk.client.create only supports mode="realtime"; use talk.catalog for ${mode} provider discovery`,
      );
    }
    const brain =
      normalizeOptionalLowercaseString(params.brain) ?? realtimeConfig.brain ?? "agent-consult";
    if (brain !== "agent-consult") {
      return rejectRequest(
        ErrorCodes.INVALID_REQUEST,
        `talk.client.create only supports brain="agent-consult"`,
      );
    }
    const transport =
      normalizeOptionalLowercaseString(params.transport) ?? realtimeConfig.transport;
    const wantsCameraFrames = params.capabilities?.includes("camera-frame") === true;
    const wantsGatewayControl = params.capabilities?.includes("gateway-control-v1") === true;
    const clientControl = wantsGatewayControl ? { owner: "gateway" as const } : undefined;
    if (wantsGatewayControl && wantsCameraFrames) {
      return rejectRequest(
        ErrorCodes.INVALID_REQUEST,
        "gateway-control-v1 supports audio-only WebRTC sessions",
      );
    }
    if (transport === "managed-room") {
      return rejectRequest(
        ErrorCodes.UNAVAILABLE,
        "managed-room realtime Talk sessions are not available in the browser UI yet",
      );
    }
    if (transport === "gateway-relay") {
      return rejectRequest(
        ErrorCodes.INVALID_REQUEST,
        wantsCameraFrames
          ? "gateway-relay does not support browser video frames"
          : `talk.client.create is client-owned; use talk.session.create for gateway-relay`,
      );
    }
    const launchOptions = buildRealtimeVoiceLaunchOptions({
      requested,
      defaults: realtimeConfig,
    });
    const target = requirePreparedTalkSessionTarget(
      sessionMutationAuthorization?.talkSessionTarget,
    );
    replacement?.assertCurrent(target);
    const { agentId, sessionKey } = target;
    const sessionTarget = { agentId, sessionKey: target.canonicalKey, storePath: target.storePath };
    assertSecretOwnerAvailable("capability", "talk:realtime");
    const resolution = resolveConfiguredRealtimeVoiceProvider({
      configuredProviderId: realtimeConfig.provider,
      providerConfigs: realtimeConfig.providers,
      ...(launchOptions.model ? { providerConfigOverrides: { model: launchOptions.model } } : {}),
      cfg: runtimeConfig,
      agentId,
      defaultModel: realtimeConfig.model,
      surface: "browser-session",
      requiredCapabilities: { supportsVideoFrames: wantsCameraFrames },
      clientControl,
    });
    const providerCapabilities = resolution.capabilities;
    if (wantsGatewayControl && providerCapabilities?.supportsGatewayControl !== true) {
      return rejectRequest(
        ErrorCodes.UNAVAILABLE,
        `Realtime provider "${resolution.provider.id}" does not support gateway-control-v1 with its configured authentication`,
      );
    }
    if (wantsCameraFrames && providerCapabilities?.supportsVideoFrames !== true) {
      return rejectRequest(
        ErrorCodes.INVALID_REQUEST,
        `Realtime provider ${resolution.provider.id} does not support browser video frames`,
      );
    }
    const providerInstructions = await resolveTalkRealtimeProviderInstructions({
      config: runtimeConfig,
      agentId,
      configuredInstructions: realtimeConfig.instructions,
      sessionKey: target.canonicalKey,
      warn: (message) => context.logGateway.warn(`talk realtime context: ${message}`),
    });
    sessionMutationAuthorization?.assertCurrent();
    replacement?.assertCurrent(target);
    if (resolution.provider.createBrowserSession) {
      const initialItems = await readTalkRealtimeInitialItems(target, () => {
        sessionMutationAuthorization?.assertCurrent();
        replacement?.assertCurrent(target);
      });
      sessionMutationAuthorization?.assertCurrent();
      replacement?.assertCurrent(target);
      const controlSource =
        providerCapabilities?.handlesAgentConsult === true ? "delegation" : "transcript";
      const tools =
        providerCapabilities?.supportsToolCalls === false
          ? []
          : [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL];
      if (wantsCameraFrames && tools.length > 0) {
        tools.push(REALTIME_VOICE_DESCRIBE_VIEW_TOOL);
      }
      const instructions =
        controlSource === "delegation"
          ? normalizeOptionalString(providerInstructions)
          : buildRealtimeInstructions(providerInstructions);
      const requestedVoiceSessionId = normalizeOptionalString(params.voiceSessionId);
      const ownsProvider =
        wantsGatewayControl || providerCapabilities?.handlesAgentConsult === true;
      let activeVoiceSessionId = ownsProvider
        ? (requestedVoiceSessionId ?? randomUUID())
        : undefined;
      let logicalSessionCreated = false;
      let unregisterVoiceSession: (() => void) | undefined;
      let providerReady = !ownsProvider;
      const ownerConnId = normalizeOptionalString(client?.connId);
      if (ownsProvider && !ownerConnId) {
        return rejectRequest(
          ErrorCodes.UNAVAILABLE,
          "Gateway-owned realtime sessions require a connected client",
        );
      }
      const closeLogicalSession = async () => {
        unregisterVoiceSession?.();
        if (!logicalSessionCreated) {
          return;
        }
        await closeClientVoiceSession({
          agentId,
          sessionKey,
          voiceSessionId: activeVoiceSessionId!,
          config: runtimeConfig,
        });
        if (ownerConnId) {
          forgetLegacyVoiceBinding(
            ownerConnId,
            params.sessionKey?.trim() || sessionKey,
            activeVoiceSessionId!,
          );
        }
      };
      const consultRunner = createTalkClientAgentConsultRunner({
        config: runtimeConfig,
        context,
        sessionTarget: target,
        ...(ownerConnId ? { ownerConnId } : {}),
        authority: resolveTalkAgentConsultAuthority(client?.connect?.scopes, client),
        getVoiceSessionId: () => activeVoiceSessionId,
        initialItems,
      });
      const gatewayControlOwner = ownsProvider
        ? createTalkClientGatewayControlOwner({
            voiceSessionId: activeVoiceSessionId!,
            providerId: resolution.provider.id,
            controlSource,
            supportsToolCalls: providerCapabilities?.supportsToolCalls,
            sessionTarget: target,
            connId: ownerConnId!,
            context,
            assertConnectionOpen: () => {
              const currentConnections = context.getClientConnIds?.(
                (candidate) => candidate === client,
              );
              if (!currentConnections?.has(ownerConnId!)) {
                throw new Error("Realtime voice client disconnected");
              }
            },
            runToolAgentConsult: consultRunner.runArgs,
            runAgentConsult: consultRunner.runOwnedArgs,
            getToolAuthorityOverlay: (source) =>
              consultRunner.getToolAuthorityOverlay(undefined, source),
            appendTranscript: ({ entryId, role, text, confirmation }) =>
              appendClientVoiceTranscript({
                agentId,
                sessionKey,
                sessionTarget,
                voiceSessionId: activeVoiceSessionId!,
                entryId,
                role,
                text,
                confirmation,
                config: runtimeConfig,
              }),
            flushTranscript: () =>
              flushClientVoiceSessionWrites({
                agentId,
                voiceSessionId: activeVoiceSessionId!,
              }),
            closeLogicalSession,
          })
        : undefined;
      const gatewayControl = gatewayControlOwner
        ? {
            ...gatewayControlOwner.control,
            onReady: () => {
              try {
                gatewayControlOwner.assertOpen();
              } catch {
                return;
              }
              providerReady = true;
              gatewayControlOwner.control.onReady?.();
              if (activeVoiceSessionId && ownerConnId) {
                markTalkVoiceSessionReady(activeVoiceSessionId, ownerConnId, agentId);
              }
            },
          }
        : undefined;
      // Native delegation can use lifecycle callbacks without negotiated control.
      // Keep the ownership claim and its required binding in one request variant.
      const controlRequest = gatewayControl
        ? clientControl
          ? { clientControl, gatewayControl }
          : { gatewayControl }
        : {};
      const browserSessionRequest: InternalRealtimeVoiceBrowserSessionCreateRequest = {
        cfg: runtimeConfig,
        agentId,
        ...(ownerConnId ? { ownerConnId } : {}),
        workspaceDir: resolveAgentWorkspaceDir(runtimeConfig, agentId),
        providerConfig: resolution.providerConfig,
        instructions,
        initialItems,
        runAgentConsult: gatewayControlOwner?.runAgentConsult ?? consultRunner.runPrompt,
        ...controlRequest,
        ...(tools.length > 0 ? { tools } : {}),
        ...launchOptions,
      };
      const assertCommitAllowed = () => {
        sessionMutationCommitGuard?.();
        sessionMutationAuthorization?.assertCurrent();
        replacement?.assertCurrent(target);
        gatewayControlOwner?.assertOpen();
      };
      let session: Awaited<ReturnType<typeof resolution.provider.createBrowserSession>> | undefined;
      let delivered = false;
      try {
        assertCommitAllowed();
        session = await resolution.provider.createBrowserSession(browserSessionRequest);
        const createdSession = session;
        await gatewayControlOwner?.adoptProvider(() =>
          cancelInternalRealtimeVoiceBrowserSession({
            provider: resolution.provider,
            request: browserSessionRequest,
            session: createdSession,
          }),
        );
        assertCommitAllowed();
        // Client-owned voice records are minted only for client-owned transports;
        // relay sessions are created via talk.session.create and keyed by relaySessionId.
        // Widening this guard would hand relay calls a mismatched voiceSessionId.
        if (
          (session.transport === "webrtc" || session.transport === "provider-websocket") &&
          !isUnsupportedBrowserWebRtcSession(session) &&
          (!transport || session.transport === transport)
        ) {
          const sessionEntryDeadlineAt =
            session.expiresAt === undefined
              ? undefined
              : session.expiresAt - REALTIME_VOICE_CLIENT_SESSION_MIN_TTL_MS;
          if (sessionEntryDeadlineAt !== undefined && Date.now() >= sessionEntryDeadlineAt) {
            throw new Error("Realtime browser session expired during startup; try again");
          }
          // Defer persistent session creation until the provider has returned a
          // usable client transport. The write boundary rechecks the credential
          // deadline so queued storage work cannot leave a phantom chat.
          const ensuredSessionId = await ensureClientVoiceAgentSessionEntry({
            ...sessionTarget,
            creation:
              resolveSandboxedSessionCreation(client, runtimeConfig) ??
              resolveOperatorSessionCreation(client),
            deadlineAt: sessionEntryDeadlineAt,
            assertCommitAllowed,
          });
          sessionMutationCommitGuard?.();
          sessionMutationAuthorization?.assertTargetCurrent({ ...sessionTarget, ensuredSessionId });
          replacement?.assertCurrent(target);
          gatewayControlOwner?.assertOpen();
          // Recovering 6h-abandoned calls (and retrying their digests) is not on the
          // start path; running it inline would delay use of time-sensitive provider
          // credentials behind slow channel sends. Fire it off the response path.
          void closeStaleClientVoiceSessions({
            agentId,
            config: runtimeConfig,
            excludeVoiceSessionId: normalizeOptionalString(params.voiceSessionId),
            warn: (message) => context.logGateway.warn(`talk voice session recovery: ${message}`),
          }).catch((error: unknown) =>
            context.logGateway.warn(`talk voice session recovery failed: ${formatForLog(error)}`),
          );
          const voiceSessionId = createOrResumeClientVoiceSession({
            agentId,
            sessionKey,
            provider: resolution.provider.id,
            origin: "client",
            // Deployed clients sent sessionKey before transcripts existed, so capability
            // must be negotiated explicitly; declaring it turns the confirmation gate on.
            transcriptCapable:
              wantsGatewayControl || params.capabilities?.includes("voice-transcript") === true,
            voiceSessionId: activeVoiceSessionId ?? requestedVoiceSessionId,
          });
          activeVoiceSessionId = voiceSessionId;
          logicalSessionCreated = true;
          const connId = ownerConnId;
          if (connId) {
            rememberLegacyVoiceBinding({
              connId,
              sessionKey: params.sessionKey?.trim() || sessionKey,
              voiceSessionId,
            });
          }
          gatewayControlOwner?.activate();
          const model =
            normalizeOptionalString(session.model) ??
            normalizeOptionalString(resolution.providerConfig.model) ??
            resolution.provider.defaultModel;
          const voice =
            normalizeOptionalString(session.voice) ??
            normalizeOptionalString(resolution.providerConfig.voice);
          const publicSession = projectInternalRealtimeVoicePublicConfig({
            provider: resolution.provider,
            providerConfig: resolution.providerConfig,
            config: { ...session, model, voice },
          });
          if (connId) {
            const voices = [
              ...(providerCapabilities?.voices ??
                (model ? providerCapabilities?.voicesByModel?.[model] : undefined) ??
                resolution.provider.voices ??
                []),
            ];
            unregisterVoiceSession = registerTalkVoiceSession({
              voiceSessionId,
              connId,
              sessionTarget: target,
              selection: {
                provider: session.provider,
                model: publicSession.model,
                voice: publicSession.voice,
                voices,
                canChange:
                  params.capabilities?.includes("voice-selection") === true && voices.length > 0,
              },
              launch: { provider: session.provider, model },
              voiceChangeId: params.voiceChangeId,
              providerReady,
            });
            if (gatewayControlOwner) {
              gatewayControlOwner.signal.addEventListener("abort", unregisterVoiceSession, {
                once: true,
              });
              if (gatewayControlOwner.signal.aborted) {
                unregisterVoiceSession();
              }
            }
          }
          respond(
            true,
            {
              ...publicSession,
              voiceSessionId,
              ...(clientControl ? { clientControl } : {}),
            },
            undefined,
          );
          delivered = true;
          return;
        }
        if (transport) {
          return rejectRequest(
            ErrorCodes.UNAVAILABLE,
            `Realtime provider "${resolution.provider.id}" does not support requested browser transport "${transport}"`,
          );
        }
      } finally {
        if (!delivered) {
          unregisterVoiceSession?.();
          try {
            if (gatewayControlOwner) {
              await gatewayControlOwner.close();
            } else if (session) {
              try {
                await cancelInternalRealtimeVoiceBrowserSession({
                  provider: resolution.provider,
                  request: browserSessionRequest,
                  session,
                });
              } finally {
                await closeLogicalSession();
              }
            }
          } catch (error) {
            context.logGateway.warn(`talk browser session cleanup failed: ${formatForLog(error)}`);
          }
        }
      }
    }
    rejectRequest(
      ErrorCodes.UNAVAILABLE,
      `Realtime provider "${resolution.provider.id}" does not support client-owned realtime sessions`,
    );
  } catch (err) {
    if (err instanceof SessionMutationAuthorizationChangedError) {
      respond(false, undefined, err.error);
      return;
    }
    respond(
      false,
      undefined,
      errorShape(
        err instanceof AgentSelectionRequiredError
          ? ErrorCodes.INVALID_REQUEST
          : ErrorCodes.UNAVAILABLE,
        formatForLog(err),
      ),
    );
  }
};
