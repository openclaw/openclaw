// Recognizes stop requests before loading active-run cancellation machinery.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { isAbortRequestText } from "./abort-primitives.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

export type FastAbortRequestParams = {
  ctx: FinalizedRuntimeMsgContext;
  cfg: OpenClawConfig;
  isCommandTargetCurrent?: () => boolean;
};

export type FastAbortResult = {
  handled: boolean;
  aborted: boolean;
  rejectionReason?: "finalizing";
  stoppedSubagents?: number;
  failedSubagents?: number;
};

export function formatAbortReplyText(
  stoppedSubagents?: number,
  rejectionReason?: "finalizing",
  failedSubagents?: number,
): string {
  const failureSuffix =
    typeof failedSubagents === "number" && failedSubagents > 0
      ? ` Cancellation was incomplete for ${failedSubagents} sub-agent${failedSubagents === 1 ? "" : "s"}. Retry /stop.`
      : "";
  if (rejectionReason === "finalizing") {
    const base = "Agent reply is already finalizing and can no longer be aborted.";
    if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
      return `${base}${failureSuffix}`;
    }
    const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
    return `${base} Stopped ${stoppedSubagents} ${label}.${failureSuffix}`;
  }
  if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
    return `⚙️ Agent was aborted.${failureSuffix}`;
  }
  const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
  return `⚙️ Agent was aborted. Stopped ${stoppedSubagents} ${label}.${failureSuffix}`;
}

/** Normalize ingress once; current authorization belongs to the loaded operation. */
function resolveFastAbortRequest(params: FastAbortRequestParams) {
  const { ctx, cfg } = params;
  const commandSessionKey =
    normalizeOptionalString(ctx.SessionKey) ?? normalizeOptionalString(ctx.ParentSessionKey);
  const targetKey = normalizeOptionalString(ctx.CommandTargetSessionKey) ?? commandSessionKey;
  const resolveTargetAgentId = () =>
    resolveSessionAgentId({
      sessionKey: targetKey ?? ctx.SessionKey ?? "",
      config: cfg,
      fallbackAgentId: ctx.AgentId,
    });
  const raw = stripStructuralPrefixes(ctx.commandText);
  const isGroup = normalizeOptionalLowercaseString(ctx.ChatType) === "group";
  const stripped = isGroup ? stripMentions(raw, ctx, cfg, resolveTargetAgentId()) : raw;
  const abortRequested = isAbortRequestText(stripped);
  if (!abortRequested) {
    return undefined;
  }

  return { commandSessionKey, targetKey, resolveTargetAgentId };
}

export type PreparedFastAbortRequest = NonNullable<ReturnType<typeof resolveFastAbortRequest>>;

export async function tryFastAbortFromMessage(
  params: FastAbortRequestParams,
): Promise<FastAbortResult> {
  const request = resolveFastAbortRequest(params);
  if (!request) {
    return { handled: false, aborted: false };
  }
  // Normalized ingress is not authority. The operation resolves authorization
  // and retains current-target validation after loading cancellation machinery.
  const { executeFastAbortRequest } = await import("./abort-operation.js");
  return executeFastAbortRequest(params, request);
}
