import { createHash } from "node:crypto";
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  TRANSCRIPTS_EXPORT_MAX_BYTES,
  TRANSCRIPTS_LEGACY_MAX_TEXT_LENGTH,
  TRANSCRIPTS_LEGACY_RESULT_MAX_BYTES,
  TRANSCRIPTS_RESULT_MAX_BYTES,
  type TranscriptSessionSummary,
  type TranscriptsExportParams,
  type TranscriptsExportResult,
  type TranscriptsGetParams,
  type TranscriptsGetResult,
  type TranscriptsListParams,
  type TranscriptsListResult,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { readTranscriptCaptureSnapshot } from "./capture.js";
import {
  projectTranscriptMarkdown,
  projectTranscriptNotes,
  projectTranscriptSession,
  projectTranscriptUtterance,
} from "./read.js";
import {
  assertTranscriptByteLimit,
  assertTranscriptByteCount,
  cursorScope,
  decodeCursor,
  encodeCursor,
  TranscriptLibraryError,
  type TranscriptExportRead,
  type TranscriptReadOptions,
} from "./store-read.js";
import { safeTranscriptPathSegment, type TranscriptsStore } from "./store.js";
import { renderTranscriptsMarkdown } from "./summary.js";

function normalizeDate(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const time = parseDateStringTimestampMs(value);
  if (time === undefined) {
    throw new TranscriptLibraryError(
      "transcript_invalid_filter",
      "Invalid transcript date filter.",
    );
  }
  return new Date(time).toISOString();
}

export async function listTranscriptLibrary(
  store: TranscriptsStore,
  params: TranscriptsListParams,
  providerName?: (providerId: string) => string | undefined,
): Promise<TranscriptsListResult> {
  const { cursor, ...filters } = params;
  const startedAfter = normalizeDate(filters.startedAfter);
  const startedBefore = normalizeDate(filters.startedBefore);
  if (startedAfter && startedBefore && startedAfter >= startedBefore) {
    throw new TranscriptLibraryError(
      "transcript_invalid_filter",
      "Transcript date range must end after it starts.",
    );
  }
  const scope = cursorScope([
    "list",
    filters.query,
    filters.providerId,
    filters.accountId,
    filters.agentId,
    startedAfter,
    startedBefore,
  ]);
  const position = decodeCursor(cursor, scope);
  let after: TranscriptReadOptions["after"];
  if (position) {
    const [startedAt, sessionId] = position;
    if (position.length !== 2 || typeof startedAt !== "string" || typeof sessionId !== "string") {
      throw new TranscriptLibraryError(
        "transcript_invalid_cursor",
        "Invalid transcript library cursor.",
      );
    }
    after = { startedAt, sessionId };
  }
  const page = store.iterateReadEntries({ ...filters, startedAfter, startedBefore, after });
  const captures = readTranscriptCaptureSnapshot();
  const sessions: TranscriptSessionSummary[] = [];
  let bytes = 0;
  let hasMore = false;
  try {
    for (let step = await page.next(); ; step = await page.next()) {
      if (step.done) {
        hasMore = step.value;
        break;
      }
      const entry = projectTranscriptSession(
        step.value,
        undefined,
        providerName?.(step.value.session.source.providerId),
        captures,
      );
      bytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
      assertTranscriptByteCount(bytes);
      sessions.push(entry);
    }
  } finally {
    await page.return(false);
  }
  const last = sessions.at(-1);
  const result = {
    sessions,
    nextCursor: hasMore && last ? encodeCursor(scope, [last.startedAt, last.sessionId]) : null,
  };
  assertTranscriptByteLimit(JSON.stringify(result));
  return result;
}

export async function getTranscriptLibrary(
  store: TranscriptsStore,
  params: TranscriptsGetParams,
  providerName?: (providerId: string) => string | undefined,
): Promise<TranscriptsGetResult> {
  const { entry, page, notes, purpose, scope } = await store.readLibraryEntry(params);
  const utterances = page?.utterances.map((utterance) => {
    const projected = projectTranscriptUtterance(utterance);
    if (purpose === "legacy") {
      projected.text = truncateUtf16Safe(projected.text, TRANSCRIPTS_LEGACY_MAX_TEXT_LENGTH);
    }
    return projected;
  });
  const last = utterances?.at(-1);
  const result: TranscriptsGetResult = {
    session: projectTranscriptSession(
      entry,
      undefined,
      providerName?.(entry.session.source.providerId),
    ),
    ...(utterances ? { utterances } : {}),
    nextCursor: page?.hasMore && last ? encodeCursor(scope, [last.sequence]) : null,
    summary: projectTranscriptNotes(notes),
  };
  assertTranscriptByteLimit(
    JSON.stringify(result),
    purpose === "legacy" ? TRANSCRIPTS_LEGACY_RESULT_MAX_BYTES : TRANSCRIPTS_RESULT_MAX_BYTES,
  );
  return result;
}

export async function exportTranscriptLibrary(
  store: TranscriptsStore,
  params: TranscriptsExportParams,
): Promise<TranscriptsExportResult> {
  const rows = store.iterateExport(params.selector, params.format === "markdown");
  const parts: string[] = [];
  let sizeBytes = 0;
  let completed: TranscriptExportRead | undefined;
  try {
    for (let step = await rows.next(); ; step = await rows.next()) {
      if (step.done) {
        completed = step.value;
        break;
      }
      const utterance = step.value;
      const text =
        params.format === "jsonl"
          ? `${JSON.stringify(projectTranscriptUtterance(utterance))}\n`
          : sanitizeTerminalText(utterance.text).trim();
      const speaker = sanitizeTerminalText(utterance.speakerLabel ?? "").trim();
      const line = params.format === "markdown" && speaker ? `${speaker}: ${text}` : text;
      // Include Markdown list/newline overhead while accumulating, before rendering the body.
      sizeBytes += Buffer.byteLength(line, "utf8") + (params.format === "markdown" ? 3 : 0);
      assertTranscriptByteCount(sizeBytes, TRANSCRIPTS_EXPORT_MAX_BYTES, true);
      parts.push(line);
    }
  } finally {
    await rows.return(undefined);
  }
  if (!completed) {
    throw new Error("Transcript export ended before completion.");
  }
  const { entry, notes } = completed;
  const summary = notes?.summary;
  const title = sanitizeTerminalText(entry.session.title ?? "").trim() || "Transcript";
  const body =
    params.format === "jsonl"
      ? parts.join("")
      : notes?.markdown !== undefined
        ? [
            projectTranscriptMarkdown(notes.markdown),
            ...(summary ? [`Summary covers ${summary.utteranceCount} saved utterances.`] : []),
            `## Full Transcript\n${parts.map((line) => `- ${line}`).join("\n")}`,
            `Transcript utterances: ${entry.utteranceCount}\n`,
          ].join("\n\n")
        : summary
          ? `${renderTranscriptsMarkdown({ ...summary, title, transcript: parts, utteranceCount: entry.utteranceCount })}\n\nSummary covers ${summary.utteranceCount} saved utterances.\n`
          : `# ${title}\n\nSession: ${sanitizeTerminalText(entry.session.sessionId)}\nStarted: ${entry.session.startedAt}\n\n## Transcript\n${parts.map((line) => `- ${line}`).join("\n")}\n`;
  const bodySizeBytes = Buffer.byteLength(body, "utf8");
  assertTranscriptByteCount(bodySizeBytes, TRANSCRIPTS_EXPORT_MAX_BYTES, true);
  const digest = createHash("sha256").update(entry.selector).digest("hex").slice(0, 12);
  const filename = `transcript-${safeTranscriptPathSegment(entry.session.startedAt.slice(0, 10))}-${digest}.${params.format === "markdown" ? "md" : "jsonl"}`;
  return {
    selector: entry.selector,
    filename,
    mimeType:
      params.format === "markdown"
        ? "text/markdown;charset=utf-8"
        : "application/x-ndjson;charset=utf-8",
    encoding: "base64",
    data: Buffer.from(body, "utf8").toString("base64"),
    sizeBytes: bodySizeBytes,
  };
}
