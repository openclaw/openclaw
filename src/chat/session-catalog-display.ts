import { asOptionalRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionCatalogTranscriptItem } from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";

const CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS = 500;

/** Facts retained beside imported text; never native execution or mount authority. */
export function catalogDisplayFacts(item: SessionCatalogTranscriptItem) {
  return {
    type: item.type,
    ...(item.phase !== undefined ? { phase: item.phase } : {}),
    ...(item.activity !== undefined ? { activity: item.activity } : {}),
    ...(item.toolDetails !== undefined ? { toolDetails: item.toolDetails } : {}),
    ...(item.toolName !== undefined ? { toolName: item.toolName } : {}),
    ...(item.toolCallId !== undefined ? { toolCallId: item.toolCallId } : {}),
    ...(item.toolInput !== undefined ? { toolInput: item.toolInput } : {}),
    ...(item.toolInputOmitted ? { toolInputOmitted: true } : {}),
    ...(item.isError !== undefined ? { isError: item.isError } : {}),
    ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
    ...(item.truncated ? { truncated: true } : {}),
    ...(!item.text?.trim() ? { emptyText: true } : {}),
  };
}

export function catalogItemTextPrefix(type: string): string {
  return type === "reasoning"
    ? "Thinking\n\n"
    : type === "toolCall"
      ? "Tool call\n\n"
      : type === "toolResult"
        ? "Tool result\n\n"
        : type === "other"
          ? "Other\n\n"
          : "";
}

type CatalogDisplayItem = {
  type: string;
  text?: string;
  id?: string;
  raw?: unknown;
  phase?: unknown;
  activity?: unknown;
  toolDetails?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  toolInput?: unknown;
  toolInputOmitted?: unknown;
  isError?: unknown;
  exitCode?: unknown;
  truncated?: unknown;
};

function rawText(raw: unknown, keys: string[]): string | undefined {
  const record = asOptionalRecord(raw);
  for (const key of keys) {
    const value = readStringField(record, key)?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

/** Same bounded presentation for a native catalog page and a preserved copy. */
export function projectCatalogItemForDisplay(
  item: CatalogDisplayItem,
): Record<string, unknown> | null {
  const tool = item.type === "toolCall" || item.type === "toolResult";
  const toolName = typeof item.toolName === "string" ? item.toolName.trim() : "";
  const toolCallId = typeof item.toolCallId === "string" ? item.toolCallId.trim() : "";
  const bound = (value: string) =>
    value.length > CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS
      ? `${truncateUtf16Safe(value, CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS - 1)}…`
      : value;
  const input =
    item.toolInputOmitted === true
      ? "[Tool input omitted: size limit]"
      : item.toolInput === null
        ? "null"
        : item.toolInput;
  let text = item.text?.trim() ? item.text : item.text === undefined ? undefined : "";
  if (item.type === "toolResult") {
    const result = asOptionalRecord(item.raw)?.result;
    text ??=
      rawText(item.raw, ["aggregatedOutput"]) ??
      (result === undefined ? undefined : JSON.stringify(result));
  } else if (item.type === "toolCall") {
    text ??= rawText(item.raw, ["command", "name", "tool", "title", "query"]);
  }
  const displayTruncated =
    tool && Boolean(text && text.length > CATALOG_TOOL_RESULT_PREVIEW_MAX_CHARS);
  if (tool && text) {
    text = bound(text);
  }
  const catalogTruncated = item.truncated === true || displayTruncated;
  // Keep receipt-only text/thinking visible; the UI owns the localized notice.
  if (!tool && catalogTruncated && !text) {
    text = "…";
  }
  const call = {
    type: "toolCall",
    ...(toolCallId ? { id: toolCallId } : {}),
    ...(toolName ? { name: toolName } : {}),
    ...(input !== undefined || text ? { arguments: input !== undefined ? input : text } : {}),
  };
  let content: unknown[];
  if (item.type === "toolCall") {
    content = [call];
  } else if (item.type === "toolResult") {
    content = [
      ...(input !== undefined ? [call] : []),
      {
        type: "toolResult",
        ...(toolName ? { name: toolName } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        content: [{ type: "text", text: text ?? "" }],
        ...(typeof item.isError === "boolean"
          ? { isError: item.isError }
          : {
              __openclaw: {
                toolOutput: { source: "execution", modelInput: "unverified", outcome: "unknown" },
              },
            }),
        ...(item.toolDetails !== undefined || typeof item.exitCode === "number"
          ? {
              details: {
                ...asOptionalRecord(item.toolDetails),
                ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
              },
            }
          : {}),
      },
    ];
  } else {
    if (!text) {
      return null;
    }
    content =
      item.type === "reasoning" ? [{ type: "thinking", thinking: text }] : [{ type: "text", text }];
  }
  return {
    ...(item.id ? { messageId: item.id } : {}),
    // Recorded text is visible data, including OpenClaw-looking control words.
    display: true,
    role: item.type === "userMessage" ? "user" : "assistant",
    ...(typeof item.phase === "string" ? { phase: item.phase } : {}),
    ...(item.activity !== undefined ? { activity: [item.activity] } : {}),
    __openclaw: { catalogSource: true, ...(catalogTruncated ? { catalogTruncated: true } : {}) },
    content,
  };
}

// Match only the complete, no-warning frame emitted by the Gateway catalog copy.
// Anchoring protects quoted/fenced examples and truncated or malformed history.
// The optional label belongs to session-catalog-history-import, not to the frame.
const IMPORT_FRAME =
  /^(?<label>(?:Thinking|Tool call|Tool result|Other)\r?\n\r?\n)?<<<EXTERNAL_UNTRUSTED_CONTENT id="(?<id>[a-f0-9]{16})">>>\r?\nSource: External\r?\n---\r?\n(?<body>[\s\S]*?)\r?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\k<id>">>>$/u;

function unwrapImportFrame(text: string): string {
  const match = IMPORT_FRAME.exec(text);
  return match?.groups ? (match.groups.label ?? "") + match.groups.body : text;
}

/** View only. Canonical imported text, including its trust frame, is never rewritten. */
export function projectPreservedCatalogMessageForDisplay(message: unknown): unknown[] {
  const record = asOptionalRecord(message);
  const metadata = asOptionalRecord(record?.["__openclaw"]);
  const facts = asOptionalRecord(metadata?.catalogDisplay);
  if (!record || !metadata || !facts || typeof facts.type !== "string") {
    return [message];
  }
  const prefix = catalogItemTextPrefix(facts.type);
  const inline =
    typeof record.content === "string"
      ? record.content
      : Array.isArray(record.content)
        ? readStringField(asOptionalRecord(record.content[0]), "text")
        : undefined;
  if (inline === undefined || !inline.startsWith(prefix)) {
    return [message];
  }
  const source = inline.slice(prefix.length);
  const { catalogDisplay: _facts, idempotencyKey: _retry, ...retainedMetadata } = metadata;
  const { idempotencyKey: _key, stopReason: _stop, ...envelope } = record;
  const id = readStringField(metadata, "id") ?? readStringField(record, "messageId");
  const projected = projectCatalogItemForDisplay({
    ...facts,
    type: facts.type,
    ...(id ? { id } : {}),
    text: facts.emptyText === true ? "" : unwrapImportFrame(source),
  });
  return projected
    ? [
        {
          ...envelope,
          ...projected,
          __openclaw: { ...retainedMetadata, ...asOptionalRecord(projected["__openclaw"]) },
        },
      ]
    : [];
}

/**
 * Presentation-only copy. Stored history and model context must retain their
 * untrusted-content framing. Never infer import provenance from message text:
 * ordinary user/assistant messages can intentionally quote an entire wrapper.
 */
export function projectImportedMessageForDisplay(message: unknown): unknown {
  const record = asOptionalRecord(message);
  if (!record || (record.role !== "user" && record.role !== "assistant")) {
    return message;
  }
  const metadata = asOptionalRecord(record["__openclaw"]);
  // History reads project the persisted key into __openclaw; inline events can
  // still carry it at the top level. Both originate at the catalog importer.
  const importKey = metadata?.idempotencyKey ?? record.idempotencyKey;
  if (typeof importKey !== "string" || !/^[^:\s]+-catalog:/u.test(importKey)) {
    return message;
  }
  const content = record.content;
  return {
    ...record,
    ...(typeof record.text === "string" ? { text: unwrapImportFrame(record.text) } : {}),
    ...(typeof content === "string"
      ? { content: unwrapImportFrame(content) }
      : Array.isArray(content)
        ? {
            content: content.map((value) => {
              const block = asOptionalRecord(value);
              return block &&
                typeof block.text === "string" &&
                (block.type === "text" ||
                  block.type === "input_text" ||
                  (record.role === "assistant" && block.type === "output_text"))
                ? Object.assign({}, block, { text: unwrapImportFrame(block.text) })
                : value;
            }),
          }
        : {}),
  };
}
