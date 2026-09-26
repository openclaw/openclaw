import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { tryDispatchAcpReplyCore } from "./dispatch-acp.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import { buildTestCtx } from "./test-ctx.js";
import {
  createAcpTestConfig,
  createAcpTestReplyDispatcherFixture as createDispatcher,
} from "./test-fixtures/acp-runtime.js";

export async function runDispatch(params: {
  bodyForAgent: string;
  runId?: string;
  onAgentRunStart?: Parameters<typeof tryDispatchAcpReplyCore>[0]["onAgentRunStart"];
  userTurnTranscriptRecorder?: Parameters<
    typeof tryDispatchAcpReplyCore
  >[0]["userTurnTranscriptRecorder"];
  prepareAssistantTranscriptMessage?: Parameters<
    typeof tryDispatchAcpReplyCore
  >[0]["prepareAssistantTranscriptMessage"];
  cfg?: OpenClawConfig;
  dispatcher?: ReplyDispatcher;
  shouldRouteToOriginating?: boolean;
  originatingChannel?: string;
  originatingTo?: string;
  onReplyStart?: () => void;
  images?: Array<{ data: string; mimeType: string }>;
  abortSignal?: AbortSignal;
  ctxOverrides?: Record<string, unknown>;
  sessionKeyOverride?: string;
  suppressUserDelivery?: boolean;
  suppressReplyLifecycle?: boolean;
  sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
  toolsAllow?: string[];
  recordProcessed?: (
    outcome: "completed" | "skipped" | "error",
    opts?: { reason?: string; error?: string },
  ) => void;
  markIdle?: (reason: string) => void;
  ctx?: FinalizedRuntimeMsgContext;
}) {
  const targetSessionKey = params.sessionKeyOverride ?? "agent:codex-acp:session-1";
  return tryDispatchAcpReplyCore({
    ctx:
      params.ctx ??
      buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: targetSessionKey,
        BodyForAgent: params.bodyForAgent,
        ...params.ctxOverrides,
      }),
    cfg: params.cfg ?? createAcpTestConfig(),
    dispatcher: params.dispatcher ?? createDispatcher().dispatcher,
    ...(params.runId ? { runId: params.runId } : {}),
    onAgentRunStart: params.onAgentRunStart,
    userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
    sessionKey: targetSessionKey,
    images: params.images,
    abortSignal: params.abortSignal,
    inboundAudio: false,
    suppressUserDelivery: params.suppressUserDelivery,
    suppressReplyLifecycle: params.suppressReplyLifecycle,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    shouldRouteToOriginating: params.shouldRouteToOriginating ?? false,
    ...(params.shouldRouteToOriginating
      ? {
          originatingChannel: params.originatingChannel ?? "telegram",
          originatingTo: params.originatingTo ?? "telegram:thread-1",
        }
      : {}),
    shouldSendToolSummaries: true,
    shouldSendFullToolDetails: false,
    bypassForCommand: false,
    toolsAllow: params.toolsAllow,
    ...(params.onReplyStart ? { onReplyStart: params.onReplyStart } : {}),
    recordProcessed: params.recordProcessed ?? vi.fn(),
    markIdle: params.markIdle ?? vi.fn(),
  });
}
