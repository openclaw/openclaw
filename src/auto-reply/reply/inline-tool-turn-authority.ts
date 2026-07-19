import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import type { TurnAuthoritySnapshot } from "../../plugins/authorization-policy.types.js";
import {
  classifyTurnAuthoritySnapshot,
  rebindTurnAuthoritySnapshot,
} from "../../plugins/turn-authority.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { MsgContext } from "../templating.js";

function resolveInlineToolConversationId(ctx: MsgContext, sessionKey: string): string | undefined {
  return (
    normalizeOptionalString(ctx.NativeChannelId) ??
    normalizeOptionalString(ctx.ChatId) ??
    normalizeOptionalString(ctx.OriginatingTo) ??
    normalizeOptionalString(sessionKey)
  );
}

/** Rebinds admitted ingress authority after session preparation, without laundering mismatches. */
export function resolveInlineToolTurnAuthority(params: {
  ctx: MsgContext;
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  runId?: string;
}): TurnAuthoritySnapshot | undefined {
  const classified = classifyTurnAuthoritySnapshot(params.ctx.TurnAuthority);
  if (classified.kind !== "issued") {
    return undefined;
  }
  const source = classified.snapshot.authorization;
  const sourceAgentId = normalizeOptionalString(source.agentId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const sourceSessionKey = normalizeOptionalString(source.sessionKey);
  const sessionId = normalizeOptionalString(params.sessionId);
  const sourceSessionId = normalizeOptionalString(source.sessionId);
  const runId = normalizeOptionalString(params.runId);
  const sourceRunId = normalizeOptionalString(source.runId);
  const conversationId = resolveInlineToolConversationId(params.ctx, params.sessionKey);
  const sourceConversationId = normalizeOptionalString(source.conversationId);
  const parentConversationId = normalizeOptionalString(params.ctx.ThreadParentId);
  const sourceParentConversationId = normalizeOptionalString(source.parentConversationId);
  const threadId = stringifyRouteThreadId(
    params.ctx.MessageThreadId ?? params.ctx.TransportThreadId,
  );
  const sourceThreadId = stringifyRouteThreadId(source.threadId);
  // Ingress authority exists before session preparation allocates session/run ids.
  // Require every pre-bound value to match, then issue the exact prepared execution binding.
  if (
    !sourceAgentId ||
    normalizeAgentId(sourceAgentId) !== normalizeAgentId(params.agentId) ||
    !sessionKey ||
    sourceSessionKey !== sessionKey ||
    (sourceSessionId !== undefined && sourceSessionId !== sessionId) ||
    (sourceRunId !== undefined && sourceRunId !== runId) ||
    !conversationId ||
    sourceConversationId !== conversationId ||
    sourceParentConversationId !== parentConversationId ||
    sourceThreadId !== threadId
  ) {
    return undefined;
  }
  return rebindTurnAuthoritySnapshot(classified.snapshot, {
    agentId: normalizeAgentId(params.agentId),
    sessionKey,
    sessionId,
    runId,
    trigger: "command",
  });
}
