import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as asNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import type {
  ArtifactSummary,
  ArtifactsListParams,
} from "../../packages/gateway-protocol/src/schema/artifacts.js";
import { findMarkdownImageSpans } from "../../packages/markdown-core/src/image-spans.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-contract.js";
import { isImageMediaFact, readPersistedMediaFacts } from "../media/media-facts.js";
import type { TranscriptReadWindow } from "../sessions/transcript-read-window.js";
import {
  ASSISTANT_DISPLAY_CONTENT_FIELD,
  readAssistantDisplayContent,
} from "../shared/assistant-display-content.js";
import {
  type ArtifactDownloadResponse,
  type ArtifactDownloadResponseRequest,
  type PreparedArtifactDownload,
  prepareArtifactDownload,
  prepareArtifactDownloadResponse,
} from "./artifact-download-projection.js";
import { parseManagedOutgoingArtifactId } from "./managed-outgoing-artifact-id.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";
import {
  type ArtifactRecord,
  mediaUrlValue,
  resolveBlockDownload,
  resolveMessageRunId,
  resolveMessageTaskId,
  toArtifactSummary,
} from "./server-methods/artifacts-content.js";
import type { SessionTranscriptReader } from "./session-transcript-read-kernel.js";
import {
  parseTranscriptImageArtifactId,
  resolveTranscriptImageArtifactBlock,
} from "./transcript-image-artifacts.js";

const IMAGE_PAGE_MESSAGES = 32;
const IMAGE_PAGE_BYTES = 256 * 1024;

type SessionArtifactFilters = Pick<ArtifactsListParams, "runId" | "taskId" | "messageRole">;
type ArtifactReaders = Pick<
  SessionTranscriptReader,
  "visitSessionMessagesAsync" | "readSessionMessagesPageWithStatsAsync"
>;

export type SessionArtifactReadQuery = SessionArtifactFilters &
  (
    | {
        kind: "list";
        sessionKey: string;
        includeDownloadData?: boolean;
        downloadArtifactIds?: string[];
      }
    | {
        kind: "image-page";
        sessionKey: string;
        limit: number;
        beforeSeq?: number;
        imageOffset?: number;
        readWindow?: TranscriptReadWindow;
      }
    | {
        kind: "image";
        sessionKey: string;
        artifactId: string;
        includeData: boolean;
      }
    | {
        kind: "download-grant";
        sessionKey: string;
        artifactId: string;
      }
    | {
        kind: "download-response";
        sessionKey: string;
        artifactId: string;
        response: ArtifactDownloadResponseRequest;
      }
  );

export type SessionArtifactReadResult =
  | { kind: "list"; artifacts: ArtifactRecord[] }
  | {
      kind: "image-page";
      artifacts: ArtifactSummary[];
      next?: { beforeSeq: number; imageOffset: number; readWindow: TranscriptReadWindow };
      omittedOversized?: boolean;
    }
  | { kind: "image"; artifact?: ArtifactRecord }
  | {
      kind: "download-grant";
      selection?:
        | { kind: "prepared"; download: PreparedArtifactDownload }
        | { kind: "raw"; artifact: ArtifactRecord };
    }
  | { kind: "download-response"; response?: ArtifactDownloadResponse };

function normalizeArtifactType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "image" || normalized === "input_image" || normalized === "image_url") {
    return "image";
  }
  if (normalized === "audio" || normalized === "input_audio") {
    return "audio";
  }
  if (normalized === "video" || normalized === "input_video") {
    return "video";
  }
  return "file";
}

/** Generates a stable id from transcript position plus display metadata. */
function artifactId(parts: {
  sessionKey: string;
  messageSeq: number;
  contentIndex: number;
  title: string;
  type: string;
}): string {
  const hash = createHash("sha256")
    .update(
      `${parts.sessionKey}\0${parts.messageSeq}\0${parts.contentIndex}\0${parts.type}\0${parts.title}`,
    )
    .digest("base64url")
    .slice(0, 18);
  return `artifact_${hash}`;
}

function resolveMessageSeq(message: Record<string, unknown>, fallback: number): number {
  const meta = asOptionalRecord(message["__openclaw"]);
  const seq = meta?.seq;
  return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq : fallback;
}

function isArtifactBlock(block: Record<string, unknown>): boolean {
  const type = asNonEmptyString(block.type)?.toLowerCase();
  if (
    type === "image" ||
    type === "audio" ||
    type === "video" ||
    type === "file" ||
    type === "attachment" ||
    type === "input_image" ||
    type === "input_audio" ||
    type === "input_video" ||
    type === "input_file" ||
    type === "image_url"
  ) {
    return true;
  }
  return (
    typeof block.data === "string" ||
    Boolean(block.url || block.openUrl || block.source || block.image_url || block.audio_url)
  );
}

function collectArtifactsFromMessage(params: {
  message: unknown;
  messageFallbackSeq: number;
  collection: { artifacts: ArtifactRecord[]; count: number };
  sessionKey: string;
  runId?: string;
  taskId?: string;
  messageRole?: ArtifactsListParams["messageRole"];
  includeDownloadData?: boolean;
  downloadArtifactIds?: Set<string>;
  imagesOnly?: boolean;
}): void {
  const msg = asOptionalRecord(params.message);
  if (!msg) {
    return;
  }
  const messageSeq = resolveMessageSeq(msg, params.messageFallbackSeq);
  const messageRunId = resolveMessageRunId(msg);
  const messageTaskId = resolveMessageTaskId(msg);
  if (params.runId && messageRunId !== params.runId) {
    return;
  }
  if (params.taskId && messageTaskId !== params.taskId) {
    return;
  }
  const content = readAssistantDisplayContent(msg);
  if (params.imagesOnly) {
    const texts =
      typeof msg.content === "string" && !Array.isArray(msg[ASSISTANT_DISPLAY_CONTENT_FIELD])
        ? [msg.content]
        : content.flatMap((block) =>
            block.type === "text" && typeof block.text === "string" ? [block.text] : [],
          );
    for (const text of texts) {
      for (const span of findMarkdownImageSpans(text)) {
        content.push({ type: "image", url: span.destination, title: "image" });
      }
    }
    for (const fact of readPersistedMediaFacts(msg) ?? []) {
      const url = fact.path ?? fact.url;
      if (url && isImageMediaFact(fact)) {
        content.push({
          type: "image",
          url,
          mimeType: fact.contentType,
          fileName: fact.fileName,
          sizeBytes: fact.sizeBytes,
        });
      }
    }
  }
  for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
    const block = asOptionalRecord(content[contentIndex]);
    if (!block || !isArtifactBlock(block)) {
      continue;
    }
    // Fallback titles participate in existing artifact IDs. Count omitted roles
    // too so adding a role filter cannot rename an otherwise identical artifact.
    params.collection.count += 1;
    if (params.messageRole && msg.role !== params.messageRole) {
      continue;
    }
    const attachment = asOptionalRecord(block.attachment);
    const type =
      params.imagesOnly && attachment?.kind === "image"
        ? "image"
        : normalizeArtifactType(asNonEmptyString(block.type) ?? "file");
    if (params.imagesOnly && type !== "image") {
      continue;
    }
    const title =
      asNonEmptyString(block.title) ??
      asNonEmptyString(block.fileName) ??
      asNonEmptyString(block.filename) ??
      asNonEmptyString(block.alt) ??
      asNonEmptyString(attachment?.label) ??
      `${type} ${params.collection.count}`;
    const declaredArtifactId =
      asNonEmptyString(block.artifactId) ?? asNonEmptyString(attachment?.artifactId);
    const id =
      declaredArtifactId && parseManagedOutgoingArtifactId(declaredArtifactId)
        ? declaredArtifactId
        : artifactId({
            sessionKey: params.sessionKey,
            messageSeq,
            contentIndex,
            title,
            type,
          });
    // Preserve the first match without inspecting or normalizing sibling payloads.
    if (params.downloadArtifactIds && !params.downloadArtifactIds.delete(id)) {
      continue;
    }
    const includeData = params.includeDownloadData !== false;
    const download = resolveBlockDownload(attachment ?? block, { includeData });
    const source = asOptionalRecord(block.source);
    const previewOnly = params.imagesOnly && !parseManagedOutgoingArtifactId(id);
    const imageUrl = params.imagesOnly
      ? download.data !== undefined
        ? `data:${download.mimeType ?? "image/png"};base64,${download.data}`
        : (asNonEmptyString(attachment?.url) ??
          asNonEmptyString(block.url) ??
          asNonEmptyString(source?.url) ??
          mediaUrlValue(block.image_url))
      : undefined;
    const summary: ArtifactRecord = {
      id: previewOnly ? `preview_${id}` : id,
      type,
      title,
      ...(download.mimeType ? { mimeType: download.mimeType } : {}),
      ...(download.sizeBytes !== undefined ? { sizeBytes: download.sizeBytes } : {}),
      sessionKey: params.sessionKey,
      ...(messageRunId ? { runId: messageRunId } : {}),
      ...(messageTaskId ? { taskId: messageTaskId } : {}),
      messageSeq,
      source: previewOnly ? "session-transcript-preview" : "session-transcript",
      download: { mode: previewOnly ? "unsupported" : download.mode },
      ...(imageUrl ? { image: { url: imageUrl } } : {}),
      ...(download.data !== undefined ? { data: download.data } : {}),
      ...(download.url ? { url: download.url } : {}),
    };
    params.collection.artifacts.push(summary);
  }
}

async function readArtifactList(
  scope: SessionTranscriptReadScope,
  query: Extract<SessionArtifactReadQuery, { kind: "list" }>,
  readers: ArtifactReaders,
): Promise<ArtifactRecord[]> {
  const artifacts: ArtifactRecord[] = [];
  const collection = { artifacts, count: 0 };
  const downloadArtifactIds = query.downloadArtifactIds
    ? new Set(query.downloadArtifactIds)
    : undefined;
  await readers.visitSessionMessagesAsync(scope, (message, seq) => {
    collectArtifactsFromMessage({
      message,
      messageFallbackSeq: seq,
      collection,
      sessionKey: query.sessionKey,
      runId: query.runId,
      taskId: query.taskId,
      messageRole: query.messageRole,
      includeDownloadData: query.includeDownloadData,
      downloadArtifactIds,
    });
  });
  return artifacts;
}

/** Select transcript artifacts inside the caller's admitted read owner. */
export async function selectSessionArtifacts(
  scope: SessionTranscriptReadScope,
  query: SessionArtifactReadQuery,
  readers: ArtifactReaders,
): Promise<SessionArtifactReadResult> {
  if (query.kind === "download-grant" || query.kind === "download-response") {
    const selection = {
      sessionKey: query.sessionKey,
      runId: query.runId,
      taskId: query.taskId,
      messageRole: query.messageRole,
    };
    const artifact = parseTranscriptImageArtifactId(query.artifactId)
      ? await readTranscriptImageArtifact(
          scope,
          { ...selection, kind: "image", artifactId: query.artifactId, includeData: true },
          readers,
        )
      : (
          await readArtifactList(
            scope,
            {
              ...selection,
              kind: "list",
              includeDownloadData: true,
              downloadArtifactIds: [query.artifactId],
            },
            readers,
          )
        )[0];
    if (query.kind === "download-response") {
      return {
        kind: "download-response",
        response: artifact ? prepareArtifactDownloadResponse(artifact, query.response) : undefined,
      };
    }
    if (!artifact) {
      return { kind: "download-grant" };
    }
    if (parseManagedOutgoingArtifactId(artifact.id)) {
      return {
        kind: "download-grant",
        selection: { kind: "raw", artifact: toArtifactSummary(artifact) },
      };
    }
    const download = prepareArtifactDownload(artifact);
    return {
      kind: "download-grant",
      selection: download ? { kind: "prepared", download } : { kind: "raw", artifact },
    };
  }
  if (query.kind === "list") {
    return { kind: "list", artifacts: await readArtifactList(scope, query, readers) };
  }
  if (query.kind === "image-page") {
    const page = await readers.readSessionMessagesPageWithStatsAsync(scope, {
      offset: 0,
      beforeSeq: query.beforeSeq,
      maxMessages: IMAGE_PAGE_MESSAGES,
      maxBytes: IMAGE_PAGE_BYTES,
      readOnly: true,
      captureReadWindow: true,
      expectedReadWindow: query.readWindow,
    });
    const artifacts: ArtifactSummary[] = [];
    let next: { beforeSeq: number; imageOffset: number } | undefined;
    for (const message of page.messages.toReversed()) {
      const seq = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.seq;
      if (typeof seq !== "number") {
        continue;
      }
      const collected: ArtifactRecord[] = [];
      collectArtifactsFromMessage({
        message,
        messageFallbackSeq: 1,
        collection: { artifacts: collected, count: 0 },
        sessionKey: query.sessionKey,
        runId: query.runId,
        taskId: query.taskId,
        messageRole: query.messageRole,
        imagesOnly: true,
      });
      const images = collected
        .filter((artifact) => artifact.image)
        .map(toArtifactSummary)
        .toReversed();
      const start = query.beforeSeq === seq + 1 ? (query.imageOffset ?? 0) : 0;
      for (let index = start; index < images.length; index++) {
        const image = images[index];
        if (image) {
          artifacts.push(image);
        }
        if (artifacts.length === query.limit) {
          next =
            index + 1 < images.length
              ? { beforeSeq: seq + 1, imageOffset: index + 1 }
              : seq > 1
                ? { beforeSeq: seq, imageOffset: 0 }
                : undefined;
          break;
        }
      }
      if (artifacts.length === query.limit) {
        break;
      }
    }
    if (artifacts.length < query.limit && page.olderOffset !== undefined) {
      const head = query.beforeSeq ?? page.totalMessages + 1;
      next = { beforeSeq: head - page.olderOffset, imageOffset: 0 };
    }
    return {
      kind: "image-page",
      artifacts,
      ...(next && next.beforeSeq > 1 && page.readWindow
        ? { next: { ...next, readWindow: page.readWindow } }
        : {}),
      ...(page.omittedOversized ? { omittedOversized: true } : {}),
    };
  }
  const artifact = await readTranscriptImageArtifact(scope, query, readers);
  return artifact ? { kind: "image", artifact } : { kind: "image" };
}

async function readTranscriptImageArtifact(
  scope: SessionTranscriptReadScope,
  query: Extract<SessionArtifactReadQuery, { kind: "image" }>,
  readers: ArtifactReaders,
): Promise<ArtifactRecord | undefined> {
  const reference = parseTranscriptImageArtifactId(query.artifactId);
  if (!reference) {
    return undefined;
  }
  const page = await readers.readSessionMessagesPageWithStatsAsync(scope, {
    offset: 0,
    beforeSeq: reference.messageSeq + 1,
    maxMessages: 1,
    maxBytes: MAX_PAYLOAD_BYTES - 4096,
  });
  const message = asOptionalRecord(page.messages[0]);
  const block = resolveTranscriptImageArtifactBlock(message, query.artifactId);
  if (
    !message ||
    !block ||
    (query.messageRole && message.role !== query.messageRole) ||
    (query.runId && resolveMessageRunId(message) !== query.runId) ||
    (query.taskId && resolveMessageTaskId(message) !== query.taskId)
  ) {
    return undefined;
  }
  const download = resolveBlockDownload(block, { includeData: query.includeData });
  if (download.mode !== "bytes") {
    return undefined;
  }
  return {
    id: query.artifactId,
    type: "image",
    title:
      asNonEmptyString(block.title) ??
      asNonEmptyString(block.fileName) ??
      asNonEmptyString(block.alt) ??
      "Image",
    mimeType: download.mimeType ?? "image/png",
    sizeBytes: download.sizeBytes,
    sessionKey: query.sessionKey,
    messageSeq: reference.messageSeq,
    source: "session-transcript",
    download: { mode: "bytes" },
    ...(download.data !== undefined ? { data: download.data } : {}),
  };
}
