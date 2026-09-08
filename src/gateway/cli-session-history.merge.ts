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
  missingTimestampCursor: number;
  timestampedByOrder: ComparableHistoryMessage[];
  timestampedOrderCursor: number;
};

type RoleTextIndex = Map<string, Map<string, TimestampSummary>>;

type ConsumableCandidates = {
  entries: ComparableHistoryMessage[];
  cursor: number;
};

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
  summary.timestampedByOrder.push(entry);
}

function findTimestampMatch(
  summary: TimestampSummary | undefined,
  timestamp: number | undefined,
  consumed: Set<ComparableHistoryMessage>,
  minimumOrder: number,
): ComparableHistoryMessage | undefined {
  if (!summary) {
    return undefined;
  }
  while (
    summary.missingTimestampCursor < summary.missingTimestamps.length &&
    (summary.missingTimestamps[summary.missingTimestampCursor]?.order ?? Number.POSITIVE_INFINITY) <
      minimumOrder
  ) {
    summary.missingTimestampCursor += 1;
  }
  while (
    summary.timestampedOrderCursor < summary.timestampedByOrder.length &&
    (summary.timestampedByOrder[summary.timestampedOrderCursor]?.order ??
      Number.POSITIVE_INFINITY) < minimumOrder
  ) {
    summary.timestampedOrderCursor += 1;
  }
  if (timestamp === undefined) {
    while (summary.missingTimestampCursor < summary.missingTimestamps.length) {
      const candidate = summary.missingTimestamps[summary.missingTimestampCursor];
      if (candidate && !consumed.has(candidate)) {
        break;
      }
      summary.missingTimestampCursor += 1;
    }
    while (summary.timestampedOrderCursor < summary.timestampedByOrder.length) {
      const candidate = summary.timestampedByOrder[summary.timestampedOrderCursor];
      if (candidate && !consumed.has(candidate)) {
        break;
      }
      summary.timestampedOrderCursor += 1;
    }
    const missing = summary.missingTimestamps[summary.missingTimestampCursor];
    const timestamped = summary.timestampedByOrder[summary.timestampedOrderCursor];
    const candidate =
      missing && (!timestamped || missing.order < timestamped.order) ? missing : timestamped;
    if (!candidate) {
      return undefined;
    }
    if (candidate === missing) {
      summary.missingTimestampCursor += 1;
    } else {
      summary.timestampedOrderCursor += 1;
    }
    return candidate;
  }
  // The order floor only moves forward. Once a later transcript row matches,
  // earlier nonmatching rows cannot be assigned to a later import without
  // reversing external identity order, so each candidate is examined once.
  while (summary.timestampedOrderCursor < summary.timestampedByOrder.length) {
    const candidate = summary.timestampedByOrder[summary.timestampedOrderCursor];
    summary.timestampedOrderCursor += 1;
    if (
      candidate &&
      !consumed.has(candidate) &&
      candidate.timestamp !== undefined &&
      Math.abs(candidate.timestamp - timestamp) <= DEDUPE_TIMESTAMP_WINDOW_MS
    ) {
      return candidate;
    }
  }
  while (summary.missingTimestampCursor < summary.missingTimestamps.length) {
    const candidate = summary.missingTimestamps[summary.missingTimestampCursor];
    summary.missingTimestampCursor += 1;
    if (candidate && !consumed.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
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
    summary = {
      missingTimestamps: [],
      missingTimestampCursor: 0,
      timestampedByOrder: [],
      timestampedOrderCursor: 0,
    };
    byText.set(entry.text, summary);
  }
  addTimestampToSummary(summary, entry);
}

function findRoleTextCandidate(
  index: RoleTextIndex,
  entry: ComparableHistoryMessage,
  consumed: Set<ComparableHistoryMessage>,
  minimumOrder: number,
): ComparableHistoryMessage | undefined {
  if (!entry.role || !entry.text) {
    return undefined;
  }
  return findTimestampMatch(
    index.get(entry.role)?.get(entry.text),
    entry.timestamp,
    consumed,
    minimumOrder,
  );
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
  const roleTextMinimumOrder = new Map<string, number>();
  const localImageMediaCandidates = new Map<string, ConsumableCandidates>();
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
      const candidates = localImageMediaCandidates.get(turnKey) ?? { entries: [], cursor: 0 };
      candidates.entries.push(entry);
      localImageMediaCandidates.set(turnKey, candidates);
    }
  }
  for (const message of params.importedMessages) {
    const externalIdentityKey = resolveImportedExternalIdentityKey(message);
    const exactIdentityMatch = externalIdentityKey
      ? exactExternalIdentityIndex.get(externalIdentityKey)
      : undefined;
    if (exactIdentityMatch) {
      consumedLocalCandidates.add(exactIdentityMatch);
    }
  }
  let changed = false;
  let expanded = false;
  let nextOrder = merged.length;
  for (const message of params.importedMessages) {
    const externalIdentityKey = resolveImportedExternalIdentityKey(message);
    const imported = prepareComparableMessage(message, nextOrder, externalIdentityKey);
    if (externalIdentityKey) {
      const exactIdentityMatch = exactExternalIdentityIndex.get(externalIdentityKey);
      if (exactIdentityMatch) {
        consumedLocalCandidates.add(exactIdentityMatch);
        if (imported.role && imported.text) {
          roleTextMinimumOrder.set(
            JSON.stringify([imported.role, imported.text]),
            exactIdentityMatch.order + 1,
          );
        }
        continue;
      }
    }
    const turnKey = imported.hasCliImageMentions ? imported.cliImageTurnKey : undefined;
    const imageCandidates = turnKey ? localImageMediaCandidates.get(turnKey) : undefined;
    let imageDuplicate: ComparableHistoryMessage | undefined;
    if (imageCandidates) {
      imageDuplicate = imageCandidates.entries[imageCandidates.cursor];
      while (imageDuplicate && consumedLocalCandidates.has(imageDuplicate)) {
        imageCandidates.cursor += 1;
        imageDuplicate = imageCandidates.entries[imageCandidates.cursor];
      }
      if (imageDuplicate) {
        imageCandidates.cursor += 1;
      }
    }
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
      if (imageDuplicate.role && imageDuplicate.text) {
        roleTextMinimumOrder.set(
          JSON.stringify([imageDuplicate.role, imageDuplicate.text]),
          imageDuplicate.order + 1,
        );
      }
      continue;
    }
    const roleTextKey =
      imported.role && imported.text ? JSON.stringify([imported.role, imported.text]) : undefined;
    const minimumOrder = roleTextKey ? (roleTextMinimumOrder.get(roleTextKey) ?? 0) : 0;
    const duplicate = imported.hasCliImageMentions
      ? undefined
      : imported.externalIdentityKey
        ? findRoleTextCandidate(
            identitylessRoleTextIndex,
            imported,
            consumedLocalCandidates,
            minimumOrder,
          )
        : findRoleTextCandidate(
            allMessageRoleTextIndex,
            imported,
            consumedLocalCandidates,
            minimumOrder,
          );
    if (duplicate) {
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
      if (roleTextKey) {
        roleTextMinimumOrder.set(roleTextKey, duplicate.order + 1);
      }
      continue;
    }
    merged.push(imported);
    indexEntry(imported);
    consumedLocalCandidates.add(imported);
    nextOrder += 1;
    changed = true;
    expanded = true;
  }
  if (!changed) {
    return params.localMessages;
  }
  if (!expanded) {
    return merged.map((entry) => entry.message);
  }
  merged.sort(compareHistoryMessages);
  return merged.map((entry) => entry.message);
}
