import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { EmbeddedTurnContinuationPolicy } from "../../agents/embedded-agent-runner/run/turn-continuation.js";
import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../../agents/tool-policy-shared.js";
import type { GroupParticipationRun } from "./group-participation-run.js";
import { readSourceReplyDeliveryRuntime } from "./source-reply-delivery-runtime.js";

// These operations read through their existing workspace, network, and memory access owners.
// Unknown plugin tools, replay-safe operations, and session_status are not a read grant.
const investigationTools = [
  "read",
  "web_search",
  "web_fetch",
  "memory_search",
  "memory_get",
  "sessions_list",
  "sessions_history",
  "view_image",
  "pdf",
];

/** Keep the ordinary policy for provider outages; private preparation adds only restrictions. */
export function createGroupParticipationPolicy(
  params: RunEmbeddedAgentInternalParams,
  owner: GroupParticipationRun,
): () => EmbeddedTurnContinuationPolicy {
  const original: EmbeddedTurnContinuationPolicy = {
    permissionMode: params.permissionMode,
    toolsAllow: params.toolsAllow,
    disableTools: params.disableTools,
    disableMessageTool: params.disableMessageTool,
    forceMessageTool: params.forceMessageTool,
    conversationToolPolicy: params.conversationToolPolicy,
    terminalReplyExpectation: owner.ordinaryReplyExpectation,
    silentExpected: params.silentExpected,
    silentReplyPromptMode: params.silentReplyPromptMode,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    onPartialReply: params.onPartialReply,
    onBlockReply: params.onBlockReply,
    onBlockReplyFlush: params.onBlockReplyFlush,
    onReasoningStream: params.onReasoningStream,
    onReasoningEnd: params.onReasoningEnd,
    onAssistantMessageStart: params.onAssistantMessageStart,
    onAgentEvent: params.onAgentEvent,
    onToolResult: params.onToolResult,
    shouldEmitToolResult: params.shouldEmitToolResult,
    shouldEmitToolOutput: params.shouldEmitToolOutput,
  };
  const restrictions =
    original.toolsAllow === undefined
      ? []
      : (readToolAllowlistIntersection(original.toolsAllow) ?? [original.toolsAllow]);
  const toolsAllow = attachToolAllowlistIntersection(
    [...investigationTools],
    [investigationTools, ...restrictions],
  );
  const deliveryRuntime = readSourceReplyDeliveryRuntime(params);
  return () => {
    if (owner.mode === "ordinary" || owner.mode === "engagement") {
      deliveryRuntime?.applyPreparedMode(params, original.sourceReplyDeliveryMode ?? "automatic");
      return original;
    }
    deliveryRuntime?.applyPreparedMode(params, "automatic");
    return {
      ...original,
      permissionMode: "read-only",
      toolsAllow,
      disableMessageTool: true,
      forceMessageTool: false,
      terminalReplyExpectation: "optional",
      sourceReplyDeliveryMode: "automatic",
      onPartialReply: undefined,
      onBlockReply: undefined,
      onBlockReplyFlush: undefined,
      onReasoningStream: undefined,
      onReasoningEnd: undefined,
      onAssistantMessageStart: undefined,
      onToolResult: undefined,
      shouldEmitToolResult: () => false,
      shouldEmitToolOutput: () => false,
    };
  };
}
