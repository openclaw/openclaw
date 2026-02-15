export type {
  AgentToAgentPolicy,
  SessionAccessAction,
  SessionAccessResult,
  SessionToolsVisibility,
} from "./sessions-access.js";
export {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  resolveSessionToolsVisibility,
} from "./sessions-access.js";
export type { SessionReferenceResolution } from "./sessions-resolution.js";
export {
  isRequesterSpawnedSessionVisible,
  listSpawnedSessionKeys,
  looksLikeSessionId,
  looksLikeSessionKey,
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  resolveSessionReference,
  shouldResolveSessionIdInput,
} from "./sessions-resolution.js";
import { sanitizeUserFacingText } from "../pi-embedded-helpers.js";
import {
  stripDowngradedToolCallText,
  stripMinimaxToolCallXml,
  stripThinkingTagsFromText,
} from "../pi-embedded-utils.js";
import type { OpenClawConfig } from "../../config/config.js";

export type SessionKind = "main" | "group" | "cron" | "hook" | "node" | "other";

export type SessionListDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
};

export type SessionListRow = {
  key: string;
  kind: SessionKind;
  channel: string;
  label?: string;
  displayName?: string;
  deliveryContext?: SessionListDeliveryContext;
  updatedAt?: number | null;
  sessionId?: string;
  model?: string;
  contextTokens?: number | null;
  totalTokens?: number | null;
  thinkingLevel?: string;
  verboseLevel?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  sendPolicy?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  transcriptPath?: string;
  messages?: unknown[];
};

// ============== A2A Validation Constants ==============

/** Maximum serialized input size (1MB) */
export const MAX_A2A_INPUT_SIZE = 1024 * 1024;

/** Valid agent ID format: lowercase alphanumeric, underscore, hyphen */
export const AGENT_ID_RE = /^[a-z0-9_-]+$/;

/** Valid skill name format: alphanumeric, underscore, hyphen */
export const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Valid session key format for agent sessions: agent:<agentId>:<label> */
export const AGENT_SESSION_KEY_RE = /^agent:[a-z0-9_-]+:[a-z0-9_-]+$/;

/**
 * Validate an agent ID for A2A calls.
 * Returns normalized ID or throws on invalid input.
 */
export function validateAgentId(agentId: string): string {
  const normalized = agentId.toLowerCase().trim();
  if (!normalized) {
    throw new Error("Agent ID cannot be empty");
  }
  if (normalized.length > 64) {
    throw new Error("Agent ID too long (max 64 characters)");
  }
  if (!AGENT_ID_RE.test(normalized)) {
    throw new Error(`Invalid agent ID format: must match ${AGENT_ID_RE.source}`);
  }
  return normalized;
}

/**
 * Validate a skill name for A2A calls.
 * Returns normalized skill name or throws on invalid input.
 */
export function validateSkillName(skillName: string): string {
  const trimmed = skillName.trim();
  if (!trimmed) {
    throw new Error("Skill name cannot be empty");
  }
  if (trimmed.length > 128) {
    throw new Error("Skill name too long (max 128 characters)");
  }
  if (!SKILL_NAME_RE.test(trimmed)) {
    throw new Error(`Invalid skill name format: must match ${SKILL_NAME_RE.source}`);
  }
  return trimmed;
}

/**
 * Validate a session key for agent sessions.
 * Returns the key if valid, or throws.
 */
export function validateAgentSessionKey(sessionKey: string): string {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    throw new Error("Session key cannot be empty");
  }
  if (!AGENT_SESSION_KEY_RE.test(trimmed)) {
    throw new Error(`Invalid agent session key format: must match ${AGENT_SESSION_KEY_RE.source}`);
  }
  return trimmed;
}

/**
 * Check if a string looks like a session key (agent: prefix).
 * Does not validate format, just detects the pattern.
 */
export function isAgentSessionKeyRef(value: string): boolean {
  return value.trim().startsWith("agent:");
}

/**
 * Validate serialized input size to prevent DoS.
 * Throws if input exceeds MAX_A2A_INPUT_SIZE.
 */
export function validateInputSize(input: unknown, maxSize = MAX_A2A_INPUT_SIZE): void {
  try {
    const serialized = JSON.stringify(input);
    if (serialized.length > maxSize) {
      throw new Error(`Input too large: ${serialized.length} bytes (max: ${maxSize})`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Input too large")) {
      throw err;
    }
    throw new Error("Input could not be serialized", { cause: err });
  }
}

/**
 * Bound a confidence value to [0, 1].
 * Returns 0.5 for NaN, Infinity, or invalid values.
 */
export function boundConfidence(value: unknown): number {
  if (typeof value !== "number") {
    return 0.5;
  }
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, value));
}

/**
 * Check agent-to-agent policy for both requester and target agents.
 * Both must be authorized for the call to proceed.
 * Returns { allowed: true } or { allowed: false, error: string }.
 */
export function checkA2APolicy(
  cfg: OpenClawConfig,
  requesterAgentId: string,
  targetAgentId: string,
): { allowed: boolean; error?: string } {
  const a2aConfig = cfg.tools?.agentToAgent;

  if (!a2aConfig?.enabled) {
    return {
      allowed: false,
      error: "Agent-to-agent calls are disabled. Set tools.agentToAgent.enabled=true",
    };
  }

  const allowList = a2aConfig.allow ?? [];
  const allowAny = allowList.some((v) => v.trim() === "*");
  const allowSet = new Set(
    allowList.filter((v) => v.trim() && v.trim() !== "*").map((v) => v.toLowerCase()),
  );

  // P1 fix: Check requester is authorized to make A2A calls
  if (!allowAny && !allowSet.has(requesterAgentId.toLowerCase())) {
    return {
      allowed: false,
      error: `Requester agent '${requesterAgentId}' not authorized for A2A calls. Allowed: ${allowAny ? "*" : Array.from(allowSet).join(", ")}`,
    };
  }

  // Check target is authorized to receive A2A calls
  if (!allowAny && !allowSet.has(targetAgentId.toLowerCase())) {
    return {
      allowed: false,
      error: `Target agent '${targetAgentId}' not in allowlist. Allowed: ${allowAny ? "*" : Array.from(allowSet).join(", ")}`,
    };
  }

  return { allowed: true };
}

export function classifySessionKind(params: {
  key: string;
  gatewayKind?: string | null;
  alias: string;
  mainKey: string;
}): SessionKind {
  const key = params.key;
  if (key === params.alias || key === params.mainKey) {
    return "main";
  }
  if (key.startsWith("cron:")) {
    return "cron";
  }
  if (key.startsWith("hook:")) {
    return "hook";
  }
  if (key.startsWith("node-") || key.startsWith("node:")) {
    return "node";
  }
  if (params.gatewayKind === "group") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "other";
}

export function deriveChannel(params: {
  key: string;
  kind: SessionKind;
  channel?: string | null;
  lastChannel?: string | null;
}): string {
  if (params.kind === "cron" || params.kind === "hook" || params.kind === "node") {
    return "internal";
  }
  const channel = normalizeKey(params.channel ?? undefined);
  if (channel) {
    return channel;
  }
  const lastChannel = normalizeKey(params.lastChannel ?? undefined);
  if (lastChannel) {
    return lastChannel;
  }
  const parts = params.key.split(":").filter(Boolean);
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    return parts[0];
  }
  return "unknown";
}

function normalizeKey(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function stripToolMessages(messages: unknown[]): unknown[] {
  return messages.filter((msg) => {
    if (!msg || typeof msg !== "object") {
      return true;
    }
    const role = (msg as { role?: unknown }).role;
    return role !== "toolResult";
  });
}

/**
 * Sanitize text content to strip tool call markers and thinking tags.
 * This ensures user-facing text doesn't leak internal tool representations.
 */
export function sanitizeTextContent(text: string): string {
  if (!text) {
    return text;
  }
  return stripThinkingTagsFromText(stripDowngradedToolCallText(stripMinimaxToolCallXml(text)));
}

export function extractAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if ((block as { type?: unknown }).type !== "text") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") {
      const sanitized = sanitizeTextContent(text);
      if (sanitized.trim()) {
        chunks.push(sanitized);
      }
    }
  }
  const joined = chunks.join("").trim();
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
  const errorContext =
    stopReason === "error" || (typeof errorMessage === "string" && Boolean(errorMessage.trim()));

  return joined ? sanitizeUserFacingText(joined, { errorContext }) : undefined;
}