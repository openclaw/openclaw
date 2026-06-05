import crypto from "node:crypto";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "@openclaw/normalization-core/string-coerce";
import { isTruthyEnvValue } from "../infra/env.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";

// Process-local MCP loopback runtime state for owner/non-owner HTTP access.
type McpLoopbackRuntime = {
  port: number;
  ownerToken: string;
  nonOwnerToken: string;
};

type ActiveMcpLoopbackRuntime = McpLoopbackRuntime & {
  scopedTokenSecret: string;
};

export type McpLoopbackAuthContext = {
  senderIsOwner: boolean;
  senderId: string | undefined;
  sessionKey?: string;
  agentId?: string;
  accountId?: string;
  messageProvider?: string;
  requesterSourceProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string;
  currentInboundAudio?: boolean;
  inboundEventKind?: string;
  sourceReplyDeliveryMode?: string;
};

export type McpLoopbackBoundContext = Pick<
  McpLoopbackAuthContext,
  | "sessionKey"
  | "agentId"
  | "accountId"
  | "messageProvider"
  | "requesterSourceProvider"
  | "currentChannelId"
  | "currentThreadTs"
  | "currentMessageId"
  | "currentInboundAudio"
  | "inboundEventKind"
  | "sourceReplyDeliveryMode"
>;

export type McpLoopbackBoundContextInput = {
  sessionKey?: string | null;
  agentId?: string | null;
  accountId?: string | null;
  messageProvider?: string | null;
  requesterSourceProvider?: string | null;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  currentInboundAudio?: boolean | string | null;
  inboundEventKind?: string | null;
  sourceReplyDeliveryMode?: string | null;
};

const SCOPED_TOKEN_PREFIX = "ctx1";

let activeRuntime: ActiveMcpLoopbackRuntime | undefined;

function normalizeSenderId(senderId: string | null | undefined): string | undefined {
  const trimmed = typeof senderId === "string" ? senderId.trim() : "";
  return trimmed || undefined;
}

function normalizeScopedMessageProvider(value: unknown): string | undefined {
  return normalizeMessageChannel(normalizeOptionalString(value)) ?? undefined;
}

function normalizeMcpLoopbackInboundEventKind(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed === "room_event" || trimmed === "user_request" ? trimmed : undefined;
}

function normalizeMcpLoopbackSourceReplyDeliveryMode(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed === "automatic" || trimmed === "message_tool_only" ? trimmed : undefined;
}

function normalizeMcpLoopbackCurrentInboundAudio(value: unknown): boolean | undefined {
  if (value === true) {
    return true;
  }
  const trimmed = normalizeOptionalString(value);
  return trimmed && isTruthyEnvValue(trimmed) ? true : undefined;
}

export function normalizeMcpLoopbackBoundContext(
  context: McpLoopbackBoundContextInput | null | undefined,
): McpLoopbackBoundContext {
  return {
    sessionKey: normalizeOptionalString(context?.sessionKey),
    agentId: normalizeOptionalString(context?.agentId),
    accountId: normalizeOptionalString(context?.accountId),
    messageProvider: normalizeScopedMessageProvider(context?.messageProvider),
    requesterSourceProvider: normalizeScopedMessageProvider(context?.requesterSourceProvider),
    currentChannelId: normalizeOptionalString(context?.currentChannelId),
    currentThreadTs: normalizeOptionalString(context?.currentThreadTs),
    currentMessageId: normalizeOptionalStringifiedId(context?.currentMessageId),
    currentInboundAudio: normalizeMcpLoopbackCurrentInboundAudio(context?.currentInboundAudio),
    inboundEventKind: normalizeMcpLoopbackInboundEventKind(context?.inboundEventKind),
    sourceReplyDeliveryMode: normalizeMcpLoopbackSourceReplyDeliveryMode(
      context?.sourceReplyDeliveryMode,
    ),
  };
}

function encodeScopedPayload(auth: McpLoopbackAuthContext): string {
  return Buffer.from(JSON.stringify({ v: 1, ...auth }), "utf8").toString("base64url");
}

function signScopedPayload(secret: string, encodedPayload: string): string {
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function readScopedAuth(encodedPayload: string): McpLoopbackAuthContext | null {
  try {
    const decoded = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (typeof decoded === "object" && decoded !== null && (decoded as { v?: unknown }).v === 1) {
      const senderId = normalizeSenderId(
        (decoded as { senderId?: unknown }).senderId as string | undefined,
      );
      const messageProvider = normalizeScopedMessageProvider(
        (decoded as { messageProvider?: unknown }).messageProvider as string | undefined,
      );
      const requesterSourceProvider = normalizeScopedMessageProvider(
        (decoded as { requesterSourceProvider?: unknown }).requesterSourceProvider as
          | string
          | undefined,
      );
      const boundContext = normalizeMcpLoopbackBoundContext({
        sessionKey: (decoded as { sessionKey?: unknown }).sessionKey as string | undefined,
        agentId: (decoded as { agentId?: unknown }).agentId as string | undefined,
        accountId: (decoded as { accountId?: unknown }).accountId as string | undefined,
        messageProvider,
        requesterSourceProvider,
        currentChannelId: (decoded as { currentChannelId?: unknown }).currentChannelId as
          | string
          | undefined,
        currentThreadTs: (decoded as { currentThreadTs?: unknown }).currentThreadTs as
          | string
          | undefined,
        currentMessageId: (decoded as { currentMessageId?: unknown }).currentMessageId as
          | string
          | undefined,
        currentInboundAudio: (decoded as { currentInboundAudio?: unknown }).currentInboundAudio as
          | boolean
          | string
          | undefined,
        inboundEventKind: (decoded as { inboundEventKind?: unknown }).inboundEventKind as
          | string
          | undefined,
        sourceReplyDeliveryMode: (decoded as { sourceReplyDeliveryMode?: unknown })
          .sourceReplyDeliveryMode as string | undefined,
      });
      const senderIsOwner = (decoded as { senderIsOwner?: unknown }).senderIsOwner;
      if (senderId && typeof senderIsOwner === "boolean") {
        return { senderIsOwner, senderId, ...boundContext };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function createScopedTokenSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

function resolveActiveScopedTokenSecret(runtime: McpLoopbackRuntime): string | undefined {
  if (
    activeRuntime?.port === runtime.port &&
    safeEqualSecret(activeRuntime.ownerToken, runtime.ownerToken) &&
    safeEqualSecret(activeRuntime.nonOwnerToken, runtime.nonOwnerToken)
  ) {
    return activeRuntime.scopedTokenSecret;
  }
  return undefined;
}

/** Return a copy of the active loopback runtime, if one has been installed. */
export function getActiveMcpLoopbackRuntime(): McpLoopbackRuntime | undefined {
  if (!activeRuntime) {
    return undefined;
  }
  return {
    port: activeRuntime.port,
    ownerToken: activeRuntime.ownerToken,
    nonOwnerToken: activeRuntime.nonOwnerToken,
  };
}

/** Install the active loopback runtime used by in-process MCP callers. */
export function setActiveMcpLoopbackRuntime(
  runtime: McpLoopbackRuntime & { scopedTokenSecret?: string },
): void {
  activeRuntime = {
    ...runtime,
    scopedTokenSecret: runtime.scopedTokenSecret ?? createScopedTokenSecret(),
  };
}

/** Choose the bearer token matching owner/non-owner caller identity. */
export function resolveMcpLoopbackBearerToken(
  runtime: McpLoopbackRuntime,
  senderIsOwner: boolean,
  context?: McpLoopbackBoundContextInput & { senderId?: string | null },
): string {
  const baseToken = senderIsOwner ? runtime.ownerToken : runtime.nonOwnerToken;
  const senderId = normalizeSenderId(context?.senderId);
  if (!senderId) {
    return baseToken;
  }
  const scopedTokenSecret = resolveActiveScopedTokenSecret(runtime);
  if (!scopedTokenSecret) {
    throw new Error("MCP loopback sender context is unavailable");
  }
  const encodedPayload = encodeScopedPayload({
    senderIsOwner,
    senderId,
    ...normalizeMcpLoopbackBoundContext(context),
  });
  return [
    SCOPED_TOKEN_PREFIX,
    encodedPayload,
    signScopedPayload(scopedTokenSecret, encodedPayload),
  ].join(".");
}

/** Resolve sender context carried by a scoped loopback bearer token. */
export function resolveMcpLoopbackScopedTokenAuth(params: {
  token: string;
  scopedTokenSecret: string;
}): McpLoopbackAuthContext | null {
  const [prefix, encodedPayload, signature, extra] = params.token.split(".");
  if (prefix !== SCOPED_TOKEN_PREFIX || !encodedPayload || !signature || extra !== undefined) {
    return null;
  }
  const auth = readScopedAuth(encodedPayload);
  if (!auth) {
    return null;
  }
  if (safeEqualSecret(signature, signScopedPayload(params.scopedTokenSecret, encodedPayload))) {
    return auth;
  }
  return null;
}

/** Clear loopback runtime only when the owning token matches the active runtime. */
export function clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken: string): void {
  if (activeRuntime?.ownerToken === ownerToken) {
    activeRuntime = undefined;
  }
}

/** Build the MCP server config injected into agents for loopback tool access. */
export function createMcpLoopbackServerConfig(port: number) {
  return {
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: {
          Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
          "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
          "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
          "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
          "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
          "x-openclaw-requester-source-provider": "${OPENCLAW_MCP_REQUESTER_SOURCE_PROVIDER}",
          "x-openclaw-current-channel-id": "${OPENCLAW_MCP_CURRENT_CHANNEL_ID}",
          "x-openclaw-current-thread-ts": "${OPENCLAW_MCP_CURRENT_THREAD_TS}",
          "x-openclaw-current-message-id": "${OPENCLAW_MCP_CURRENT_MESSAGE_ID}",
          "x-openclaw-current-inbound-audio": "${OPENCLAW_MCP_CURRENT_INBOUND_AUDIO}",
          "x-openclaw-inbound-event-kind": "${OPENCLAW_MCP_INBOUND_EVENT_KIND}",
          "x-openclaw-source-reply-delivery-mode": "${OPENCLAW_MCP_SOURCE_REPLY_DELIVERY_MODE}",
        },
      },
    },
  };
}
