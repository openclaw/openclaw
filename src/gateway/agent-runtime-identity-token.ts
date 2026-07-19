// Purpose-scoped local agent runtime identity token for Gateway clients.
import { createHash, createHmac } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { stableStringify } from "../agents/stable-stringify.js";
import { normalizeChatType } from "../channels/chat-type.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { InternalChannelThreadingToolContext } from "../channels/threading-tool-context-internal.js";
import { ensureExecApprovalsSnapshot, loadExecApprovalsAsync } from "../infra/exec-approvals.js";
import type { TurnAuthoritySnapshot } from "../plugins/authorization-policy.types.js";
import {
  isIssuedTurnAuthoritySnapshot,
  restoreVerifiedTurnAuthoritySnapshot,
} from "../plugins/turn-authority.js";
import {
  classifySessionKeyShape,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import type { AgentRuntimeMessageActionContext } from "./message-action-turn-capability.js";

const AGENT_RUNTIME_IDENTITY_TOKEN_CONTEXT = "openclaw:gateway-agent-runtime-identity-token:v1";
const AGENT_RUNTIME_IDENTITY_TOKEN_KIND = "agent-runtime";
const MESSAGE_ACTION_TOKEN_TTL_MS = 60_000;
const SESSIONS_SEND_TOKEN_TTL_MS = 60_000;
const SESSIONS_SEND_REQUEST_DIGEST_CONTEXT = "openclaw:sessions-send-agent-request:v1";
const SHA256_BASE64URL_RE = /^[A-Za-z0-9_-]{43}$/u;
const MAX_AGENT_RUNTIME_GATEWAY_METHODS = 16;

const MESSAGE_ACTION_AGENT_RUNTIME_GATEWAY_METHODS = new Set(["message.action", "send"]);

export type AgentRuntimeSessionsSendDelegation = Readonly<{
  kind: "sessions_send";
  expiresAtMs: number;
  targetAgentId: string;
  targetSessionKey: string;
  requestDigest: string;
  turnAuthority: TurnAuthoritySnapshot;
  /** Exact user-visible transcript body; never accepted from public agent RPC params. */
  transcriptMessage?: string;
}>;

export type AgentRuntimeIdentity = {
  kind: "agentRuntime";
  agentId: string;
  sessionKey: string;
  gatewayMethods: readonly string[];
  messageActionContext?: AgentRuntimeMessageActionContext;
  sessionsSendDelegation?: AgentRuntimeSessionsSendDelegation;
};

type AgentRuntimeIdentityTokenPayload = {
  kind: typeof AGENT_RUNTIME_IDENTITY_TOKEN_KIND;
  agentId: string;
  sessionKey: string;
  gatewayMethods: readonly string[];
  messageActionContext?: AgentRuntimeMessageActionContext;
  sessionsSendDelegation?: AgentRuntimeSessionsSendDelegation;
};

function normalizeGatewayMethods(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_AGENT_RUNTIME_GATEWAY_METHODS ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return undefined;
  }
  const methods = normalizeSortedUniqueStringEntries(value);
  return methods.length > 0 ? Object.freeze(methods) : undefined;
}

function gatewayMethodsMatchDelegation(params: {
  gatewayMethods: readonly string[];
  hasMessageActionContext: boolean;
  hasSessionsSendDelegation: boolean;
}): boolean {
  const method = params.gatewayMethods[0];
  if (
    params.gatewayMethods.length !== 1 ||
    !method ||
    (params.hasMessageActionContext && params.hasSessionsSendDelegation)
  ) {
    return false;
  }
  if (params.hasSessionsSendDelegation) {
    return method === "agent";
  }
  return params.hasMessageActionContext
    ? MESSAGE_ACTION_AGENT_RUNTIME_GATEWAY_METHODS.has(method)
    : true;
}

/** Requires both an exact signed method grant and the matching delegation shape. */
export function isAgentRuntimeGatewayMethodAllowed(
  identity: AgentRuntimeIdentity,
  method: string,
): boolean {
  const gatewayMethods = normalizeGatewayMethods(identity.gatewayMethods);
  return Boolean(
    gatewayMethods?.includes(method) &&
    gatewayMethodsMatchDelegation({
      gatewayMethods,
      hasMessageActionContext: Boolean(identity.messageActionContext),
      hasSessionsSendDelegation: Boolean(identity.sessionsSendDelegation),
    }),
  );
}

function canonicalizeGatewayRequest(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("sessions_send agent request must be JSON serializable");
  }
  return JSON.parse(serialized) as unknown;
}

/** Exact digest of the JSON request that crosses the Gateway wire. */
export function digestSessionsSendAgentRequest(value: unknown): string {
  return createHash("sha256")
    .update(SESSIONS_SEND_REQUEST_DIGEST_CONTEXT)
    .update("\0")
    .update(stableStringify(canonicalizeGatewayRequest(value)))
    .digest("base64url");
}

function resolveCanonicalAgentSessionKey(value: string): string | undefined {
  const trimmed = value.trim();
  const shape = classifySessionKeyShape(trimmed);
  if (shape === "missing" || shape === "malformed_agent") {
    return undefined;
  }
  const parsed = parseAgentSessionKey(trimmed);
  return parsed ? `agent:${parsed.agentId}:${parsed.rest}` : trimmed;
}

function isSessionKeyBoundToAgent(params: { sessionKey: string; agentId: string }): boolean {
  const shape = classifySessionKeyShape(params.sessionKey);
  if (shape === "missing" || shape === "malformed_agent") {
    return false;
  }
  const parsed = parseAgentSessionKey(params.sessionKey);
  // Opaque keys carry no agent component. Their adjacent, explicitly signed
  // agent is the only store identity available at this boundary.
  return !parsed || normalizeAgentId(parsed.agentId) === normalizeAgentId(params.agentId);
}

function isTurnAuthorityBoundToRuntimeIdentity(
  value: TurnAuthoritySnapshot | undefined,
  identity: { agentId: string; sessionKey: string },
): value is TurnAuthoritySnapshot {
  return (
    isIssuedTurnAuthoritySnapshot(value) &&
    value.authorization.agentId === identity.agentId &&
    value.authorization.sessionKey === identity.sessionKey
  );
}

async function readSharedAgentRuntimeIdentitySecret(): Promise<string | null> {
  return (await loadExecApprovalsAsync()).socket?.token?.trim() || null;
}

async function requireSharedAgentRuntimeIdentitySecret(): Promise<string> {
  const token = (await ensureExecApprovalsSnapshot()).file.socket?.token?.trim();
  if (!token) {
    throw new Error(
      "Unable to mint agent runtime identity token without local socket credentials.",
    );
  }
  return token;
}

function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(AGENT_RUNTIME_IDENTITY_TOKEN_CONTEXT)
    .update("\0")
    .update(payload)
    .digest("base64url");
}

function encodePayload(payload: AgentRuntimeIdentityTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeMessageActionContext(
  value: unknown,
  nowMs: number,
  identity: { agentId: string; sessionKey: string },
): AgentRuntimeMessageActionContext | undefined {
  if (
    !isRecord(value) ||
    typeof value.expiresAtMs !== "number" ||
    !Number.isFinite(value.expiresAtMs) ||
    nowMs >= value.expiresAtMs
  ) {
    return undefined;
  }
  const rawToolContext = value.toolContext;
  const turnAuthority =
    value.turnAuthority === undefined
      ? undefined
      : restoreVerifiedTurnAuthoritySnapshot(value.turnAuthority);
  const sourceReplyFinal = value.sourceReplyFinal;
  const sourceReplyToolCallId = normalizeOptionalString(value.sourceReplyToolCallId);
  if (sourceReplyFinal !== undefined && typeof sourceReplyFinal !== "boolean") {
    return undefined;
  }
  if (value.sourceReplyToolCallId !== undefined && !sourceReplyToolCallId) {
    return undefined;
  }
  if (rawToolContext !== undefined && !isRecord(rawToolContext)) {
    return undefined;
  }
  const rawCurrentChatType = rawToolContext?.currentChatType;
  const currentChatType = normalizeChatType(
    typeof rawCurrentChatType === "string" ? rawCurrentChatType : undefined,
  );
  const currentMessageId = rawToolContext?.currentMessageId;
  const replyToMode = rawToolContext?.replyToMode;
  const hasRepliedRef = rawToolContext?.hasRepliedRef;
  if (
    (currentMessageId !== undefined &&
      typeof currentMessageId !== "string" &&
      typeof currentMessageId !== "number") ||
    (replyToMode !== undefined &&
      replyToMode !== "off" &&
      replyToMode !== "first" &&
      replyToMode !== "all" &&
      replyToMode !== "batched") ||
    (hasRepliedRef !== undefined &&
      (!isRecord(hasRepliedRef) || typeof hasRepliedRef.value !== "boolean")) ||
    (value.requesterSenderIsOwner !== undefined &&
      typeof value.requesterSenderIsOwner !== "boolean") ||
    (value.requesterIsAuthorizedSender !== undefined &&
      typeof value.requesterIsAuthorizedSender !== "boolean") ||
    (value.requesterRoleIds !== undefined &&
      (!Array.isArray(value.requesterRoleIds) ||
        value.requesterRoleIds.some((entry) => typeof entry !== "string"))) ||
    (value.turnAuthority !== undefined &&
      !isTurnAuthorityBoundToRuntimeIdentity(turnAuthority, identity))
  ) {
    return undefined;
  }
  const readOptionalBoolean = (key: string): boolean | undefined => {
    const candidate = rawToolContext?.[key];
    return typeof candidate === "boolean" ? candidate : undefined;
  };
  const toolContext: InternalChannelThreadingToolContext | undefined = rawToolContext
    ? ({
        currentChannelId: normalizeOptionalString(rawToolContext.currentChannelId),
        currentChatType,
        currentMessagingTarget: normalizeOptionalString(rawToolContext.currentMessagingTarget),
        currentGraphChannelId: normalizeOptionalString(rawToolContext.currentGraphChannelId),
        currentChannelProvider: normalizeOptionalString(rawToolContext.currentChannelProvider) as
          | ChannelId
          | undefined,
        currentThreadTs: normalizeOptionalString(rawToolContext.currentThreadTs),
        currentMessageId,
        currentSourceTurnId: normalizeOptionalString(rawToolContext.currentSourceTurnId),
        replyToMode:
          replyToMode === "off" ||
          replyToMode === "first" ||
          replyToMode === "all" ||
          replyToMode === "batched"
            ? replyToMode
            : undefined,
        hasRepliedRef:
          isRecord(hasRepliedRef) && typeof hasRepliedRef.value === "boolean"
            ? { value: hasRepliedRef.value }
            : undefined,
        sameChannelThreadRequired: readOptionalBoolean("sameChannelThreadRequired"),
        skipCrossContextDecoration: readOptionalBoolean("skipCrossContextDecoration"),
      } satisfies InternalChannelThreadingToolContext)
    : undefined;
  const context = {
    expiresAtMs: value.expiresAtMs,
    sessionId: normalizeOptionalString(value.sessionId),
    requesterAccountId: normalizeOptionalString(value.requesterAccountId),
    requesterSenderId: normalizeOptionalString(value.requesterSenderId),
    requesterSenderIsOwner:
      typeof value.requesterSenderIsOwner === "boolean" ? value.requesterSenderIsOwner : undefined,
    requesterIsAuthorizedSender:
      typeof value.requesterIsAuthorizedSender === "boolean"
        ? value.requesterIsAuthorizedSender
        : undefined,
    requesterRoleIds: Array.isArray(value.requesterRoleIds)
      ? normalizeSortedUniqueStringEntries(value.requesterRoleIds as string[])
      : undefined,
    parentConversationId: normalizeOptionalString(value.parentConversationId),
    turnAuthority,
    toolContext,
  };
  if (sourceReplyFinal === true) {
    if (!sourceReplyToolCallId) {
      return undefined;
    }
    return { ...context, sourceReplyFinal: true, sourceReplyToolCallId };
  }
  return {
    ...context,
    ...(sourceReplyFinal === false ? { sourceReplyFinal: false as const } : {}),
    ...(sourceReplyToolCallId ? { sourceReplyToolCallId } : {}),
  };
}

function decodeSessionsSendDelegation(
  value: unknown,
  nowMs: number,
  source: { agentId: string; sessionKey: string },
): AgentRuntimeSessionsSendDelegation | undefined {
  const transcriptMessage = isRecord(value) ? value.transcriptMessage : undefined;
  if (
    !isRecord(value) ||
    value.kind !== "sessions_send" ||
    typeof value.expiresAtMs !== "number" ||
    !Number.isFinite(value.expiresAtMs) ||
    nowMs >= value.expiresAtMs ||
    typeof value.targetAgentId !== "string" ||
    typeof value.targetSessionKey !== "string" ||
    typeof value.requestDigest !== "string" ||
    !SHA256_BASE64URL_RE.test(value.requestDigest) ||
    (transcriptMessage !== undefined &&
      (typeof transcriptMessage !== "string" || transcriptMessage.length === 0))
  ) {
    return undefined;
  }
  const rawTargetAgentId = normalizeOptionalString(value.targetAgentId);
  const targetAgentId = rawTargetAgentId ? normalizeAgentId(rawTargetAgentId) : undefined;
  const targetSessionKey = value.targetSessionKey.trim();
  const canonicalTargetSessionKey = resolveCanonicalAgentSessionKey(targetSessionKey);
  const turnAuthority = restoreVerifiedTurnAuthoritySnapshot(value.turnAuthority);
  if (
    !targetAgentId ||
    !targetSessionKey ||
    canonicalTargetSessionKey !== targetSessionKey ||
    !isSessionKeyBoundToAgent({ sessionKey: targetSessionKey, agentId: targetAgentId }) ||
    !turnAuthority ||
    !isSessionKeyBoundToAgent({ sessionKey: source.sessionKey, agentId: source.agentId }) ||
    normalizeAgentId(turnAuthority.authorization.agentId) !== source.agentId ||
    turnAuthority.authorization.sessionKey?.trim() !== source.sessionKey
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "sessions_send",
    expiresAtMs: value.expiresAtMs,
    targetAgentId,
    targetSessionKey,
    requestDigest: value.requestDigest,
    turnAuthority,
    ...(typeof transcriptMessage === "string" ? { transcriptMessage } : {}),
  });
}

function decodePayload(value: string, nowMs: number): AgentRuntimeIdentityTokenPayload | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const raw = parsed as {
      kind?: unknown;
      agentId?: unknown;
      sessionKey?: unknown;
      gatewayMethods?: unknown;
      messageActionContext?: unknown;
      sessionsSendDelegation?: unknown;
    };
    if (
      raw.kind !== AGENT_RUNTIME_IDENTITY_TOKEN_KIND ||
      typeof raw.agentId !== "string" ||
      typeof raw.sessionKey !== "string"
    ) {
      return undefined;
    }
    const agentId = normalizeAgentId(raw.agentId);
    const sessionKey = raw.sessionKey.trim();
    const gatewayMethods = normalizeGatewayMethods(raw.gatewayMethods);
    if (!agentId || !gatewayMethods || !isSessionKeyBoundToAgent({ sessionKey, agentId })) {
      return undefined;
    }
    const messageActionContext =
      raw.messageActionContext === undefined
        ? undefined
        : decodeMessageActionContext(raw.messageActionContext, nowMs, { agentId, sessionKey });
    if (raw.messageActionContext !== undefined && !messageActionContext) {
      return undefined;
    }
    const sessionsSendDelegation =
      raw.sessionsSendDelegation === undefined
        ? undefined
        : decodeSessionsSendDelegation(raw.sessionsSendDelegation, nowMs, {
            agentId,
            sessionKey,
          });
    if (
      (raw.sessionsSendDelegation !== undefined && !sessionsSendDelegation) ||
      (messageActionContext && sessionsSendDelegation) ||
      !gatewayMethodsMatchDelegation({
        gatewayMethods,
        hasMessageActionContext: Boolean(messageActionContext),
        hasSessionsSendDelegation: Boolean(sessionsSendDelegation),
      })
    ) {
      return undefined;
    }
    return {
      kind: AGENT_RUNTIME_IDENTITY_TOKEN_KIND,
      agentId,
      sessionKey,
      gatewayMethods,
      ...(messageActionContext ? { messageActionContext } : {}),
      ...(sessionsSendDelegation ? { sessionsSendDelegation } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Mint an opaque token that lets trusted local agent-tool clients identify their agent. */
export async function mintAgentRuntimeIdentityToken(params: {
  agentId: string;
  sessionKey: string;
  gatewayMethods: readonly string[];
  messageActionContext?: AgentRuntimeMessageActionContext;
  sessionsSendDelegation?: {
    targetAgentId: string;
    targetSessionKey: string;
    request: unknown;
    turnAuthority: TurnAuthoritySnapshot;
    transcriptMessage?: string;
  };
}): Promise<string> {
  if (params.messageActionContext && params.sessionsSendDelegation) {
    throw new Error("agent runtime identity token must have exactly one scoped delegation");
  }
  const gatewayMethods = normalizeGatewayMethods(params.gatewayMethods);
  if (
    !gatewayMethods ||
    !gatewayMethodsMatchDelegation({
      gatewayMethods,
      hasMessageActionContext: Boolean(params.messageActionContext),
      hasSessionsSendDelegation: Boolean(params.sessionsSendDelegation),
    })
  ) {
    throw new Error("agent runtime identity token requires methods matching its delegation");
  }
  const sourceAgentId = normalizeAgentId(params.agentId);
  const sourceSessionKey = params.sessionKey.trim();
  if (!isSessionKeyBoundToAgent({ sessionKey: sourceSessionKey, agentId: sourceAgentId })) {
    throw new Error("agent runtime identity token requires a valid session key bound to its agent");
  }
  const messageActionTurnAuthority = params.messageActionContext?.turnAuthority;
  if (
    params.messageActionContext?.sourceReplyFinal === true &&
    !normalizeOptionalString(params.messageActionContext.sourceReplyToolCallId)
  ) {
    throw new Error("terminal source reply requires tool-call correlation");
  }
  if (
    messageActionTurnAuthority !== undefined &&
    !isTurnAuthorityBoundToRuntimeIdentity(messageActionTurnAuthority, {
      agentId: sourceAgentId,
      sessionKey: sourceSessionKey,
    })
  ) {
    throw new Error(
      "message action context requires host-issued turn authority matching runtime identity",
    );
  }
  const messageActionContext = params.messageActionContext
    ? {
        ...params.messageActionContext,
        // Encode the exact authority object checked above, even if the caller
        // supplied a dynamic property on the surrounding context object.
        turnAuthority: messageActionTurnAuthority,
        // The process-local turn capability may live for the whole run, but a
        // copied bearer must expire shortly after its individual tool action.
        expiresAtMs: Math.min(
          params.messageActionContext.expiresAtMs,
          Date.now() + MESSAGE_ACTION_TOKEN_TTL_MS,
        ),
      }
    : undefined;
  const sourceAuthority = params.sessionsSendDelegation?.turnAuthority;
  if (
    params.sessionsSendDelegation &&
    (!isIssuedTurnAuthoritySnapshot(sourceAuthority) ||
      !isSessionKeyBoundToAgent({ sessionKey: sourceSessionKey, agentId: sourceAgentId }) ||
      normalizeAgentId(sourceAuthority.authorization.agentId) !== sourceAgentId ||
      sourceAuthority.authorization.sessionKey?.trim() !== sourceSessionKey)
  ) {
    throw new Error("sessions_send delegation requires matching issued turn authority");
  }
  let sessionsSendDelegation: AgentRuntimeSessionsSendDelegation | undefined;
  if (params.sessionsSendDelegation) {
    const rawTargetAgentId = normalizeOptionalString(params.sessionsSendDelegation.targetAgentId);
    const targetAgentId = rawTargetAgentId ? normalizeAgentId(rawTargetAgentId) : undefined;
    const targetSessionKey = params.sessionsSendDelegation.targetSessionKey.trim();
    const canonicalTargetSessionKey = resolveCanonicalAgentSessionKey(targetSessionKey);
    const targetSessionAgentId = parseAgentSessionKey(targetSessionKey)?.agentId;
    const requestTargetSessionKey = isRecord(params.sessionsSendDelegation.request)
      ? normalizeOptionalString(params.sessionsSendDelegation.request.sessionKey)
      : undefined;
    const requestTargetAgentId = isRecord(params.sessionsSendDelegation.request)
      ? normalizeOptionalString(params.sessionsSendDelegation.request.agentId)
      : undefined;
    const transcriptMessage = params.sessionsSendDelegation.transcriptMessage;
    if (
      transcriptMessage !== undefined &&
      (typeof transcriptMessage !== "string" || transcriptMessage.length === 0)
    ) {
      throw new Error("sessions_send delegation transcript message must be non-empty");
    }
    if (
      !targetAgentId ||
      !targetSessionKey ||
      canonicalTargetSessionKey !== targetSessionKey ||
      requestTargetSessionKey !== targetSessionKey ||
      !isSessionKeyBoundToAgent({ sessionKey: targetSessionKey, agentId: targetAgentId }) ||
      (requestTargetAgentId !== undefined &&
        normalizeAgentId(requestTargetAgentId) !== targetAgentId) ||
      // Opaque targets are safe only when the exact signed request carries
      // the same adjacent agent; otherwise Gateway would default their store.
      (!targetSessionAgentId &&
        (!requestTargetAgentId || normalizeAgentId(requestTargetAgentId) !== targetAgentId))
    ) {
      throw new Error("sessions_send delegation requires an exact target");
    }
    sessionsSendDelegation = Object.freeze({
      kind: "sessions_send",
      expiresAtMs: Date.now() + SESSIONS_SEND_TOKEN_TTL_MS,
      targetAgentId,
      targetSessionKey,
      requestDigest: digestSessionsSendAgentRequest(params.sessionsSendDelegation.request),
      turnAuthority: params.sessionsSendDelegation.turnAuthority,
      ...(typeof transcriptMessage === "string" ? { transcriptMessage } : {}),
    });
  }
  const payload = encodePayload({
    kind: AGENT_RUNTIME_IDENTITY_TOKEN_KIND,
    agentId: sourceAgentId,
    sessionKey: sourceSessionKey,
    gatewayMethods,
    ...(messageActionContext ? { messageActionContext } : {}),
    ...(sessionsSendDelegation ? { sessionsSendDelegation } : {}),
  });
  const signature = signPayload(await requireSharedAgentRuntimeIdentitySecret(), payload);
  return `${payload}.${signature}`;
}

/** Validate a presented agent runtime token and return the internal caller identity. */
export async function verifyAgentRuntimeIdentityToken(
  value: string | null | undefined,
  nowMs?: number,
): Promise<AgentRuntimeIdentity | undefined> {
  const token = value?.trim();
  if (!token) {
    return undefined;
  }
  const [payloadPart, signature, ...extra] = token.split(".");
  if (!payloadPart || !signature || extra.length > 0) {
    return undefined;
  }
  const sharedSecret = await readSharedAgentRuntimeIdentitySecret();
  if (!sharedSecret || !safeEqualSecret(signature, signPayload(sharedSecret, payloadPart))) {
    return undefined;
  }
  const payload = decodePayload(payloadPart, nowMs ?? Date.now());
  if (!payload) {
    return undefined;
  }
  return {
    kind: "agentRuntime",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    gatewayMethods: payload.gatewayMethods,
    ...(payload.messageActionContext ? { messageActionContext: payload.messageActionContext } : {}),
    ...(payload.sessionsSendDelegation
      ? { sessionsSendDelegation: payload.sessionsSendDelegation }
      : {}),
  };
}
