import { createHash } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  type ArtifactSummary,
  type ArtifactsDownloadParams,
  type ArtifactsGetParams,
  type ArtifactsListParams,
  validateArtifactsDownloadParams,
  validateArtifactsGetParams,
  validateArtifactsListParams,
} from "../protocol/index.js";
import { resolveSessionKeyForRun } from "../server-session-key.js";
import { loadSessionEntry, readSessionMessages } from "../session-utils.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

type ArtifactDownloadMode = ArtifactSummary["download"]["mode"];

type ArtifactRecord = ArtifactSummary & {
  data?: string;
  url?: string;
};

type ArtifactQuery = {
  sessionKey?: string;
  runId?: string;
  taskId?: string;
};

function artifactError(type: string, message: string, details?: Record<string, unknown>) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, {
    details: {
      type,
      ...details,
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeArtifactType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "image" || normalized === "audio" || normalized === "file") {
    return normalized;
  }
  return "file";
}

function mimeFromDataUrl(value: string): string | undefined {
  const match = /^data:([^;,]+)(?:;[^,]*)?,/i.exec(value.trim());
  return match?.[1]?.toLowerCase();
}

function base64FromDataUrl(value: string): string | undefined {
  const match = /^data:[^,]*;base64,(.*)$/is.exec(value.trim());
  return match?.[1]?.replace(/\s+/g, "");
}

function estimateBase64Size(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return Buffer.from(value, "base64").byteLength;
  } catch {
    return undefined;
  }
}

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
  const meta = asRecord(message.__openclaw);
  const seq = meta?.seq;
  return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq : fallback;
}

function resolveMessageRunId(message: Record<string, unknown>): string | undefined {
  const meta = asRecord(message.__openclaw);
  return asNonEmptyString(meta?.runId) ?? asNonEmptyString(message.runId);
}

function resolveMessageTaskId(message: Record<string, unknown>): string | undefined {
  const meta = asRecord(message.__openclaw);
  return asNonEmptyString(meta?.taskId) ?? asNonEmptyString(message.taskId);
}

function resolveBlockDownload(block: Record<string, unknown>): {
  mode: ArtifactDownloadMode;
  data?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
} {
  const data = asNonEmptyString(block.data);
  const content = asNonEmptyString(block.content);
  const url = asNonEmptyString(block.url) ?? asNonEmptyString(block.openUrl);
  const source = asRecord(block.source);
  const sourceData = asNonEmptyString(source?.data);
  const sourceUrl = asNonEmptyString(source?.url);
  const dataUrl = [url, sourceUrl, data, content, sourceData].find(
    (value) => typeof value === "string" && /^data:/i.test(value),
  );
  const base64 =
    (dataUrl ? base64FromDataUrl(dataUrl) : undefined) ?? data ?? sourceData ?? content;
  const remoteUrl =
    url && !/^data:/i.test(url)
      ? url
      : sourceUrl && !/^data:/i.test(sourceUrl)
        ? sourceUrl
        : undefined;
  const mimeType =
    asNonEmptyString(block.mimeType) ??
    asNonEmptyString(block.media_type) ??
    asNonEmptyString(source?.media_type) ??
    asNonEmptyString(source?.mimeType) ??
    (dataUrl ? mimeFromDataUrl(dataUrl) : undefined);
  const explicitSize = block.sizeBytes ?? source?.sizeBytes;
  const sizeBytes =
    typeof explicitSize === "number" && Number.isFinite(explicitSize) && explicitSize >= 0
      ? Math.floor(explicitSize)
      : estimateBase64Size(base64);
  if (base64) {
    return { mode: "bytes", data: base64, mimeType, sizeBytes };
  }
  if (remoteUrl) {
    return { mode: "url", url: remoteUrl, mimeType, sizeBytes };
  }
  return { mode: "unsupported", mimeType, sizeBytes };
}

function isArtifactBlock(block: Record<string, unknown>): boolean {
  const type = asNonEmptyString(block.type)?.toLowerCase();
  if (type === "image" || type === "audio" || type === "file") {
    return true;
  }
  return Boolean(block.url || block.openUrl || block.data || block.source);
}

export function collectArtifactsFromMessages(params: {
  messages: unknown[];
  sessionKey: string;
  runId?: string;
  taskId?: string;
}): ArtifactRecord[] {
  const artifacts: ArtifactRecord[] = [];
  let messageFallbackSeq = 0;
  for (const message of params.messages) {
    const msg = asRecord(message);
    if (!msg) {
      continue;
    }
    messageFallbackSeq += 1;
    const messageSeq = resolveMessageSeq(msg, messageFallbackSeq);
    const messageRunId = resolveMessageRunId(msg);
    const messageTaskId = resolveMessageTaskId(msg);
    if (params.runId && messageRunId && messageRunId !== params.runId) {
      continue;
    }
    if (params.taskId && messageTaskId && messageTaskId !== params.taskId) {
      continue;
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
      const block = asRecord(content[contentIndex]);
      if (!block || !isArtifactBlock(block)) {
        continue;
      }
      const type = normalizeArtifactType(asNonEmptyString(block.type) ?? "file");
      const title =
        asNonEmptyString(block.title) ??
        asNonEmptyString(block.fileName) ??
        asNonEmptyString(block.filename) ??
        asNonEmptyString(block.alt) ??
        `${type} ${artifacts.length + 1}`;
      const download = resolveBlockDownload(block);
      const summary: ArtifactRecord = {
        id: artifactId({
          sessionKey: params.sessionKey,
          messageSeq,
          contentIndex,
          title,
          type,
        }),
        type,
        title,
        ...(download.mimeType ? { mimeType: download.mimeType } : {}),
        ...(download.sizeBytes !== undefined ? { sizeBytes: download.sizeBytes } : {}),
        sessionKey: params.sessionKey,
        ...(messageRunId ? { runId: messageRunId } : params.runId ? { runId: params.runId } : {}),
        ...(messageTaskId
          ? { taskId: messageTaskId }
          : params.taskId
            ? { taskId: params.taskId }
            : {}),
        messageSeq,
        source: "session-transcript",
        download: { mode: download.mode },
        ...(download.data ? { data: download.data } : {}),
        ...(download.url ? { url: download.url } : {}),
      };
      artifacts.push(summary);
    }
  }
  return artifacts;
}

function resolveQuerySessionKey(query: ArtifactQuery): string | undefined {
  if (query.sessionKey) {
    return query.sessionKey;
  }
  if (query.runId) {
    return resolveSessionKeyForRun(query.runId);
  }
  if (query.taskId) {
    return resolveSessionKeyForRun(query.taskId);
  }
  return undefined;
}

function loadArtifacts(query: ArtifactQuery): { artifacts: ArtifactRecord[]; sessionKey?: string } {
  const sessionKey = resolveQuerySessionKey(query);
  if (!sessionKey) {
    return { artifacts: [] };
  }
  const { storePath, entry } = loadSessionEntry(sessionKey);
  const sessionId = entry?.sessionId;
  const messages =
    sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
  return {
    sessionKey,
    artifacts: collectArtifactsFromMessages({
      messages,
      sessionKey,
      runId: query.runId,
      taskId: query.taskId,
    }),
  };
}

function requireQueryable(params: ArtifactQuery, respond: RespondFn): boolean {
  if (params.sessionKey || params.runId || params.taskId) {
    return true;
  }
  respond(
    false,
    undefined,
    artifactError(
      "artifact_query_unsupported",
      "artifacts require one of sessionKey, runId, or taskId",
    ),
  );
  return false;
}

function findArtifact(params: ArtifactsGetParams | ArtifactsDownloadParams): {
  artifact?: ArtifactRecord;
  sessionKey?: string;
} {
  const loaded = loadArtifacts(params);
  return {
    sessionKey: loaded.sessionKey,
    artifact: loaded.artifacts.find((artifact) => artifact.id === params.artifactId),
  };
}

function toSummary(artifact: ArtifactRecord): ArtifactSummary {
  const { data: _data, url: _url, ...summary } = artifact;
  return summary;
}

export const artifactsHandlers: GatewayRequestHandlers = {
  "artifacts.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateArtifactsListParams, "artifacts.list", respond)) {
      return;
    }
    if (!requireQueryable(params as ArtifactsListParams, respond)) {
      return;
    }
    const { artifacts, sessionKey } = loadArtifacts(params as ArtifactsListParams);
    if (
      !sessionKey &&
      ((params as ArtifactsListParams).runId || (params as ArtifactsListParams).taskId)
    ) {
      respond(
        false,
        undefined,
        artifactError("artifact_scope_not_found", "no session found for artifact query"),
      );
      return;
    }
    respond(true, { artifacts: artifacts.map(toSummary) });
  },
  "artifacts.get": ({ params, respond }) => {
    if (!assertValidParams(params, validateArtifactsGetParams, "artifacts.get", respond)) {
      return;
    }
    if (!requireQueryable(params as ArtifactsGetParams, respond)) {
      return;
    }
    const { artifact } = findArtifact(params as ArtifactsGetParams);
    if (!artifact) {
      respond(
        false,
        undefined,
        artifactError("artifact_not_found", "artifact not found", {
          artifactId: (params as ArtifactsGetParams).artifactId,
        }),
      );
      return;
    }
    respond(true, { artifact: toSummary(artifact) });
  },
  "artifacts.download": ({ params, respond }) => {
    if (
      !assertValidParams(params, validateArtifactsDownloadParams, "artifacts.download", respond)
    ) {
      return;
    }
    if (!requireQueryable(params as ArtifactsDownloadParams, respond)) {
      return;
    }
    const { artifact } = findArtifact(params as ArtifactsDownloadParams);
    if (!artifact) {
      respond(
        false,
        undefined,
        artifactError("artifact_not_found", "artifact not found", {
          artifactId: (params as ArtifactsDownloadParams).artifactId,
        }),
      );
      return;
    }
    if (artifact.download.mode === "unsupported") {
      respond(
        false,
        undefined,
        artifactError("artifact_download_unsupported", "artifact download is unsupported", {
          artifactId: artifact.id,
        }),
      );
      return;
    }
    respond(true, {
      artifact: toSummary(artifact),
      ...(artifact.download.mode === "bytes"
        ? { encoding: "base64" as const, data: artifact.data }
        : {}),
      ...(artifact.download.mode === "url" ? { url: artifact.url } : {}),
    });
  },
};
