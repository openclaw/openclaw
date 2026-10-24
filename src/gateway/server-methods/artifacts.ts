import { createHash, randomUUID } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  type ArtifactsGetParams,
  type ArtifactsListParams,
  validateArtifactsDownloadParams,
  validateArtifactsGetParams,
  validateArtifactsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { isSessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-accessor.sqlite-active-events.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { readSessionTranscriptUpdateVersion } from "../../sessions/transcript-events.js";
import type { TranscriptReadWindow } from "../../sessions/transcript-read-window.js";
import { resolveChatAttachmentFrameBudgetBytes } from "../../shared/chat-attachment-frame-budget.js";
import { normalizeChatImageRenditionWidth } from "../../shared/chat-image-renditions.js";
import { getOrCreateWeakOwnerMap } from "../../shared/weak-owner-map.js";
import {
  canCreateArtifactDownload,
  createArtifactDownload,
  createManagedArtifactDownload,
} from "../artifact-download-grants.js";
import type { PreparedArtifactDownload } from "../artifact-download-projection.js";
import {
  type ArtifactLookup,
  type ArtifactRecord,
  toArtifactSummary,
} from "../artifacts-content.js";
import {
  parseManagedOutgoingArtifactId,
  resolveManagedOutgoingMediaArtifactDownload,
  resolveManagedOutgoingMediaUrlDownload,
} from "../managed-image-attachments.js";
import {
  encodeImageThumbnail,
  resolveManagedImageThumbnail,
} from "../managed-image-thumbnail-cache.js";
import { MAX_PAYLOAD_BYTES } from "../payload-limits.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { readSessionArtifacts } from "../session-transcript-readers.js";
import { parseTranscriptImageArtifactId } from "../transcript-image-artifacts.js";
import { prepareArtifactSessionRead } from "./artifacts-session-read.js";
import {
  ArtifactSessionResolutionError,
  artifactResponseIsCurrent,
  type ArtifactQuery,
  type ArtifactSessionAccess,
  createArtifactSessionAccess,
} from "./artifacts-session-resolution.js";
import { findTranscriptImageArtifact } from "./artifacts-transcript-images.js";
import { sessionFilesError } from "./session-files-errors.js";
import {
  readGatewayRequestMutationAuthority,
  retainGatewayRequestMutationAuthority,
} from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

type ArtifactCollectionOptions = {
  includeDownloadData?: boolean;
  downloadArtifactId?: string;
};

type ArtifactDownloadLookup = ArtifactLookup &
  ({ download: PreparedArtifactDownload; release: () => void } | { download?: undefined });

const CURSOR_TTL_MS = 15 * 60_000;
type ImageCursor = {
  binding: string;
  beforeSeq: number;
  imageOffset: number;
  readWindow: TranscriptReadWindow;
  expiresAt: number;
};

// Connection-owned continuation facts are bounded, ephemeral, and never confer access.
const cursors = new WeakMap<object, Map<string, ImageCursor>>();
const internalCaller = {};

function invalidImageCursor(message: string) {
  return new ArtifactSessionResolutionError(
    errorShape(ErrorCodes.INVALID_REQUEST, message, {
      details: { type: "artifact_cursor_invalid" },
    }),
  );
}

const queuedArtifactDownloads = new Map<
  string,
  {
    ids: Set<string>;
    result: Promise<{ sessionKey: string; artifacts: ArtifactRecord[] }>;
  }
>();

function createArtifactRequestAccess(
  request: GatewayRequestHandlerOptions,
  authority: {
    assertCurrent: () => void;
    release?: () => void;
  } = readGatewayRequestMutationAuthority(request),
) {
  const { assertCurrent } = authority;
  const { context, respond } = request;
  const access = createArtifactSessionAccess({
    client: request.client,
    projection: getSessionRowProjection(context),
    getRuntimeConfig: () => {
      assertCurrent();
      return context.getRuntimeConfig();
    },
  });
  if (authority.release) {
    access.retain(authority.release);
  }
  try {
    assertCurrent();
  } catch (error) {
    access[Symbol.dispose]();
    throw error;
  }
  return Object.assign(access, {
    assertCurrent,
    respond: (...args: Parameters<RespondFn>) => {
      assertCurrent();
      respond(...args);
    },
  });
}

async function loadArtifacts(
  query: ArtifactsListParams,
  access: ArtifactSessionAccess,
  opts: ArtifactCollectionOptions,
): Promise<{
  artifacts: ArtifactRecord[];
  sessionKey?: string;
  nextCursor?: string;
  omittedOversized?: boolean;
  assertCurrent?: () => void;
}> {
  const selected = await prepareArtifactSessionRead(query, access);
  if (!selected?.scope) {
    return { sessionKey: selected?.sessionKey, artifacts: [] };
  }
  const { sessionKey, scope, assertCurrent } = selected;
  const { storePath, sessionId, sessionEntry: entry } = scope;
  if (query.type === "image") {
    const binding = JSON.stringify([
      sessionKey,
      scope.agentId,
      sessionId,
      query.runId,
      query.messageRole,
    ]);
    const state = getOrCreateWeakOwnerMap(cursors, access.client ?? internalCaller);
    const now = Date.now();
    for (const [key, value] of state) {
      if (value.expiresAt <= now) {
        state.delete(key);
      }
    }
    const cursor = query.cursor ? state.get(query.cursor) : undefined;
    if (query.cursor && (!cursor || cursor.binding !== binding)) {
      throw invalidImageCursor(
        "Image cursor expired or belongs to another session; restart artifacts.list",
      );
    }
    const page = await readSessionArtifacts(scope, {
      kind: "image-page",
      sessionKey,
      runId: query.runId,
      messageRole: query.messageRole,
      limit: query.limit ?? 4,
      beforeSeq: cursor?.beforeSeq,
      imageOffset: cursor?.imageOffset,
      readWindow: cursor?.readWindow,
    }).catch((error: unknown) => {
      if (cursor && isSessionTranscriptProjectionUnavailableError(error)) {
        throw invalidImageCursor("Transcript changed; restart artifacts.list");
      }
      throw error;
    });
    let nextCursor: string | undefined;
    if (page.next) {
      nextCursor = randomUUID();
      state.set(nextCursor, {
        ...page.next,
        binding,
        expiresAt: now + CURSOR_TTL_MS,
      });
      pruneMapToMaxSize(state, 128);
    }
    assertCurrent();
    return {
      artifacts: page.artifacts,
      ...(nextCursor ? { nextCursor } : {}),
      ...(page.omittedOversized ? { omittedOversized: true } : {}),
      sessionKey,
      assertCurrent,
    };
  }
  const downloadIds = opts.downloadArtifactId ? new Set([opts.downloadArtifactId]) : undefined;
  const queuedKey =
    downloadIds && !resolveSessionTranscriptReadFence(scope)
      ? JSON.stringify([
          storePath,
          scope.agentId,
          sessionKey,
          sessionId,
          entry?.lifecycleRevision,
          query.runId,
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
  if (params.sessionKey || params.runId) {
    return true;
  }
  respond(
    false,
    undefined,
    sessionFilesError("artifact_query_unsupported", "artifacts require sessionKey or runId"),
  );
  return false;
}

function respondArtifactNotFound(respond: RespondFn, requestedArtifactId: string): void {
  respond(
    false,
    undefined,
    sessionFilesError("artifact_not_found", "artifact not found", {
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
  access: ArtifactSessionAccess,
  opts: ArtifactCollectionOptions,
): Promise<ArtifactLookup> {
  if (parseTranscriptImageArtifactId(params.artifactId)) {
    return findTranscriptImageArtifact(params, access, opts.includeDownloadData !== false);
  }
  const loaded = await loadArtifacts(params, access, opts);
  return {
    sessionKey: loaded.sessionKey,
    artifact: loaded.artifacts.find((artifact) => artifact.id === params.artifactId),
    assertCurrent: loaded.assertCurrent,
  };
}

async function prepareDownload(
  query: ArtifactsGetParams,
  access: ArtifactSessionAccess,
): Promise<ArtifactDownloadLookup> {
  const selected = await prepareArtifactSessionRead(query, access);
  if (!selected?.scope) {
    return { sessionKey: selected?.sessionKey };
  }
  const { selection } = await readSessionArtifacts(selected.scope, {
    ...query,
    kind: "download-grant",
    sessionKey: selected.sessionKey,
  });
  selected.assertCurrent();
  const result = {
    sessionKey: selected.sessionKey,
    assertCurrent: selected.assertCurrent,
    release: selected.release,
  };
  return selection?.kind === "prepared"
    ? { ...result, artifact: selection.download.artifact, download: selection.download }
    : { ...result, artifact: selection?.artifact };
}

async function respondManagedArtifactDownload(
  query: ArtifactsGetParams,
  request: GatewayRequestHandlerOptions,
  respond: RespondFn,
  matched?: ArtifactRecord,
): Promise<void> {
  const authority = retainGatewayRequestMutationAuthority(request);
  using access = createArtifactRequestAccess(request, authority);
  await runArtifactSessionOperation(respond, async () => {
    const selected = await prepareArtifactSessionRead(query, access);
    const scope = selected?.scope;
    const cfg = access.getRuntimeConfig();
    const defaultAgentId = selected
      ? tryResolveSessionCompatibilityOwnerAgentId(cfg, selected.sessionKey)
      : undefined;
    const managed =
      selected && scope && (!matched || matched.sessionKey === selected.sessionKey)
        ? await resolveManagedOutgoingMediaArtifactDownload({
            sessionKey: selected.sessionKey,
            ...(scope.agentId ? { agentId: scope.agentId } : {}),
            ...(defaultAgentId ? { defaultAgentId } : {}),
            artifactId: query.artifactId,
          })
        : null;
    selected?.assertCurrent();
    if (!managed || !selected) {
      respondArtifactNotFound(respond, query.artifactId);
      return;
    }
    const download = createManagedArtifactDownload({
      client: access.client,
      path: managed.url,
      assertCurrent: selected.assertCurrent,
      release: () => {
        selected.release();
        authority.release();
      },
    });
    access.detach(selected.release);
    access.detach(authority.release);
    respond(true, {
      artifact: {
        id: managed.artifactId,
        type: managed.type,
        title: managed.title,
        ...(managed.mimeType ? { mimeType: managed.mimeType } : {}),
        ...(managed.sizeBytes !== undefined ? { sizeBytes: managed.sizeBytes } : {}),
        sessionKey: managed.sessionKey,
        ...(matched?.runId ? { runId: matched.runId } : {}),
        ...(matched?.messageSeq !== undefined ? { messageSeq: matched.messageSeq } : {}),
        source: "session-transcript",
        download: { mode: "url" as const },
      },
      ...download,
    });
  });
}

export const artifactsHandlers: GatewayRequestHandlers = {
  "artifacts.list": async (request) => {
    const { params } = request;
    using access = createArtifactRequestAccess(request);
    const { respond } = access;
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
        sessionFilesError("artifact_query_unsupported", "limit and cursor require type image"),
      );
      return;
    }
    const query = { ...params };
    const loaded = await runArtifactSessionOperation(respond, () =>
      loadArtifacts(query, access, { includeDownloadData: false }),
    );
    if (!loaded.ok) {
      return;
    }
    const { artifacts, sessionKey, nextCursor, omittedOversized } = loaded.value;
    if (!sessionKey && query.runId) {
      respond(
        false,
        undefined,
        sessionFilesError("artifact_scope_not_found", "no session found for artifact query"),
      );
      return;
    }
    if (artifactResponseIsCurrent(loaded.value, respond)) {
      respond(true, {
        artifacts: artifacts.map(toArtifactSummary),
        ...(nextCursor ? { nextCursor } : {}),
        ...(omittedOversized ? { omittedOversized: true } : {}),
      });
    }
  },
  "artifacts.get": async (request) => {
    const { params } = request;
    using access = createArtifactRequestAccess(request);
    const { respond } = access;
    if (!assertValidParams(params, validateArtifactsGetParams, "artifacts.get", respond)) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    const query = { ...params };
    const found = await runArtifactSessionOperation(respond, () =>
      findArtifact(query, access, { includeDownloadData: false }),
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
      respond(true, { artifact: toArtifactSummary(artifact) });
    }
  },
  "artifacts.download": async (request) => {
    const { params, client } = request;
    using access = createArtifactRequestAccess(request);
    const { respond, assertCurrent } = access;
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
      !query.messageRole &&
      parseManagedOutgoingArtifactId(query.artifactId)
    ) {
      await respondManagedArtifactDownload(query, request, respond);
      return;
    }
    let found = await runArtifactSessionOperation<ArtifactDownloadLookup>(respond, () =>
      query.transport === "http" && canCreateArtifactDownload(client)
        ? prepareDownload(query, access)
        : findArtifact(query, access, { downloadArtifactId: query.artifactId }),
    );
    assertCurrent();
    if (found.ok && found.value.download && !canCreateArtifactDownload(client)) {
      found = await runArtifactSessionOperation(respond, () =>
        findArtifact(query, access, { downloadArtifactId: query.artifactId }),
      );
      assertCurrent();
    }
    if (!found.ok) {
      return;
    }
    let { artifact } = found.value;
    if (!artifact) {
      respondArtifactNotFound(respond, query.artifactId);
      return;
    }
    if (parseManagedOutgoingArtifactId(artifact.id)) {
      // Filters prove transcript membership; the managed ID still owns the bytes.
      // Never retarget a stale ID through inline data or another block URL.
      await respondManagedArtifactDownload(query, request, respond, artifact);
      return;
    }
    if (artifact.download.mode === "unsupported") {
      respond(
        false,
        undefined,
        sessionFilesError("artifact_download_unsupported", "artifact download is unsupported", {
          artifactId: artifact.id,
        }),
      );
      return;
    }
    if (found.value.download) {
      const assertArtifactCurrent = found.value.assertCurrent;
      const download = createArtifactDownload({
        client,
        prepared: found.value.download,
        release: found.value.release,
        assertCurrent: () => {
          assertCurrent();
          assertArtifactCurrent?.();
        },
        read: async (response) => {
          using reader = createArtifactSessionAccess({
            getRuntimeConfig: access.getRuntimeConfig,
            client,
            projection: access.projection,
          });
          const selected = await prepareArtifactSessionRead(query, reader);
          if (!selected?.scope) {
            return undefined;
          }
          const current = await readSessionArtifacts(selected.scope, {
            ...query,
            kind: "download-response",
            sessionKey: selected.sessionKey,
            response,
          });
          selected.assertCurrent();
          return current.response;
        },
      });
      access.detach(found.value.release);
      respond(true, {
        artifact: { ...toArtifactSummary(artifact), download: { mode: "url" as const } },
        ...download,
      });
      return;
    }
    const managedSource =
      artifact.download.mode === "url" && artifact.url && artifact.sessionKey
        ? await resolveManagedOutgoingMediaUrlDownload({
            sessionKey: artifact.sessionKey,
            url: artifact.url,
          })
        : null;
    if (!artifactResponseIsCurrent(found.value, respond)) {
      return;
    }
    let managedUrl: { url: string; expiresAt: string } | undefined;
    if (managedSource) {
      const authority = retainGatewayRequestMutationAuthority(request);
      using managedAccess = createArtifactRequestAccess(request, authority);
      const selected = await runArtifactSessionOperation(respond, () =>
        prepareArtifactSessionRead(query, managedAccess),
      );
      if (!selected.ok) {
        return;
      }
      if (!selected.value || selected.value.sessionKey !== managedSource.sessionKey) {
        respondArtifactNotFound(respond, query.artifactId);
        return;
      }
      const selection = selected.value;
      managedUrl = createManagedArtifactDownload({
        client,
        path: managedSource.url,
        assertCurrent: selection.assertCurrent,
        release: () => {
          selection.release();
          authority.release();
        },
      });
      managedAccess.detach(selection.release);
      managedAccess.detach(authority.release);
    }
    if (query.previewWidth !== undefined && !managedUrl) {
      let preview: Buffer | undefined;
      if (
        artifact.type === "image" &&
        artifact.download.mode === "bytes" &&
        artifact.data !== undefined
      ) {
        const source = Buffer.from(artifact.data, "base64");
        const width = normalizeChatImageRenditionWidth(query.previewWidth);
        const cacheKey = `${createHash("sha256").update(source).digest("hex")}\0${width}`;
        preview = await resolveManagedImageThumbnail(cacheKey, () =>
          encodeImageThumbnail(source, width),
        ).catch(() => undefined);
      }
      assertCurrent();
      if (!artifactResponseIsCurrent(found.value, respond)) {
        return;
      }
      if (!preview) {
        respond(
          false,
          undefined,
          sessionFilesError(
            "artifact_preview_unavailable",
            "artifact image preview is unavailable",
            { artifactId: artifact.id },
          ),
        );
        return;
      }
      // The frame budget below applies to encoded preview bytes, not the source.
      // Do not retain an original data URL in the summary's optional image field.
      artifact = {
        ...artifact,
        image: undefined,
        mimeType: "image/webp",
        sizeBytes: preview.byteLength,
        data: preview.toString("base64"),
      };
    }
    const payload = {
      artifact: toArtifactSummary(artifact),
      ...(artifact.download.mode === "bytes"
        ? { encoding: "base64" as const, data: artifact.data }
        : {}),
      ...(artifact.download.mode === "url"
        ? {
            url: managedUrl?.url ?? artifact.url,
            ...(managedUrl ? { expiresAt: managedUrl.expiresAt } : {}),
          }
        : {}),
    };
    if (artifact.download.mode === "bytes") {
      // The shared budget is decoded bytes; large metadata can need more than its reserved slack.
      const maxBase64Length =
        4 * Math.floor(resolveChatAttachmentFrameBudgetBytes(MAX_PAYLOAD_BYTES) / 3);
      const envelopeBytes = Buffer.byteLength(
        JSON.stringify({
          type: "res",
          id: request.req.id,
          ok: true,
          payload: { ...payload, data: "" },
        }),
      );
      if (
        (artifact.data?.length ?? 0) > Math.min(maxBase64Length, MAX_PAYLOAD_BYTES - envelopeBytes)
      ) {
        respond(
          false,
          undefined,
          sessionFilesError(
            "artifact_download_unsupported",
            'artifact is too large for inline transfer; request transport: "http"',
            { artifactId: artifact.id },
          ),
        );
        return;
      }
    }
    respond(true, payload);
  },
};
