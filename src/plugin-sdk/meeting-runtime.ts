import { formatErrorMessage } from "../infra/errors.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import { sleep } from "../utils/sleep.js";

export type MeetingVoiceCallGatewayClient = {
  request(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs: number },
  ): Promise<unknown>;
  stopAndWait(options: { timeoutMs: number }): Promise<void>;
};

export type MeetingVoiceCallGateway = {
  trustedPluginIdentity: boolean;
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
};

export type MeetingVoiceCallConfig = {
  gatewayUrl?: string;
  token?: string;
  requestTimeoutMs: number;
  postDtmfSpeechDelayMs: number;
};

export type MeetingVoiceCallSurface = {
  clientDisplayName: string;
  configPath: string;
  logScope: string;
  meetingLabel: string;
  providerLabel: string;
};

type VoiceCallStartResult = { callId?: string; initiated?: boolean; error?: string };
type VoiceCallSpeakResult = { success?: boolean; error?: string };
export type MeetingVoiceCallStatusResult = { found?: boolean; call?: unknown };
export type MeetingVoiceCallJoinResult = {
  callId: string;
  dtmfSent: boolean;
  introSent: boolean;
};

export function createMeetingVoiceCallGateway(params: {
  config: MeetingVoiceCallConfig;
  runtime: PluginRuntime;
  surface: MeetingVoiceCallSurface;
  connectClient: (params: {
    config: MeetingVoiceCallConfig;
    surface: MeetingVoiceCallSurface;
  }) => Promise<MeetingVoiceCallGatewayClient>;
}): MeetingVoiceCallGateway {
  if (!params.config.gatewayUrl) {
    return {
      trustedPluginIdentity: true,
      request: (method, requestParams) =>
        params.runtime.gateway.request(method, requestParams, {
          timeoutMs: params.config.requestTimeoutMs,
        }),
    };
  }
  return {
    trustedPluginIdentity: false,
    async request<T>(method: string, requestParams: Record<string, unknown>): Promise<T> {
      const client = await params.connectClient(params);
      try {
        return (await client.request(method, requestParams, {
          timeoutMs: params.config.requestTimeoutMs,
        })) as T; // SAFETY: The caller pairs the Gateway method with its response type, as on the local route.
      } finally {
        // Connection teardown must not replace an already-settled RPC result or error.
        await client.stopAndWait({ timeoutMs: 1_000 }).catch(() => {});
      }
    },
  };
}

export function isMeetingVoiceCallMissingError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  return message.includes("call not found") || message.includes("call is not active");
}

export async function joinMeetingViaVoiceCallGateway(params: {
  config: MeetingVoiceCallConfig;
  gateway: MeetingVoiceCallGateway;
  surface: MeetingVoiceCallSurface;
  dialInNumber: string;
  dtmfSequence?: string;
  logger?: RuntimeLogger;
  message?: string;
  requesterSessionKey?: string;
  agentId?: string;
  sessionKey?: string;
}): Promise<MeetingVoiceCallJoinResult> {
  const requiresTrustedAgentRouting = params.agentId && params.agentId !== "main";
  if (requiresTrustedAgentRouting && !params.gateway.trustedPluginIdentity) {
    throw new Error(
      `Per-agent Voice Call routing requires the local Gateway runtime. Remove ${params.surface.configPath} or omit agent routing.`,
    );
  }
  params.logger?.info(
    `${params.surface.logScope} Delegating ${params.surface.providerLabel} join to Voice Call (dtmf=${params.dtmfSequence ? "pre-connect" : "none"}, intro=${params.message ? "delayed" : "none"})`,
  );
  const start = await params.gateway.request<VoiceCallStartResult>("voicecall.start", {
    to: params.dialInNumber,
    mode: "conversation",
    ...(params.dtmfSequence ? { dtmfSequence: params.dtmfSequence } : {}),
    ...(params.requesterSessionKey ? { requesterSessionKey: params.requesterSessionKey } : {}),
    ...(params.agentId && params.gateway.trustedPluginIdentity ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
  if (!start.callId) {
    throw new Error(start.error || "voicecall.start did not return callId");
  }
  params.logger?.info(
    `${params.surface.logScope} Voice Call ${params.surface.providerLabel} phone leg started: callId=${start.callId}`,
  );
  const dtmfSent = Boolean(params.dtmfSequence);
  if (dtmfSent) {
    params.logger?.info(
      `${params.surface.logScope} ${params.surface.meetingLabel} DTMF queued before realtime connect: callId=${start.callId} digits=${params.dtmfSequence?.length ?? 0}`,
    );
  }
  let introSent = false;
  if (params.message) {
    const delayMs = params.dtmfSequence ? params.config.postDtmfSpeechDelayMs : 0;
    if (delayMs > 0) {
      params.logger?.info(
        `${params.surface.logScope} Waiting ${delayMs}ms after ${params.surface.meetingLabel} DTMF before speaking intro for callId=${start.callId}`,
      );
      await sleep(delayMs);
    }
    let spoken: VoiceCallSpeakResult;
    try {
      spoken = await params.gateway.request<VoiceCallSpeakResult>("voicecall.speak", {
        callId: start.callId,
        allowTwimlFallback: false,
        message: params.message,
      });
    } catch (error) {
      params.logger?.warn?.(
        `${params.surface.logScope} Skipped intro speech because realtime bridge was not ready: ${formatErrorMessage(error)}`,
      );
      spoken = { success: false };
    }
    if (spoken.success === false) {
      params.logger?.warn?.(
        `${params.surface.logScope} Skipped intro speech because realtime bridge was not ready: ${spoken.error || "voicecall.speak failed"}`,
      );
    } else {
      introSent = true;
      params.logger?.info(
        `${params.surface.logScope} Intro speech requested after ${params.surface.meetingLabel} dial sequence: callId=${start.callId}`,
      );
    }
  }
  return { callId: start.callId, dtmfSent, introSent };
}

export async function endMeetingVoiceCallGatewayCall(params: {
  gateway: MeetingVoiceCallGateway;
  callId: string;
}): Promise<void> {
  try {
    await params.gateway.request("voicecall.end", { callId: params.callId });
  } catch (error) {
    if (!isMeetingVoiceCallMissingError(error)) {
      throw error;
    }
  }
}

export async function getMeetingVoiceCallGatewayCall(params: {
  gateway: MeetingVoiceCallGateway;
  callId: string;
}): Promise<MeetingVoiceCallStatusResult> {
  return await params.gateway.request<MeetingVoiceCallStatusResult>("voicecall.status", {
    callId: params.callId,
  });
}

export async function speakMeetingViaVoiceCallGateway(params: {
  gateway: MeetingVoiceCallGateway;
  callId: string;
  message: string;
}): Promise<void> {
  const spoken = await params.gateway.request<VoiceCallSpeakResult>("voicecall.speak", {
    callId: params.callId,
    message: params.message,
  });
  if (spoken.success === false) {
    throw new Error(spoken.error || "voicecall.speak failed");
  }
}

export {
  startMeetingRealtimeEngine,
  type MeetingAgentConsultParams,
  type MeetingRealtimeAudioEngineHandle,
  type MeetingRealtimeAudioEngineHealth,
  type MeetingRealtimeEngineConfig,
  type MeetingRealtimeToolCallParams,
  type MeetingRuntimePlatform,
} from "../meeting-bot/realtime-engine.js";
export { startMeetingAgentRealtimeEngine } from "../meeting-bot/realtime-agent-engine.js";
export {
  type MeetingRealtimeAudioTransport,
  type MeetingRealtimeAudioTransportHealth,
} from "../meeting-bot/realtime-audio-transport.js";
export { createLocalMeetingRealtimeAudioTransport } from "../meeting-bot/realtime-local-audio-transport.js";
export { createNodeMeetingRealtimeAudioTransport } from "../meeting-bot/realtime-node-audio-transport.js";
export {
  convertMeetingTtsAudioForBridge,
  type MeetingRealtimeAudioFormat,
} from "../meeting-bot/realtime-audio-format.js";
export {
  MeetingSessionRuntime,
  type MeetingBrowserSessionView,
  type MeetingSessionLeaveResult,
  type MeetingSessionRuntimeHandles,
  type MeetingSessionRuntimeJoinContext,
  type MeetingSessionRuntimeMessages,
  type MeetingSessionRuntimeOptions,
} from "../meeting-bot/session-runtime.js";
export { createMeetingSession } from "../meeting-bot/session-factory.js";
export type {
  MeetingBrowserCandidateTab,
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingRealtimeSessionBlock,
  MeetingSessionRecord,
  MeetingSessionState,
  MeetingTranscriptLine,
  MeetingTranscriptSnapshot,
} from "../meeting-bot/session-types.js";
export {
  openMeetingWithBrowser,
  recoverMeetingBrowserTab,
  type MeetingBrowserControllerConfig,
} from "../meeting-bot/browser-controller.js";
export {
  leaveMeetingWithBrowser,
  readMeetingTranscriptWithBrowser,
} from "../meeting-bot/browser-session-control.js";
export {
  asMeetingBrowserTabs,
  readMeetingBrowserTab,
  resolveLocalMeetingBrowserRequest,
} from "../meeting-bot/browser-request.js";
export {
  callMeetingBrowserProxyOnNode,
  resolveMeetingBrowserNode,
  resolveMeetingBrowserNodeInfo,
  type MeetingBrowserNodeInfo,
} from "../meeting-bot/browser-node.js";
export type {
  MeetingBrowserJoinSession,
  MeetingBrowserLeaveStep,
  MeetingBrowserPermissionPlan,
  MeetingBrowserRequestCaller,
  MeetingBrowserRequestParams,
  MeetingBrowserStatusScriptParams,
  MeetingManualAction,
  MeetingManualActionCategory,
} from "../meeting-bot/platform-adapter.js";
export { MeetingPlatformAdapter } from "../meeting-bot/platform-adapter.js";
export { createMeetingRealtimeEngineBindings } from "../meeting-bot/agent-consult.js";
export {
  addMeetingSetupCheck,
  createMeetingSetupStatus,
  type MeetingSetupCheck,
  type MeetingSetupStatus,
} from "../meeting-bot/setup-checks.js";
export {
  buildMeetingSoxAudioCommands,
  type MeetingSoxAudioCommandParams,
  type MeetingSoxAudioFormat,
} from "../meeting-bot/sox-audio-command.js";
export {
  createMeetingBrowserNodeInvokePolicy,
  type MeetingBrowserNodePolicyOptions,
  type MeetingBrowserNodeStartConfig,
} from "../meeting-bot/node-invoke-policy.js";
export { createMeetingNodeHost, type MeetingNodeHostOptions } from "../meeting-bot/node-host.js";

export { runMeetingParticipationWithBrowser } from "../meeting-bot/participation-browser.js";
export type {
  MeetingParticipationRequest,
  MeetingParticipationSource,
  MeetingParticipationAttempt,
  MeetingBrowserParticipationAdapter,
} from "../meeting-bot/participation-types.js";
