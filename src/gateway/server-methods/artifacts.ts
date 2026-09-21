// Artifact gateway methods collect generated artifacts from session transcripts
// and expose list/get/download RPCs scoped by session, run, task, or agent.
import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as asNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ArtifactSummary,
  type ArtifactsGetParams,
  type ArtifactsListParams,
  validateArtifactsDownloadParams,
  validateArtifactsGetParams,
  validateArtifactsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { findMarkdownImageSpans } from "../../../packages/markdown-core/src/image-spans.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isImageMediaFact, readPersistedMediaFacts } from "../../media/media-facts.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { readSessionTranscriptUpdateVersion } from "../../sessions/transcript-events.js";
import {
  ASSISTANT_DISPLAY_CONTENT_FIELD,
  readAssistantDisplayContent,
} from "../../shared/assistant-display-content.js";
import {
  parseManagedOutgoingArtifactId,
  resolveManagedOutgoingMediaArtifactDownload,
  resolveManagedOutgoingMediaUrlDownload,
} from "../managed-image-attachments.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { visitSessionMessagesAsync } from "../session-transcript-readers.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { parseTranscriptImageArtifactId } from "../transcript-image-artifacts.js";
import {
  type ArtifactLookup,
  type ArtifactRecord,
  mediaUrlValue,
  resolveBlockDownload,
  resolveMessageRunId,
  resolveMessageTaskId,
} from "./artifacts-content.js";
import { readArtifactImagePage } from "./artifacts-image-page.js";
import {
  ArtifactSessionResolutionError,
  type ArtifactQuery,
  prepareArtifactSessionResolution,
} from "./artifacts-session-resolution.js";
import { findTranscriptImageArtifact } from "./artifacts-transcript-images.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type {
  GatewayClient,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

type ArtifactCollectionOptions = {
  includeDownloadData?: boolean;
  downloadArtifactId?: string;
};

const queuedArtifactDownloads = new Map<
  string,
  {
    ids: Set<string>;
    result: Promise<{ sessionKey: string; artifacts: ArtifactRecord[] }>;
  }
>();

function createArtifactRequestAccess(request: GatewayRequestHandlerOptions) {
  const { assertCurrent } = readGatewayRequestMutationAuthority(request);
  const { context, respond } = request;
  assertCurrent();
  return {
    assertCurrent,
    getRuntimeConfig: () => {
      assertCurrent();
      return context.getRuntimeConfig?.();
    },
    respond: (...args: Parameters<RespondFn>) => {
      assertCurrent();
      respond(...args);
    },
  };
}

function artifactError(type: string, message: string, details?: Record<string, unknown>) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, {
    details: {
      type,
      ...details,
    },
  });
}

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
  if (normalized === "file" || normalized === "input_file") {
    return "file";
  }
  if (normalized === "attachment") {
    return "file";
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
  messageRole?: ArtifactQuery["messageRole"];
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

/** Loads artifacts from the transcript selected by sessionKey, runId, or taskId. */
async function loadArtifacts(
  query: ArtifactsListParams,
  getRuntimeConfig: () => OpenClawConfig | undefined,
  opts: ArtifactCollectionOptions = {},
  client: GatewayClient | null = null,
): Promise<{
  artifacts: ArtifactRecord[];
  sessionKey?: string;
  nextCursor?: string;
  omittedOversized?: boolean;
}> {
  const resolveSession = await prepareArtifactSessionResolution(query);
  const resolved = resolveSession(getRuntimeConfig(), client);
  if (!resolved) {
    return { artifacts: [] };
  }
  const { sessionKey } = resolved;
  const unscopedAgentId = parseAgentSessionKey(sessionKey) ? undefined : resolved.agentId;
  const { storePath, entry } = unscopedAgentId
    ? loadGatewaySessionEntryReadOnly(sessionKey, { agentId: unscopedAgentId })
    : loadGatewaySessionEntryReadOnly(sessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId || !storePath) {
    return { sessionKey, artifacts: [] };
  }
  const artifacts: ArtifactRecord[] = [];
  const collection = { artifacts, count: 0 };
  const scope = {
    agentId: resolved.agentId ?? resolveAgentIdFromSessionKey(sessionKey),
    sessionEntry: entry,
    sessionId,
    sessionKey,
    storePath,
  };
  if (query.type === "image") {
    const page = await readArtifactImagePage({
      scope,
      binding: JSON.stringify([
        sessionKey,
        scope.agentId,
        sessionId,
        query.runId,
        query.taskId,
        query.messageRole,
      ]),
      client,
      cursor: query.cursor,
      limit: query.limit ?? 4,
      collect: (message) => {
        const images: ArtifactRecord[] = [];
        collectArtifactsFromMessage({
          message,
          messageFallbackSeq: 1,
          collection: { artifacts: images, count: 0 },
          sessionKey,
          runId: query.runId,
          taskId: query.taskId,
          messageRole: query.messageRole,
          imagesOnly: true,
        });
        return images
          .filter((artifact) => artifact.image)
          .map(toSummary)
          .toReversed();
      },
    });
    return { ...page, sessionKey };
  }
  const downloadIds = opts.downloadArtifactId ? new Set([opts.downloadArtifactId]) : undefined;
  const queuedKey =
    downloadIds && !resolveSessionTranscriptReadFence(scope)
      ? JSON.stringify([
          storePath,
          scope.agentId,
          sessionKey,
          sessionId,
          entry.lifecycleRevision,
          query.runId,
          query.taskId,
          query.messageRole,
          readSessionTranscriptUpdateVersion(),
        ])
      : undefined;
  const queued = queuedKey ? queuedArtifactDownloads.get(queuedKey) : undefined;
  if (queued && opts.downloadArtifactId) {
    queued.ids.add(opts.downloadArtifactId);
    return queued.result;
  }
  const collect = async () => {
    // Close before target resolution or snapshot acquisition, including empty/error reads.
    // Later requests must start a fresh scan; only already queued downloads share this one.
    if (queuedKey) {
      queuedArtifactDownloads.delete(queuedKey);
    }
    await visitSessionMessagesAsync(scope, (message, seq) => {
      collectArtifactsFromMessage({
        message,
        messageFallbackSeq: seq,
        collection,
        sessionKey,
        runId: query.runId,
        taskId: query.taskId,
        messageRole: query.messageRole,
        includeDownloadData: opts.includeDownloadData,
        downloadArtifactIds: downloadIds,
      });
    });
    return { sessionKey, artifacts };
  };
  if (!queuedKey || !downloadIds) {
    return collect();
  }
  const result = Promise.resolve().then(collect);
  queuedArtifactDownloads.set(queuedKey, { ids: downloadIds, result });
  return result;
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

function respondArtifactNotFound(respond: RespondFn, requestedArtifactId: string): void {
  respond(
    false,
    undefined,
    artifactError("artifact_not_found", "artifact not found", {
      artifactId: requestedArtifactId,
    }),
  );
}

async function runArtifactSessionOperation<T>(
  respond: RespondFn,
  operation: () => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof ArtifactSessionResolutionError) {
      respond(false, undefined, error.shape);
      return { ok: false };
    }
    if (error instanceof AgentSelectionRequiredError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
      return { ok: false };
    }
    throw error;
  }
}

async function findArtifact(
  params: ArtifactsGetParams,
  getRuntimeConfig: () => OpenClawConfig | undefined,
  opts: ArtifactCollectionOptions = {},
  client: GatewayClient | null = null,
): Promise<ArtifactLookup> {
  if (parseTranscriptImageArtifactId(params.artifactId)) {
    return findTranscriptImageArtifact(
      params,
      getRuntimeConfig,
      opts.includeDownloadData !== false,
      client,
    );
  }
  const loaded = await loadArtifacts(params, getRuntimeConfig, opts, client);
  return {
    sessionKey: loaded.sessionKey,
    artifact: loaded.artifacts.find((artifact) => artifact.id === params.artifactId),
  };
}

function toSummary(artifact: ArtifactRecord): ArtifactSummary {
  const { data: _dataValue, url: _url, ...summary } = artifact;
  return summary;
}

function artifactResponseIsCurrent(found: ArtifactLookup, respond: RespondFn): boolean {
  try {
    found.assertCurrent?.();
    return true;
  } catch (error) {
    if (!(error instanceof ArtifactSessionResolutionError)) {
      throw error;
    }
    respond(false, undefined, error.shape);
    return false;
  }
}

async function respondManagedArtifactDownload(
  query: ArtifactsGetParams,
  getRuntimeConfig: () => OpenClawConfig | undefined,
  client: GatewayClient | null,
  respond: RespondFn,
  matched?: ArtifactRecord,
): Promise<void> {
  await runArtifactSessionOperation(respond, async () => {
    const resolveSession = await prepareArtifactSessionResolution(query);
    const cfg = getRuntimeConfig();
    const resolved = resolveSession(cfg, client);
    const defaultAgentId = resolved
      ? tryResolveSessionCompatibilityOwnerAgentId(cfg ?? {}, resolved.sessionKey)
      : undefined;
    const managed =
      resolved && (!matched || matched.sessionKey === resolved.sessionKey)
        ? await resolveManagedOutgoingMediaArtifactDownload({
            sessionKey: resolved.sessionKey,
            ...(resolved.agentId ? { agentId: resolved.agentId } : {}),
            ...(defaultAgentId ? { defaultAgentId } : {}),
            artifactId: query.artifactId,
          })
        : null;
    if (!managed) {
      respondArtifactNotFound(respond, query.artifactId);
      return;
    }
    respond(true, {
      artifact: {
        id: managed.artifactId,
        type: managed.type,
        title: managed.title,
        ...(managed.mimeType ? { mimeType: managed.mimeType } : {}),
        ...(managed.sizeBytes !== undefined ? { sizeBytes: managed.sizeBytes } : {}),
        sessionKey: managed.sessionKey,
        ...(matched?.runId ? { runId: matched.runId } : {}),
        ...(matched?.taskId ? { taskId: matched.taskId } : {}),
        ...(matched?.messageSeq !== undefined ? { messageSeq: matched.messageSeq } : {}),
        source: "session-transcript",
        download: { mode: "url" as const },
      },
      url: managed.url,
      expiresAt: managed.expiresAt,
    });
  });
}

/** Gateway handlers for listing, summarizing, and downloading transcript artifacts. */
export const artifactsHandlers: GatewayRequestHandlers = {
  "artifacts.list": async (request) => {
    const { params, client } = request;
    const { getRuntimeConfig, respond } = createArtifactRequestAccess(request);
    if (!assertValidParams(params, validateArtifactsListParams, "artifacts.list", respond)) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    if (params.type !== "image" && (params.limit !== undefined || params.cursor !== undefined)) {
      respond(
        false,
        undefined,
        artifactError("artifact_query_unsupported", "limit and cursor require type image"),
      );
      return;
    }
    const query = { ...params };
    const loaded = await runArtifactSessionOperation(respond, () =>
      loadArtifacts(query, getRuntimeConfig, { includeDownloadData: false }, client),
    );
    if (!loaded.ok) {
      return;
    }
    const { artifacts, sessionKey, nextCursor, omittedOversized } = loaded.value;
    if (!sessionKey && (query.runId || query.taskId)) {
      respond(
        false,
        undefined,
        artifactError("artifact_scope_not_found", "no session found for artifact query"),
      );
      return;
    }
    respond(true, {
      artifacts: artifacts.map(toSummary),
      ...(nextCursor ? { nextCursor } : {}),
      ...(omittedOversized ? { omittedOversized: true } : {}),
    });
  },
  "artifacts.get": async (request) => {
    const { params, client } = request;
    const { getRuntimeConfig, respond } = createArtifactRequestAccess(request);
    if (!assertValidParams(params, validateArtifactsGetParams, "artifacts.get", respond)) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    const query = { ...params };
    const found = await runArtifactSessionOperation(respond, () =>
      findArtifact(query, getRuntimeConfig, { includeDownloadData: false }, client),
    );
    if (!found.ok) {
      return;
    }
    const { artifact } = found.value;
    if (!artifact) {
      respondArtifactNotFound(respond, query.artifactId);
      return;
    }
    if (artifactResponseIsCurrent(found.value, respond)) {
      respond(true, { artifact: toSummary(artifact) });
    }
  },
  "artifacts.download": async (request) => {
    const { params, client } = request;
    const { getRuntimeConfig, respond, assertCurrent } = createArtifactRequestAccess(request);
    if (
      !assertValidParams(params, validateArtifactsDownloadParams, "artifacts.download", respond)
    ) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    const query = { ...params };
    if (
      query.sessionKey &&
      !query.runId &&
      !query.taskId &&
      !query.messageRole &&
      parseManagedOutgoingArtifactId(query.artifactId)
    ) {
      await respondManagedArtifactDownload(query, getRuntimeConfig, client, respond);
      return;
    }
    const found = await runArtifactSessionOperation(respond, () =>
      findArtifact(query, getRuntimeConfig, { downloadArtifactId: query.artifactId }, client),
    );
    assertCurrent();
    if (!found.ok) {
      return;
    }
    const { artifact } = found.value;
    if (!artifact) {
      respondArtifactNotFound(respond, query.artifactId);
      return;
    }
    if (parseManagedOutgoingArtifactId(artifact.id)) {
      // Filters prove transcript membership; the managed ID still owns the bytes.
      // Never retarget a stale ID through inline data or another block URL.
      await respondManagedArtifactDownload(query, getRuntimeConfig, client, respond, artifact);
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
    const managedUrl =
      artifact.download.mode === "url" && artifact.url && artifact.sessionKey
        ? await resolveManagedOutgoingMediaUrlDownload({
            sessionKey: artifact.sessionKey,
            url: artifact.url,
          })
        : null;
    if (!artifactResponseIsCurrent(found.value, respond)) {
      return;
    }
    respond(true, {
      artifact: toSummary(artifact),
      ...(artifact.download.mode === "bytes"
        ? { encoding: "base64" as const, data: artifact.data }
        : {}),
      ...(artifact.download.mode === "url"
        ? {
            url: managedUrl?.url ?? artifact.url,
            ...(managedUrl ? { expiresAt: managedUrl.expiresAt } : {}),
          }
        : {}),
    });
  },
};
