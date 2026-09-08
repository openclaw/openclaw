// Imported CLI history merge helpers.
// Deduplicates external history messages against local OpenClaw transcripts.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  hashCliImageTurnEntryId,
  readCliImageTurnContext,
} from "../agents/cli-image-turn-correlation.js";
import { isOpenClawCliImageCachePath } from "../agents/embedded-agent-runner/run/images.media-refs.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { isImageMediaFact, readPersistedMediaFacts } from "../media/media-facts.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";

const DEDUPE_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

type ComparableHistoryMessage = {
  message: unknown;
  order: number;
  externalIdentityKey?: string;
  hasCliImageMentions: boolean;
  cliImageTurnKey?: string;
  role?: string;
  text?: string;
  timestamp?: number;
};

type TimestampSummary = {
  missingTimestamps: ComparableHistoryMessage[];
  buckets: Map<number, ComparableHistoryMessage[]>;
};

type RoleTextIndex = Map<string, Map<string, TimestampSummary>>;

// Claude records CLI-injected @cache-path suffixes as user text. Keep the
// stored content intact; this normalized view is only for proving a redundant
// imported row against the local turn that owns the durable media facts.
function stripTrailingCliImageMentions(text: string): {
  text: string;
  stripped: boolean;
} {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1]?.trim() ?? "";
    if (!line.startsWith("@") || !isOpenClawCliImageCachePath(line.slice(1))) {
      break;
    }
    end -= 1;
  }
  return end === lines.length
    ? { text, stripped: false }
    : { text: lines.slice(0, end).join("\n").trimEnd(), stripped: true };
}

function isClaudeCliImportedUserMessage(message: unknown, role: string | undefined): boolean {
  if (role !== "user") {
    return false;
  }
  const meta = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  return normalizeOptionalString(meta?.importedFrom) === "claude-cli";
}

function extractComparableText(
  message: unknown,
  role: string | undefined,
): {
  hasCliImageMentions: boolean;
  cliImageTurnKey?: string;
  text?: string;
} {
  if (!message || typeof message !== "object") {
    return { hasCliImageMentions: false };
  }
  const record = message as { role?: unknown; text?: unknown; content?: unknown };
  const parts: string[] = [];
  const text = readStringValue(record.text);
  if (text !== undefined) {
    parts.push(text);
  }
  const rawContent = record.content;
  const content = readStringValue(rawContent);
  if (content !== undefined) {
    parts.push(content);
  } else if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (block && typeof block === "object" && "text" in block) {
        const blockText = readStringValue(block.text);
        if (blockText !== undefined) {
          parts.push(blockText);
        }
      }
    }
  }
  if (parts.length === 0) {
    return { hasCliImageMentions: false };
  }
  const joined = parts.join("\n").trim();
  if (!joined) {
    return { hasCliImageMentions: false };
  }
  const stripResult = isClaudeCliImportedUserMessage(message, role)
    ? stripTrailingCliImageMentions(joined)
    : { text: joined, stripped: false };
  const visible = stripInlineDirectiveTagsForDisplay(
    role === "user" ? stripInboundMetadata(stripResult.text) : stripResult.text,
  ).text;
  const normalized = visible.replace(/\s+/g, " ").trim();
  const meta = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  const storedImageTurnKey = normalizeOptionalString(meta?.cliImageTurnKey);
  return {
    hasCliImageMentions: stripResult.stripped,
    ...(stripResult.stripped && isClaudeCliImportedUserMessage(message, role)
      ? { cliImageTurnKey: storedImageTurnKey ?? readCliImageTurnContext(joined) }
      : {}),
    ...(normalized ? { text: normalized } : {}),
  };
}

function prepareComparableMessage(
  message: unknown,
  order: number,
  externalIdentityKey: string | undefined,
): ComparableHistoryMessage {
  if (!message || typeof message !== "object") {
    return { message, order, hasCliImageMentions: false };
  }
  const record = message as { role?: unknown; timestamp?: unknown };
  const role = readStringValue(record.role);
  const comparableText = extractComparableText(message, role);
  return {
    message,
    order,
    externalIdentityKey,
    hasCliImageMentions: comparableText.hasCliImageMentions,
    ...(comparableText.cliImageTurnKey ? { cliImageTurnKey: comparableText.cliImageTurnKey } : {}),
    role,
    text: comparableText.text,
    timestamp: asFiniteNumber(record.timestamp),
  };
}

// External identity survives text edits, so it is the strongest match signal
// for imported messages from Claude CLI or similar external histories.
function resolveImportedExternalIdentityKey(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const rawMeta = (message as { __openclaw?: unknown })["__openclaw"];
  if (!rawMeta || typeof rawMeta !== "object") {
    return undefined;
  }
  const externalId = normalizeOptionalString((rawMeta as { externalId?: unknown }).externalId);
  return externalId
    ? JSON.stringify([
        externalId,
        normalizeOptionalString((rawMeta as { importedFrom?: unknown }).importedFrom),
        normalizeOptionalString((rawMeta as { cliSessionId?: unknown }).cliSessionId),
      ])
    : undefined;
}

function addTimestampToSummary(summary: TimestampSummary, entry: ComparableHistoryMessage): void {
  if (entry.timestamp === undefined) {
    summary.missingTimestamps.push(entry);
    return;
  }
  const bucketKey = Math.floor(entry.timestamp / DEDUPE_TIMESTAMP_WINDOW_MS);
  const bucket = summary.buckets.get(bucketKey) ?? [];
  bucket.push(entry);
  summary.buckets.set(bucketKey, bucket);
}

function findTimestampMatch(
  summary: TimestampSummary | undefined,
  timestamp: number | undefined,
  consumed: Set<ComparableHistoryMessage>,
): ComparableHistoryMessage | undefined {
  if (!summary) {
    return undefined;
  }
  if (timestamp === undefined) {
    const missingTimestamp = summary.missingTimestamps.find((entry) => !consumed.has(entry));
    if (missingTimestamp) {
      return missingTimestamp;
    }
    for (const bucket of summary.buckets.values()) {
      const candidate = bucket.find((entry) => !consumed.has(entry));
      if (candidate) {
        return candidate;
      }
    }
    return undefined;
  }
  const bucketKey = Math.floor(timestamp / DEDUPE_TIMESTAMP_WINDOW_MS);
  const pickCandidate = (
    bucket: ComparableHistoryMessage[] | undefined,
    direction: "earliest" | "latest",
  ) => {
    let selected: ComparableHistoryMessage | undefined;
    for (const candidate of bucket ?? []) {
      if (consumed.has(candidate)) {
        continue;
      }
      if (
        !selected ||
        (direction === "earliest"
          ? (candidate.timestamp ?? Infinity) < (selected.timestamp ?? Infinity)
          : (candidate.timestamp ?? -Infinity) > (selected.timestamp ?? -Infinity))
      ) {
        selected = candidate;
      }
    }
    return selected;
  };
  const current = pickCandidate(summary.buckets.get(bucketKey), "earliest");
  if (current) {
    return current;
  }
  const previous = pickCandidate(summary.buckets.get(bucketKey - 1), "latest");
  if (
    previous?.timestamp !== undefined &&
    previous.timestamp >= timestamp - DEDUPE_TIMESTAMP_WINDOW_MS
  ) {
    return previous;
  }
  const next = pickCandidate(summary.buckets.get(bucketKey + 1), "earliest");
  if (next?.timestamp !== undefined && next.timestamp <= timestamp + DEDUPE_TIMESTAMP_WINDOW_MS) {
    return next;
  }
  return summary.missingTimestamps.find((entry) => !consumed.has(entry));
}

function addRoleTextCandidate(index: RoleTextIndex, entry: ComparableHistoryMessage): void {
  if (!entry.role || !entry.text) {
    return;
  }
  let byText = index.get(entry.role);
  if (!byText) {
    byText = new Map();
    index.set(entry.role, byText);
  }
  let summary = byText.get(entry.text);
  if (!summary) {
    summary = { missingTimestamps: [], buckets: new Map() };
    byText.set(entry.text, summary);
  }
  addTimestampToSummary(summary, entry);
}

function findRoleTextCandidate(
  index: RoleTextIndex,
  entry: ComparableHistoryMessage,
  consumed: Set<ComparableHistoryMessage>,
): ComparableHistoryMessage | undefined {
  if (!entry.role || !entry.text) {
    return undefined;
  }
  return findTimestampMatch(index.get(entry.role)?.get(entry.text), entry.timestamp, consumed);
}

function hasLocalImageMediaFacts(entry: ComparableHistoryMessage): boolean {
  if (entry.role !== "user") {
    return false;
  }
  const message = asOptionalRecord(entry.message);
  return message ? (readPersistedMediaFacts(message) ?? []).some(isImageMediaFact) : false;
}

// A deduplicated local row remains the display owner, but imported identity
// must follow it so resume and history consumers retain the native session.
function projectImportedIdentity(localMessage: unknown, importedMessage: unknown): unknown {
  const local = asOptionalRecord(localMessage);
  const imported = asOptionalRecord(importedMessage);
  const importedMeta = asOptionalRecord(imported?.["__openclaw"]);
  if (!local || !importedMeta) {
    return localMessage;
  }
  const localMeta = asOptionalRecord(local["__openclaw"]);
  const nextMeta = localMeta ? { ...localMeta } : {};
  let changed = false;
  for (const field of ["importedFrom", "externalId", "cliSessionId"] as const) {
    const value = normalizeOptionalString(importedMeta[field]);
    if (value && nextMeta[field] === undefined) {
      nextMeta[field] = value;
      changed = true;
    }
  }
  return changed ? { ...local, __openclaw: nextMeta } : localMessage;
}

function compareHistoryMessages(a: ComparableHistoryMessage, b: ComparableHistoryMessage): number {
  if (a.timestamp !== undefined && b.timestamp !== undefined && a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  return a.order - b.order;
}

/** Merges imported CLI transcript messages into local history without duplicating overlaps. */
export function mergeImportedChatHistoryMessages(params: {
  localMessages: unknown[];
  importedMessages: unknown[];
}): unknown[] {
  if (params.importedMessages.length === 0) {
    return params.localMessages;
  }
  const merged = params.localMessages.map((message, order) =>
    prepareComparableMessage(message, order, resolveImportedExternalIdentityKey(message)),
  );
  const exactExternalIdentityIndex = new Map<string, ComparableHistoryMessage>();
  const allMessageRoleTextIndex: RoleTextIndex = new Map();
  const identitylessRoleTextIndex: RoleTextIndex = new Map();
  const localImageMediaCandidates = new Map<string, ComparableHistoryMessage[]>();
  const consumedLocalCandidates = new Set<ComparableHistoryMessage>();
  const indexEntry = (entry: ComparableHistoryMessage) => {
    if (entry.externalIdentityKey) {
      exactExternalIdentityIndex.set(entry.externalIdentityKey, entry);
    } else {
      addRoleTextCandidate(identitylessRoleTextIndex, entry);
    }
    addRoleTextCandidate(allMessageRoleTextIndex, entry);
  };
  for (const entry of merged) {
    indexEntry(entry);
    if (!hasLocalImageMediaFacts(entry)) {
      continue;
    }
    const localMeta = asOptionalRecord(asOptionalRecord(entry.message)?.["__openclaw"]);
    const localEntryId = normalizeOptionalString(localMeta?.id);
    const turnKey = localEntryId ? hashCliImageTurnEntryId(localEntryId) : entry.cliImageTurnKey;
    if (turnKey) {
      const candidates = localImageMediaCandidates.get(turnKey) ?? [];
      candidates.push(entry);
      localImageMediaCandidates.set(turnKey, candidates);
    }
  }
  let changed = false;
  let nextOrder = merged.length;
  for (const message of params.importedMessages) {
    const externalIdentityKey = resolveImportedExternalIdentityKey(message);
    if (externalIdentityKey && exactExternalIdentityIndex.has(externalIdentityKey)) {
      continue;
    }
    const imported = prepareComparableMessage(message, nextOrder, externalIdentityKey);
    const turnKey = imported.hasCliImageMentions ? imported.cliImageTurnKey : undefined;
    const imageDuplicate = turnKey ? localImageMediaCandidates.get(turnKey)?.shift() : undefined;
    if (imageDuplicate) {
      // Each local image turn suppresses one import while retaining the native
      // identity on the media-bearing row that remains visible.
      const projected = projectImportedIdentity(imageDuplicate.message, imported.message);
      if (projected !== imageDuplicate.message) {
        imageDuplicate.message = projected;
        imageDuplicate.externalIdentityKey = resolveImportedExternalIdentityKey(projected);
        if (imageDuplicate.externalIdentityKey) {
          exactExternalIdentityIndex.set(imageDuplicate.externalIdentityKey, imageDuplicate);
        }
        changed = true;
      }
      consumedLocalCandidates.add(imageDuplicate);
      continue;
    }
    const duplicate = imported.externalIdentityKey
      ? findRoleTextCandidate(identitylessRoleTextIndex, imported, consumedLocalCandidates)
      : findRoleTextCandidate(allMessageRoleTextIndex, imported, consumedLocalCandidates);
    if (!imported.hasCliImageMentions && duplicate) {
      const projected = projectImportedIdentity(duplicate.message, imported.message);
      if (projected !== duplicate.message) {
        duplicate.message = projected;
        duplicate.externalIdentityKey = resolveImportedExternalIdentityKey(projected);
        if (duplicate.externalIdentityKey) {
          exactExternalIdentityIndex.set(duplicate.externalIdentityKey, duplicate);
        }
        changed = true;
      }
      consumedLocalCandidates.add(duplicate);
      continue;
    }
    merged.push(imported);
    indexEntry(imported);
    nextOrder += 1;
    changed = true;
  }
  if (!changed) {
    return params.localMessages;
  }
  merged.sort(compareHistoryMessages);
  return merged.map((entry) => entry.message);
}
