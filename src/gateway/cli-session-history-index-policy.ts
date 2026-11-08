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
import { stripCliSessionDriftNote } from "../agents/cli-session-drift.js";
import { isOpenClawCliImageCachePath } from "../agents/embedded-agent-runner/run/images.media-refs.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { isImageMediaFact, readPersistedMediaFacts } from "../media/media-facts.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";

export const DEDUPE_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

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

function extractComparableText(
  record: Record<string, unknown>,
  role: string | undefined,
  imported: boolean,
): {
  hasCliImageMentions: boolean;
  cliImageTurnKey?: string;
  text?: string;
  driftNoteText?: string;
} {
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
  const rawText = parts.join("\n");
  const joined = rawText.trim();
  if (!joined) {
    return { hasCliImageMentions: false };
  }
  const meta = asOptionalRecord(record["__openclaw"]);
  const isClaudeImport =
    imported && role === "user" && normalizeOptionalString(meta?.importedFrom) === "claude-cli";
  const stripResult = isClaudeImport
    ? stripTrailingCliImageMentions(joined)
    : { text: joined, stripped: false };
  const normalizeText = (value: string) => {
    const visible = stripInlineDirectiveTagsForDisplay(
      role === "user" ? stripInboundMetadata(value) : value,
    ).text;
    return visible.replace(/\s+/g, " ").trim();
  };
  const normalized = normalizeText(stripResult.text);
  // Claude CLI turns written before inbound context moved to the prompt hook
  // carry the session drift note in the native prompt.
  const withoutDriftNote = isClaudeImport ? stripCliSessionDriftNote(rawText) : rawText;
  const driftNoteText =
    withoutDriftNote !== rawText
      ? normalizeText(stripTrailingCliImageMentions(withoutDriftNote.trim()).text)
      : undefined;
  const storedImageTurnKey = normalizeOptionalString(meta?.cliImageTurnKey);
  return {
    hasCliImageMentions: stripResult.stripped,
    ...(stripResult.stripped && isClaudeImport
      ? { cliImageTurnKey: storedImageTurnKey ?? readCliImageTurnContext(joined) }
      : {}),
    ...(normalized ? { text: normalized } : {}),
    ...(driftNoteText ? { driftNoteText } : {}),
  };
}

// External identity survives text edits, so it is the strongest match signal
// for imported messages from Claude CLI or similar external histories.
function resolveImportedExternalIdentityKey(
  meta: Record<string, unknown> | undefined,
): string | undefined {
  const externalId = normalizeOptionalString(meta?.externalId);
  return externalId
    ? JSON.stringify([
        externalId,
        normalizeOptionalString(meta?.importedFrom),
        normalizeOptionalString(meta?.cliSessionId),
      ])
    : undefined;
}

export type HistoryRow = {
  id: number;
  local_seq: number | null;
  import_ref: number | null;
  message_id: string | null;
  payload: string | null;
  bytes: number;
  role: string | null;
  text: string | null;
  drift_text: string | null;
  timestamp: number | null;
  external_key: string | null;
  image_key: string | null;
  image_mentions: number;
  metadata: string | null;
  consumed: number;
  ordinal: number | null;
};
export function createCliHistoryRow(message: unknown, id: number, localSeq?: number): HistoryRow {
  const record = asOptionalRecord(message);
  const meta = asOptionalRecord(record?.["__openclaw"]);
  const role = record?.role === "user" || record?.role === "assistant" ? record.role : undefined;
  const comparable: ReturnType<typeof extractComparableText> =
    record && role
      ? extractComparableText(record, role, localSeq === undefined)
      : { hasCliImageMentions: false };
  const localImage =
    record?.role === "user" && (readPersistedMediaFacts(record) ?? []).some(isImageMediaFact);
  const entryId = normalizeOptionalString(meta?.id);
  const serialized = JSON.stringify(message);
  return {
    id,
    local_seq: localSeq ?? null,
    import_ref: null,
    message_id: entryId === undefined ? null : JSON.stringify(entryId),
    payload: localSeq === undefined ? serialized : null,
    bytes: Buffer.byteLength(serialized, "utf8"),
    role: role ?? null,
    text: comparable.text === undefined ? null : JSON.stringify(comparable.text),
    drift_text:
      comparable.driftNoteText === undefined ? null : JSON.stringify(comparable.driftNoteText),
    timestamp: asFiniteNumber(record?.timestamp) ?? null,
    external_key: resolveImportedExternalIdentityKey(meta) ?? null,
    image_key:
      localSeq === undefined
        ? (comparable.cliImageTurnKey ?? null)
        : localImage
          ? ((entryId ? hashCliImageTurnEntryId(entryId) : comparable.cliImageTurnKey) ?? null)
          : null,
    image_mentions: comparable.hasCliImageMentions ? 1 : 0,
    metadata: meta ? JSON.stringify(meta) : null,
    consumed: 0,
    ordinal: null,
  };
}

export type HistoryMatch = Pick<HistoryRow, "id" | "text" | "metadata" | "role">;
export type HistoryTextMatch = {
  role: string;
  text: string;
  floor: number;
  timestamp: number | null;
};
type HistoryTextMatchers = Record<
  "withIdentity" | "withoutIdentity",
  Record<"any" | "window" | "missing", (params: HistoryTextMatch) => HistoryMatch | undefined>
>;
export type CliHistoryMergeStore = {
  matchExternal: (key: string) => HistoryMatch | undefined;
  matchImage: (key: string) => HistoryMatch | undefined;
  matchers: HistoryTextMatchers;
  minimumOrder: (role: string | null, text: string) => number;
  advanceOrderFloor: (floor: { role: string; text: string; minimumOrder: number }) => void;
  consume: (row: Pick<HistoryRow, "id" | "metadata" | "external_key">) => void;
  onMatch?: (
    imported: Omit<HistoryRow, "payload">,
    matched: HistoryMatch,
    byIdentity: boolean,
  ) => void;
};

export function mergeCliHistoryRow(
  imported: Omit<HistoryRow, "payload">,
  store: CliHistoryMergeStore,
): boolean {
  const { matchExternal, matchImage, matchers, minimumOrder, consume } = store;
  const advance = (matched: Pick<HistoryRow, "id" | "text">) => {
    for (const text of new Set([
      imported.text,
      matched.text === imported.text ? imported.text : imported.drift_text,
    ])) {
      if (text) {
        store.advanceOrderFloor({ role: imported.role ?? "", text, minimumOrder: matched.id + 1 });
      }
    }
  };
  let duplicate = imported.external_key ? matchExternal(imported.external_key) : undefined;
  if (duplicate) {
    store.onMatch?.(imported, duplicate, true);
    advance(duplicate);
    return true;
  }
  if (imported.image_mentions && imported.image_key) {
    duplicate = matchImage(imported.image_key);
  }
  if (!duplicate && !imported.image_mentions) {
    const importedFloor = imported.text ? minimumOrder(imported.role, imported.text) : 0;
    for (const text of [imported.text, imported.drift_text]) {
      if (!text || !imported.role) {
        continue;
      }
      const floor =
        text === imported.text
          ? importedFloor
          : Math.max(minimumOrder(imported.role, text), importedFloor);
      const match = imported.external_key ? matchers.withIdentity : matchers.withoutIdentity;
      const params = { role: imported.role, text, floor, timestamp: imported.timestamp };
      duplicate =
        imported.timestamp === null
          ? match.any(params)
          : (match.window(params) ?? match.missing(params));
      if (duplicate) {
        break;
      }
    }
  }
  if (duplicate) {
    store.onMatch?.(imported, duplicate, Boolean(imported.image_mentions));
    const meta: Record<string, unknown> = duplicate.metadata ? JSON.parse(duplicate.metadata) : {};
    const importedMeta: Record<string, unknown> = imported.metadata
      ? JSON.parse(imported.metadata)
      : {};
    let metadataChanged = false;
    for (const field of ["importedFrom", "externalId", "cliSessionId"]) {
      const value = normalizeOptionalString(importedMeta[field]);
      if (value && meta[field] === undefined) {
        meta[field] = value;
        metadataChanged = true;
      }
    }
    consume({
      id: duplicate.id,
      metadata: metadataChanged ? JSON.stringify(meta) : duplicate.metadata,
      external_key: resolveImportedExternalIdentityKey(meta) ?? null,
    });
    advance(duplicate);
    return true;
  }
  return false;
}

type CliHistoryOrderRow = Pick<HistoryRow, "id" | "local_seq" | "timestamp">;

function compareImportedCliHistoryRows(a: CliHistoryOrderRow, b: CliHistoryOrderRow): number {
  if (a.timestamp !== null && b.timestamp !== null && a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  if (a.timestamp === null && b.timestamp !== null) {
    return 1;
  }
  if (a.timestamp !== null && b.timestamp === null) {
    return -1;
  }
  return a.id - b.id;
}

function isLocalCliHistoryRow<T extends CliHistoryOrderRow>(
  row: T,
): row is T & { local_seq: number } {
  return row.local_seq !== null;
}

function attachCliHistoryImport<T extends CliHistoryOrderRow>(
  imported: T,
  anchor: T | undefined,
  before: T[],
  afterLocal: Map<number, T[]>,
): void {
  if (!anchor) {
    before.push(imported);
    return;
  }
  const attached = afterLocal.get(anchor.id);
  if (attached) {
    attached.push(imported);
    return;
  }
  afterLocal.set(anchor.id, [imported]);
}

// Prefix timestamps anchor imports without letting backdated locals move earlier
// activity past a preceding answer. Stored timestamps and local order stay intact.
export function orderCliHistoryRows<T extends CliHistoryOrderRow>(rows: readonly T[]): T[] {
  const locals = rows
    .filter(isLocalCliHistoryRow)
    .toSorted((a, b) => a.local_seq - b.local_seq || a.id - b.id);
  const imports = rows
    .filter((row) => row.local_seq === null)
    .toSorted(compareImportedCliHistoryRows);
  let localTime = Number.NEGATIVE_INFINITY;
  const before: T[] = [];
  const afterLocal = new Map<number, T[]>();
  let timeIndex = 0;
  let anchor: (typeof locals)[number] | undefined;
  for (const imported of imports) {
    if (imported.timestamp === null) {
      attachCliHistoryImport(imported, locals.at(-1), before, afterLocal);
      continue;
    }
    for (;;) {
      const candidate = locals[timeIndex];
      if (candidate === undefined) {
        break;
      }
      if (candidate.timestamp !== null) {
        localTime = Math.max(localTime, candidate.timestamp);
        if (localTime > imported.timestamp) {
          break;
        }
        anchor = candidate;
      }
      timeIndex += 1;
    }
    attachCliHistoryImport(imported, anchor, before, afterLocal);
  }
  const ordered = [...before];
  for (const local of locals) {
    ordered.push(local, ...(afterLocal.get(local.id) ?? []));
  }
  return ordered;
}

export type CliHistoryIndex = {
  readonly count: number;
  readonly importedCount: number;
  appendLocal: (messages: readonly { message: unknown; seq: number }[]) => void;
  appendImported: (message: unknown) => void;
  finish: () => void;
  rows: (
    start: number,
    end: number,
  ) => Pick<HistoryRow, "id" | "local_seq" | "metadata" | "ordinal" | "bytes">[];
  message: (id: number) => unknown;
  localOrdinal: (seq: number) => number | undefined;
  ordinal: (messageId: string) => number | undefined;
  close: () => void;
};
