import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { consultRealtimeVoiceAgent } from "../talk/agent-consult-runtime.js";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceAgentConsultToolPolicy,
} from "../talk/agent-consult-tool.js";
import type { RealtimeVoiceTool } from "../talk/provider-types.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";
import type {
  MeetingAgentConsultSurface,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";
import type {
  MeetingAgentConsultParams,
  MeetingRealtimeToolCallParams,
  MeetingRuntimePlatform,
} from "./realtime-engine.js";
import { readMeetingRealtimeToolAbortSignal } from "./realtime-tool-continuity.js";

export function createMeetingRealtimeEngineBindings(params: {
  platform: MeetingPlatformRuntimeMetadata;
  config: {
    realtime: {
      agentId?: string;
      toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
    };
  };
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
}): {
  platform: MeetingRuntimePlatform;
  consultAgent: (consult: MeetingAgentConsultParams) => Promise<{ text: string }>;
  tools: RealtimeVoiceTool[];
  handleToolCall: (call: MeetingRealtimeToolCallParams) => Promise<void>;
} {
  const surface: MeetingAgentConsultSurface = {
    id: params.platform.id,
    provider: params.platform.id,
    lane: params.platform.id,
    ...params.platform.agentConsult,
  };
  return {
    platform: {
      displayName: params.platform.displayName,
      logScope: params.platform.logScope,
      sessionIdPrefix: params.platform.id,
    },
    consultAgent: async (consult) =>
      await consultMeetingAgent({
        surface,
        config: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        agentId: params.config.realtime.agentId,
        toolPolicy: params.config.realtime.toolPolicy,
        ...consult,
      }),
    tools: resolveRealtimeVoiceAgentConsultTools(params.config.realtime.toolPolicy),
    handleToolCall: async (call) => {
      const abortSignal = readMeetingRealtimeToolAbortSignal(call.session);
      await handleMeetingRealtimeConsultToolCall({
        surface,
        config: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        agentId: params.config.realtime.agentId,
        toolPolicy: params.config.realtime.toolPolicy,
        abortSignal,
        ...call,
      });
    },
  };
}

async function submitMeetingConsultWorkingResponse(params: {
  session: RealtimeVoiceBridgeSession;
  abortSignal?: AbortSignal;
  callId: string;
  label: string;
}): Promise<void> {
  if (params.abortSignal?.aborted || !params.session.bridge.supportsToolResultContinuation) {
    return;
  }
  await params.session.submitToolResult(
    params.callId,
    buildRealtimeVoiceAgentConsultWorkingResponse(params.label),
    { willContinue: true },
  );
}

type MeetingAgentConsultContext = {
  surface: MeetingAgentConsultSurface;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  agentId?: string;
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
};

async function consultMeetingAgent(
  params: MeetingAgentConsultContext & MeetingAgentConsultParams,
): Promise<{ text: string }> {
  const agentId = params.agentId
    ? normalizeAgentId(params.agentId)
    : resolveDefaultAgentId(params.config);
  const requesterSessionKey =
    normalizeOptionalString(params.requesterSessionKey) ?? `agent:${agentId}:main`;
  const sessionKey = `agent:${agentId}:subagent:${params.surface.id}:${params.meetingSessionId}`;
  return await consultRealtimeVoiceAgent({
    cfg: params.config,
    agentRuntime: params.runtime.agent,
    logger: params.logger,
    agentId,
    sessionKey,
    messageProvider: params.surface.provider,
    lane: params.surface.lane,
    runIdPrefix: `${params.surface.id}:${params.meetingSessionId}`,
    spawnedBy: requesterSessionKey,
    contextMode: "fork",
    args: params.args,
    transcript: params.transcript,
    surface: params.surface.surface,
    userLabel: params.surface.userLabel,
    assistantLabel: params.surface.assistantLabel,
    questionSourceLabel: params.surface.questionSourceLabel,
    toolsAllow: resolveRealtimeVoiceAgentConsultToolsAllow(params.toolPolicy),
    extraSystemPrompt: params.surface.extraSystemPrompt,
    abortSignal: params.abortSignal,
  });
}

async function handleMeetingRealtimeConsultToolCall(
  params: MeetingAgentConsultContext &
    MeetingRealtimeToolCallParams & {
      abortSignal?: AbortSignal;
    },
): Promise<void> {
  const callId = params.event.callId || params.event.itemId;
  if (params.abortSignal?.aborted) {
    return;
  }
  const submitError = async (message: string) => {
    await params.session.submitToolResult(callId, { error: message });
    if (!params.abortSignal?.aborted) {
      params.onTalkEvent({
        type: "tool.error",
        callId,
        payload: { name: params.event.name, error: message },
        final: true,
      });
    }
  };
  const unavailableToolError =
    params.strategy !== "bidi"
      ? `Tool "${params.event.name}" is only available in bidi realtime strategy`
      : params.event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME
        ? `Tool "${params.event.name}" not available`
        : undefined;
  if (unavailableToolError) {
    await submitError(unavailableToolError);
    return;
  }
  await submitMeetingConsultWorkingResponse({
    session: params.session,
    abortSignal: params.abortSignal,
    callId,
    label: params.surface.workingResponseLabel,
  });
  if (params.abortSignal?.aborted) {
    return;
  }
  params.onTalkEvent({
    type: "tool.progress",
    callId,
    payload: { name: params.event.name, status: "working" },
  });
  let result: { text: string };
  try {
    result = await consultMeetingAgent({ ...params, args: params.event.args });
  } catch (error) {
    if (params.abortSignal?.aborted) {
      return;
    }
    await submitError(formatErrorMessage(error));
    return;
  }
  if (params.abortSignal?.aborted) {
    return;
  }
  await params.session.submitToolResult(callId, result);
  if (params.abortSignal?.aborted) {
    return;
  }
  params.onTalkEvent({
    type: "tool.result",
    callId,
    payload: { name: params.event.name, result },
    final: true,
  });
}
