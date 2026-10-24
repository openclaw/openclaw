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
      const context = {
        surface,
        config: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        agentId: params.config.realtime.agentId,
        toolPolicy: params.config.realtime.toolPolicy,
        abortSignal,
        ...call,
      };
      const callId = context.event.callId || context.event.itemId;
      if (context.abortSignal?.aborted) {
        return;
      }
      const submitError = async (message: string) => {
        await context.session.submitToolResult(callId, { error: message });
        if (!context.abortSignal?.aborted) {
          context.onTalkEvent({
            type: "tool.error",
            callId,
            payload: { name: context.event.name, error: message },
            final: true,
          });
        }
      };
      const unavailableToolError =
        context.strategy !== "bidi"
          ? `Tool "${context.event.name}" is only available in bidi realtime strategy`
          : context.event.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME
            ? `Tool "${context.event.name}" not available`
            : undefined;
      if (unavailableToolError) {
        await submitError(unavailableToolError);
        return;
      }
      await (context.abortSignal?.aborted || !context.session.bridge.supportsToolResultContinuation
        ? undefined
        : context.session.submitToolResult(
            callId,
            buildRealtimeVoiceAgentConsultWorkingResponse(context.surface.workingResponseLabel),
            { willContinue: true },
          ));
      if (context.abortSignal?.aborted) {
        return;
      }
      context.onTalkEvent({
        type: "tool.progress",
        callId,
        payload: { name: context.event.name, status: "working" },
      });
      let result: { text: string };
      try {
        result = await consultMeetingAgent({ ...context, args: context.event.args });
      } catch (error) {
        if (context.abortSignal?.aborted) {
          return;
        }
        await submitError(formatErrorMessage(error));
        return;
      }
      if (context.abortSignal?.aborted) {
        return;
      }
      await context.session.submitToolResult(callId, result);
      if (context.abortSignal?.aborted) {
        return;
      }
      context.onTalkEvent({
        type: "tool.result",
        callId,
        payload: { name: context.event.name, result },
        final: true,
      });
    },
  };
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
