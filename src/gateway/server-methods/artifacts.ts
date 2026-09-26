// Artifact gateway methods collect generated artifacts from session transcripts
// and expose list/get/download RPCs scoped by session, run, task, or agent.
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
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { readSessionTranscriptUpdateVersion } from "../../sessions/transcript-events.js";
import { createArtifactDownload } from "../artifact-downloads.js";
import {
  parseManagedOutgoingArtifactId,
  resolveManagedOutgoingMediaArtifactDownload,
  resolveManagedOutgoingMediaUrlDownload,
} from "../managed-image-attachments.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { readSessionArtifacts } from "../session-transcript-readers.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { parseTranscriptImageArtifactId } from "../transcript-image-artifacts.js";
import type { ArtifactLookup, ArtifactRecord } from "./artifacts-content.js";
import { readArtifactImagePage } from "./artifacts-image-page.js";
import {
  ArtifactSessionResolutionError,
  artifactResponseIsCurrent,
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
  assertCurrent?: () => void;
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
  const lifecycleRevision = entry.lifecycleRevision;
  const assertCurrent = () => {
    const authorized = resolveSession(getRuntimeConfig(), client);
    const current = loadGatewaySessionEntryReadOnly(
      sessionKey,
      unscopedAgentId ? { agentId: unscopedAgentId } : {},
    );
    if (
      authorized?.sessionKey !== sessionKey ||
      authorized.agentId !== resolved.agentId ||
      current.storePath !== storePath ||
      current.entry?.sessionId !== sessionId ||
      current.entry.lifecycleRevision !== lifecycleRevision
    ) {
      throw new ArtifactSessionResolutionError(
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "session changed while reading artifact; reload the conversation",
          {
            retryable: true,
          },
        ),
      );
    }
  };
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
      sessionKey,
      filters: { runId: query.runId, taskId: query.taskId, messageRole: query.messageRole },
    });
    assertCurrent();
    return { ...page, sessionKey, assertCurrent };
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
    const loaded = await queued.result;
    assertCurrent();
    return { ...loaded, assertCurrent };
  }
  const collect = async () => {
    // Close before target resolution or snapshot acquisition, including empty/error reads.
    // Later requests must start a fresh scan; only already queued downloads share this one.
    if (queuedKey) {
      queuedArtifactDownloads.delete(queuedKey);
    }
    const { artifacts } = await readSessionArtifacts(scope, {
      kind: "list",
      sessionKey,
      runId: query.runId,
      taskId: query.taskId,
      messageRole: query.messageRole,
      includeDownloadData: opts.includeDownloadData,
      downloadArtifactIds: downloadIds ? [...downloadIds] : undefined,
    });
    return { sessionKey, artifacts };
  };
  const result = queuedKey && downloadIds ? Promise.resolve().then(collect) : collect();
  if (queuedKey && downloadIds) {
    queuedArtifactDownloads.set(queuedKey, { ids: downloadIds, result });
  }
  // Queued scans share data; each caller retains its own disclosure authority.
  const loaded = await result;
  assertCurrent();
  return { ...loaded, assertCurrent };
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
    assertCurrent: loaded.assertCurrent,
  };
}

function toSummary(artifact: ArtifactRecord): ArtifactSummary {
  const { data: _dataValue, url: _url, ...summary } = artifact;
  return summary;
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
    if (query.transport === "http") {
      const assertArtifactCurrent = found.value.assertCurrent;
      const download = createArtifactDownload({
        client,
        artifact,
        assertCurrent: () => {
          assertCurrent();
          assertArtifactCurrent?.();
        },
        read: async () => {
          const current = await findArtifact(
            query,
            getRuntimeConfig,
            { downloadArtifactId: query.artifactId },
            client,
          );
          current.assertCurrent?.();
          return current.artifact;
        },
      });
      if (download) {
        respond(true, {
          artifact: { ...toSummary(artifact), download: { mode: "url" as const } },
          ...download,
        });
        return;
      }
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
