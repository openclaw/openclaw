import { normalizeOptionalLowercaseString } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeStringEntries } from "../../packages/normalization-core/src/string-normalization.js";
import { isAllowedParsedChatSender as isAllowedParsedChatSenderShared } from "../channels/plugins/chat-target-prefixes.js";

export type {
  AllowlistMatch,
  AllowlistMatchSource,
  CompiledAllowlist,
} from "../channels/allowlist-match.js";
export type { AllowlistUserResolutionLike } from "../channels/allowlists/resolve-utils.js";
export {
  compileAllowlist,
  formatAllowlistMatchMeta,
  resolveAllowlistCandidates,
  resolveAllowlistMatchByCandidates,
  resolveAllowlistMatchSimple,
  resolveCompiledAllowlistMatch,
} from "../channels/allowlist-match.js";
export {
  firstDefined,
  isSenderIdAllowed,
  mergeDmAllowFromSources,
  resolveGroupAllowFromSources,
} from "../channels/allow-from.js";
export {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  canonicalizeAllowlistWithResolvedIds,
  mergeAllowlist,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "../channels/allowlists/resolve-utils.js";

/** Lowercase and optionally strip prefixes from allowlist entries before sender comparisons. */
export function formatAllowFromLowercase(params: {
  /** Raw allowlist entries from config or setup input. */
  allowFrom: Array<string | number>;
  /** Optional channel prefix remover, for example telegram:/tg: aliases. */
  stripPrefixRe?: RegExp;
}): string[] {
  return normalizeStringEntries(params.allowFrom)
    .map((entry) => (params.stripPrefixRe ? entry.replace(params.stripPrefixRe, "") : entry))
    .map((entry) => normalizeOptionalLowercaseString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

/** Normalize allowlist entries through a channel-provided parser or canonicalizer. */
export function formatNormalizedAllowFromEntries(params: {
  /** Raw allowlist entries from config or setup input. */
  allowFrom: Array<string | number>;
  /** Channel parser that returns a stable comparable id, or nullish to drop invalid entries. */
  normalizeEntry: (entry: string) => string | undefined | null;
}): string[] {
  return normalizeStringEntries(params.allowFrom)
    .map((entry) => params.normalizeEntry(entry))
    .filter((entry): entry is string => Boolean(entry));
}

/** Check whether a sender id matches a simple normalized allowlist with wildcard support. */
export function isNormalizedSenderAllowed(params: {
  /** Sender id from the inbound channel event. */
  senderId: string | number;
  /** Raw allowlist entries compared after lowercase normalization. */
  allowFrom: Array<string | number>;
  /** Optional channel prefix remover applied before lowercase normalization. */
  stripPrefixRe?: RegExp;
}): boolean {
  const normalizedAllow = formatAllowFromLowercase({
    allowFrom: params.allowFrom,
    stripPrefixRe: params.stripPrefixRe,
  });
  if (normalizedAllow.length === 0) {
    return false;
  }
  if (normalizedAllow.includes("*")) {
    return true;
  }
  const sender = normalizeOptionalLowercaseString(String(params.senderId));
  return sender ? normalizedAllow.includes(sender) : false;
}

type ParsedChatAllowTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; handle: string };

/** Match allowlist entries against senders, with conversation targets requiring explicit opt-in. */
export function isAllowedParsedChatSender(params: {
  /** Raw allowlist entries that may include sender ids or conversation targets. */
  allowFrom: Array<string | number>;
  /** Sender id from the inbound channel event. */
  sender: string;
  /** Numeric conversation id for allowlist entries that target chats. */
  chatId?: number | null;
  /** Stable conversation guid for allowlist entries that target chats. */
  chatGuid?: string | null;
  /** Provider conversation identifier for allowlist entries that target chats. */
  chatIdentifier?: string | null;
  /** Enables chat-level matches; false keeps matching sender-only. */
  allowConversationTargets?: boolean | null;
  /** Channel-specific sender normalization. */
  normalizeSender: (sender: string) => string;
  /** Channel-specific parser for typed allowlist entries. */
  parseAllowTarget: (entry: string) => ParsedChatAllowTarget;
}): boolean {
  // Keep SDK callers on the same parser contract as core channel plugins.
  return isAllowedParsedChatSenderShared(params);
}

export type BasicAllowlistResolutionEntry = {
  /** Original user-provided allowlist entry. */
  input: string;
  /** True when the entry resolved to a stable platform id. */
  resolved: boolean;
  /** Stable platform id returned by the resolver. */
  id?: string;
  /** Human-readable name paired with the resolved id. */
  name?: string;
  /** Optional resolver note shown in summaries or setup output. */
  note?: string;
};

/** Clone allowlist resolution entries into a plain serializable shape for UI and docs output. */
export function mapBasicAllowlistResolutionEntries(
  entries: BasicAllowlistResolutionEntry[],
): BasicAllowlistResolutionEntry[] {
  return entries.map((entry) => ({
    input: entry.input,
    resolved: entry.resolved,
    id: entry.id,
    name: entry.name,
    note: entry.note,
  }));
}

/** Map allowlist inputs sequentially so resolver side effects stay ordered and predictable. */
export async function mapAllowlistResolutionInputs<T>(params: {
  /** User-provided entries in the order they should resolve. */
  inputs: string[];
  /** Resolver invoked one input at a time to preserve rate-limit/order semantics. */
  mapInput: (input: string) => Promise<T> | T;
}): Promise<T[]> {
  const results: T[] = [];
  for (const input of params.inputs) {
    results.push(await params.mapInput(input));
  }
  return results;
}
