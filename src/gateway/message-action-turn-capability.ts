import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import type { InternalChannelThreadingToolContext } from "../channels/threading-tool-context-internal.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel-normalize.js";
import type { CronAuthenticatedChannelRequester } from "./cron-creator-authority-grant.types.js";

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const MAX_ACTIVE_CAPABILITIES = 4096;
const RUN_LIFETIME_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;
const CAPABILITY_COMPLETION_GRACE_MS = 60_000;

/** Host-only scheduled grant; never serialized or passed to channel plugins. */
type ScheduledMessageActionAuthority = {
  policy: ScheduledToolPolicyContext;
  assertCurrent: () => void;
  assertSourceCurrent?: () => void;
  channelRequester?: CronAuthenticatedChannelRequester;
};

/** Private handoff from authenticated dashboard admission to the exact reply run. */
export type DashboardMessageReadAdmission = Readonly<{
  agentId: string;
  runId: string;
  sessionKey: string;
  sessionId?: string;
  assertCurrent: () => void;
}>;

export type MessageActionAuthorization = {
  requesterAccountId?: string;
  requesterSenderId?: string;
  toolContext?: InternalChannelThreadingToolContext;
  /** @internal Redeemed from the process-local turn capability. */
  scheduled?: ScheduledMessageActionAuthority;
  /** @internal Redeemed only by the host; never serialized or passed to plugins. */
  assertDashboardReadCurrent?: () => void;
};

type MessageActionRequesterIdentity = {
  requesterAccountId?: string;
  requesterSenderId?: string;
  requesterSenderName?: string;
  requesterSenderUsername?: string;
  requesterSenderE164?: string;
};

type AgentRuntimeMessageActionContextBase = MessageActionRequesterIdentity & {
  expiresAtMs: number;
  /** Process-local owner reference revalidated before privileged Gateway use. */
  turnCapability?: string;
  sessionId?: string;
  /** Durable session entry that owns restart-recovery receipt state. */
  sourceReplySessionKey?: string;
  toolContext?: InternalChannelThreadingToolContext;
};

export type AgentRuntimeMessageActionContext = AgentRuntimeMessageActionContextBase &
  (
    | {
        sourceReplyFinal: true;
        sourceReplyToolCallId: string;
      }
    | {
        sourceReplyFinal?: false;
        sourceReplyToolCallId?: string;
      }
  );

export function selectMessageActionRequesterIdentity(
  context: MessageActionRequesterIdentity | undefined,
): MessageActionRequesterIdentity {
  return {
    requesterAccountId: context?.requesterAccountId,
    requesterSenderId: context?.requesterSenderId,
    requesterSenderName: context?.requesterSenderName,
    requesterSenderUsername: context?.requesterSenderUsername,
    requesterSenderE164: context?.requesterSenderE164,
  };
}

type MessageActionTurnCapability = AgentRuntimeMessageActionContext & {
  agentId: string;
  runId: string;
  sessionKey: string;
  scheduled?: ScheduledMessageActionAuthority;
  assertDashboardReadCurrent?: () => void;
};

const capabilitiesByToken = new Map<string, MessageActionTurnCapability>();
const invocationConfig = new AsyncLocalStorage<{
  token: string;
  resolve: () => OpenClawConfig;
}>();

/** Bound local requests retain one admitted invocation's resolved configuration. */
export function withMessageActionInvocationConfig<T>(
  token: string | undefined,
  resolve: (() => OpenClawConfig) | undefined,
  run: () => T,
): T {
  return token && resolve ? invocationConfig.run({ token, resolve }, run) : run();
}

export function readMessageActionInvocationConfig(
  token: string | undefined,
): OpenClawConfig | undefined {
  const invocation = invocationConfig.getStore();
  return token && invocation?.token === token ? invocation.resolve() : undefined;
}

export function isTrustedMessageActionTurnIngress(provider: string | null | undefined): boolean {
  const normalized = normalizeMessageChannel(provider);
  return normalized !== undefined && isDeliverableMessageChannel(normalized);
}

function resolveTtlMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(Math.trunc(value), MAX_TTL_MS);
}

/** Mirrors agent timeout semantics while leaving unlimited runs to explicit revocation. */
export function resolveMessageActionTurnCapabilityLifetime(
  timeoutMs: number,
): { expiresWithRun: true } | { ttlMs: number } {
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? { ttlMs: timeoutMs + CAPABILITY_COMPLETION_GRACE_MS }
    : { expiresWithRun: true };
}

function copyToolContext(
  context: InternalChannelThreadingToolContext | undefined,
): InternalChannelThreadingToolContext | undefined {
  if (!context) {
    return undefined;
  }
  return {
    currentChannelId: normalizeOptionalString(context.currentChannelId),
    currentChatType: context.currentChatType,
    currentMessagingTarget: normalizeOptionalString(context.currentMessagingTarget),
    currentGraphChannelId: normalizeOptionalString(context.currentGraphChannelId),
    currentChannelProvider: context.currentChannelProvider,
    currentThreadTs: normalizeOptionalString(context.currentThreadTs),
    currentMessageId: context.currentMessageId,
    currentSourceTurnId: normalizeOptionalString(context.currentSourceTurnId),
    replyToMode: context.replyToMode,
    // Reply-to-first state is intentionally shared across actions in one turn.
    // Preserve only this trusted process-local mutable reference.
    hasRepliedRef: context.hasRepliedRef,
    sameChannelThreadRequired: context.sameChannelThreadRequired,
    skipCrossContextDecoration: context.skipCrossContextDecoration,
  };
}

function sweepExpiredMessageActionTurnCapabilities(nowMs: number): void {
  for (const [token, capability] of capabilitiesByToken) {
    if (nowMs >= capability.expiresAtMs) {
      capabilitiesByToken.delete(token);
    }
  }
}

/**
 * Mint an opaque capability from admitted channel/dashboard input or a live cron occurrence.
 * Unattested Gateway agent requests never receive this token.
 */
export function mintMessageActionTurnCapability(params: {
  agentId: string;
  runId: string;
  sessionKey: string;
  sourceReplySessionKey?: string;
  sessionId?: string;
  requesterAccountId?: string;
  requesterSenderId?: string;
  requesterSenderName?: string;
  requesterSenderUsername?: string;
  requesterSenderE164?: string;
  toolContext?: InternalChannelThreadingToolContext;
  scheduled?: ScheduledMessageActionAuthority;
  assertDashboardReadCurrent?: () => void;
  expiresWithRun?: boolean;
  ttlMs?: number;
  nowMs?: number;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const runId = params.runId.trim();
  const sessionKey = params.sessionKey.trim();
  if (!agentId || !runId || !sessionKey) {
    throw new Error("message action turn capability requires agent, run, and session identity");
  }
  const nowMs = params.nowMs ?? Date.now();
  sweepExpiredMessageActionTurnCapabilities(nowMs);
  // A bounded fail-closed store prevents abandoned long-running turns from
  // growing process memory without creating a second persistent state path.
  pruneMapToMaxSize(capabilitiesByToken, MAX_ACTIVE_CAPABILITIES - 1);
  const token = randomBytes(32).toString("base64url");
  const capability: MessageActionTurnCapability = {
    agentId,
    runId,
    sessionKey,
    expiresAtMs: params.expiresWithRun
      ? RUN_LIFETIME_EXPIRES_AT_MS
      : nowMs + resolveTtlMs(params.ttlMs),
    sessionId: normalizeOptionalString(params.sessionId),
    sourceReplySessionKey: normalizeOptionalString(params.sourceReplySessionKey),
    requesterAccountId: normalizeOptionalString(params.requesterAccountId),
    requesterSenderId: normalizeOptionalString(params.requesterSenderId),
    requesterSenderName: normalizeOptionalString(params.requesterSenderName),
    requesterSenderUsername: normalizeOptionalString(params.requesterSenderUsername),
    requesterSenderE164: normalizeOptionalString(params.requesterSenderE164),
    toolContext: copyToolContext(params.toolContext),
  };
  const assertActive = () => {
    if (capabilitiesByToken.get(token) !== capability || Date.now() >= capability.expiresAtMs) {
      throw new Error("message action turn capability is no longer active");
    }
  };
  const scheduled = params.scheduled;
  if (scheduled) {
    const assertSourceCurrent = scheduled.assertSourceCurrent;
    capability.scheduled = {
      policy: structuredClone(scheduled.policy),
      ...(scheduled.channelRequester
        ? { channelRequester: structuredClone(scheduled.channelRequester) }
        : {}),
      assertCurrent: () => {
        assertActive();
        scheduled.assertCurrent();
      },
      ...(assertSourceCurrent
        ? {
            assertSourceCurrent: () => {
              assertActive();
              assertSourceCurrent();
            },
          }
        : {}),
    };
  }
  const assertDashboardReadCurrent = params.assertDashboardReadCurrent;
  if (assertDashboardReadCurrent) {
    capability.assertDashboardReadCurrent = () => {
      assertActive();
      assertDashboardReadCurrent();
    };
  }
  capabilitiesByToken.set(token, capability);
  return token;
}

type MessageActionTurnCapabilityLookup = {
  token?: string;
  agentId: string;
  runId?: string;
  sessionKey: string;
  sessionId?: string;
  nowMs?: number;
};

function resolveStoredMessageActionTurnCapability(
  params: MessageActionTurnCapabilityLookup,
): MessageActionTurnCapability | undefined {
  const token = params.token?.trim();
  if (!token) {
    return undefined;
  }
  const capability = capabilitiesByToken.get(token);
  if (!capability) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  if (nowMs >= capability.expiresAtMs) {
    capabilitiesByToken.delete(token);
    return undefined;
  }
  if (
    capability.agentId !== normalizeAgentId(params.agentId) ||
    capability.runId !== params.runId?.trim() ||
    capability.sessionKey !== params.sessionKey.trim() ||
    (capability.sessionId && capability.sessionId !== normalizeOptionalString(params.sessionId))
  ) {
    return undefined;
  }
  return capability;
}

/** Serializable context deliberately excludes host-only grants and their closures. */
export function resolveMessageActionTurnCapability(
  params: MessageActionTurnCapabilityLookup,
): AgentRuntimeMessageActionContext | undefined {
  const capability = resolveStoredMessageActionTurnCapability(params);
  if (!capability) {
    return undefined;
  }
  return copyMessageActionTurnContext(capability);
}

function copyMessageActionTurnContext(
  capability: MessageActionTurnCapability,
): AgentRuntimeMessageActionContext {
  return {
    expiresAtMs: capability.expiresAtMs,
    sessionId: capability.sessionId,
    sourceReplySessionKey: capability.sourceReplySessionKey,
    ...selectMessageActionRequesterIdentity(capability),
    toolContext: copyToolContext(capability.toolContext),
  };
}

/** Redeems private authority only in the host that owns the opaque capability. */
export function resolveMessageActionTurnAuthorization(
  params: MessageActionTurnCapabilityLookup,
): (AgentRuntimeMessageActionContext & MessageActionAuthorization) | undefined {
  const capability = resolveStoredMessageActionTurnCapability(params);
  return capability
    ? {
        ...copyMessageActionTurnContext(capability),
        scheduled: capability.scheduled,
        assertDashboardReadCurrent: capability.assertDashboardReadCurrent,
      }
    : undefined;
}

export function revokeMessageActionTurnCapability(token: string | undefined): boolean {
  return token ? capabilitiesByToken.delete(token) : false;
}
