import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import {
  parseToolsBySenderTypedKey,
  type GroupToolPolicyBySenderConfig,
  type GroupToolPolicyConfig,
  type ToolsBySenderKeyType,
} from "./types.tools.js";

export type GroupToolPolicySender = {
  /** Skip sender-specific overlays for trusted non-ingress executions. */
  senderPolicyMode?: "always" | "never";
  messageProvider?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

type CompiledSenderPolicy = {
  buckets: SenderPolicyBuckets;
  wildcard?: GroupToolPolicyConfig;
};

const compiledToolsBySenderCache = new WeakMap<
  GroupToolPolicyBySenderConfig,
  CompiledSenderPolicy
>();

type SenderPolicyBuckets = Record<ToolsBySenderKeyType, Map<string, GroupToolPolicyConfig>>;

function normalizeSenderKey(value: string, stripLeadingAt = false): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutAt = stripLeadingAt && trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return normalizeLowercaseStringOrEmpty(withoutAt);
}

function normalizeTypedSenderKey(value: string, type: ToolsBySenderKeyType): string {
  if (type === "channel") {
    return normalizeChannelSenderKey(value);
  }
  return normalizeSenderKey(value, type === "username");
}

function normalizeSenderPolicyChannel(value: string | null | undefined): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return "";
  }
  return normalizeMessageChannel(trimmed) ?? normalizeSenderKey(trimmed);
}

function normalizeChannelSenderKey(value: string): string {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return "";
  }
  const channel = normalizeSenderPolicyChannel(trimmed.slice(0, separatorIndex));
  const senderId = normalizeTypedSenderKey(trimmed.slice(separatorIndex + 1), "id");
  if (!channel || !senderId) {
    return "";
  }
  return `${channel}:${senderId}`;
}

function resolveCompiledToolsBySenderPolicy(
  toolsBySender: GroupToolPolicyBySenderConfig,
): CompiledSenderPolicy | undefined {
  const cached = compiledToolsBySenderCache.get(toolsBySender);
  if (cached) {
    return cached;
  }
  const entries = Object.entries(toolsBySender);
  if (entries.length === 0) {
    return undefined;
  }

  const buckets: SenderPolicyBuckets = {
    channel: new Map(),
    id: new Map(),
    e164: new Map(),
    username: new Map(),
    name: new Map(),
  };
  let wildcard: GroupToolPolicyConfig | undefined;
  for (const [rawKey, policy] of entries) {
    if (!policy) {
      continue;
    }
    const trimmed = rawKey.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      wildcard = policy;
      continue;
    }
    const typed = parseToolsBySenderTypedKey(trimmed);
    if (!typed) {
      throw new Error('Untyped toolsBySender keys are retired. Run "openclaw doctor --fix".');
    }
    const key = normalizeTypedSenderKey(typed.value, typed.type);
    const bucket = buckets[typed.type];
    if (key && !bucket.has(key)) {
      bucket.set(key, policy);
    }
  }

  const compiled = { buckets, wildcard };
  // Config is loaded once and treated as immutable; cache compiled sender policy by object identity.
  compiledToolsBySenderCache.set(toolsBySender, compiled);
  return compiled;
}

function normalizeSenderIdCandidates(value: string | null | undefined): string[] {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return [];
  }
  const typed = normalizeTypedSenderKey(trimmed, "id");
  const withoutAt = normalizeSenderKey(trimmed, true);
  if (!withoutAt || withoutAt === typed) {
    return [typed];
  }
  return [typed, withoutAt];
}

function matchToolsBySenderPolicy(
  compiled: CompiledSenderPolicy,
  params: GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
  const senderIdCandidates = normalizeSenderIdCandidates(params.senderId);
  const channel = normalizeSenderPolicyChannel(params.messageProvider);
  for (const type of ["channel", "id"] as const) {
    if (type === "channel" && !channel) {
      continue;
    }
    for (const senderIdCandidate of senderIdCandidates) {
      const key = type === "channel" ? `${channel}:${senderIdCandidate}` : senderIdCandidate;
      const match = compiled.buckets[type].get(key);
      if (match) {
        return match;
      }
    }
  }
  for (const [type, value] of [
    ["e164", params.senderE164],
    ["username", params.senderUsername],
    ["name", params.senderName],
  ] as const) {
    const candidate = normalizeTypedSenderKey(normalizeOptionalString(value) ?? "", type);
    if (candidate) {
      const match = compiled.buckets[type].get(candidate);
      if (match) {
        return match;
      }
    }
  }
  return compiled.wildcard;
}

export function resolveToolsBySender(
  params: {
    toolsBySender?: GroupToolPolicyBySenderConfig;
  } & GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
  const toolsBySender = params.toolsBySender;
  if (!toolsBySender) {
    return undefined;
  }
  const compiled = resolveCompiledToolsBySenderPolicy(toolsBySender);
  if (!compiled) {
    return undefined;
  }
  return matchToolsBySenderPolicy(compiled, params);
}
