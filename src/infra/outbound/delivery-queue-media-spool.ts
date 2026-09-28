// Delivery queue media spool owns replayable copies of outbound attachments
// whose producer-owned source may disappear before retry.
import fs from "node:fs/promises";
import path from "node:path";
import { fileStore } from "@openclaw/fs-safe/store";
import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { hasNonEmptyString as isNonEmptyMediaSource } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { resolveDeliveryQueueMediaDir } from "../../config/paths.js";
import {
  buildOutboundMediaLoadOptions,
  type OutboundMediaAccess,
} from "../../media/load-options.js";
import { loadWebMedia } from "../../media/web-media.js";
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import { generateSecureUuid } from "../secure-random.js";
import {
  ARTIFACT_NAME_RE,
  collectEntrySpoolPaths,
  payloadMediaSources,
  spoolRelativePath,
} from "./delivery-queue-media-paths.js";
import {
  cancelDeliveryQueueMediaRetention,
  createDeliveryQueueMediaRetention,
  loadDeliveryQueueMediaRetentionSnapshot,
} from "./delivery-queue-media-staging.js";

const ARTIFACT_EXT_RE = /^\.[A-Za-z0-9]{1,10}$/;
const PART_SUFFIX = ".part";
const ORPHAN_GRACE_MS = 24 * 60 * 60_000;

function openSpoolStore(stateDir: string | undefined, maxBytes?: number) {
  return fileStore({
    rootDir: resolveDeliveryQueueMediaDir(stateDir),
    dirMode: 0o700,
    mode: 0o600,
    maxBytes,
  });
}

function resolveArtifactExtension(source: string): string {
  const extension = path.extname(source.split("?")[0] ?? "");
  return ARTIFACT_EXT_RE.test(extension) ? extension.toLowerCase() : "";
}

/** Remote and data sources carry their own bytes; only local paths need queue custody. */
function isSpoolableSource(source: string): boolean {
  return !isPassThroughRemoteMediaSource(source) && !/^data:/i.test(source);
}

function isSensitivePayload(payload: ReplyPayload): boolean {
  return payload.sensitiveMedia === true && payloadMediaSources(payload).length > 0;
}

type StageQueueMediaResult =
  | {
      status: "staged";
      payloads: ReplyPayload[];
      artifacts: string[];
      mediaStageId?: string;
    }
  | { status: "not-durable"; reason: "sensitive-media" };

/**
 * Copies local media into queue custody and rewrites only the queue payloads.
 * The same loader and capability as the live send authorize every source.
 */
export async function stageQueuePayloadMedia(
  params: {
    payloads: readonly ReplyPayload[];
    mediaAccess?: OutboundMediaAccess;
    maxBytes: number;
    stateDir?: string;
    artifactFormat?: "session-generation-v1" | "command-owner-v1";
  },
  context?: DeliveryQueueStateContext,
): Promise<StageQueueMediaResult> {
  const stateDir = context?.stateDir ?? params.stateDir;
  if (params.payloads.some(isSensitivePayload)) {
    return { status: "not-durable", reason: "sensitive-media" };
  }

  const spoolRoot = path.resolve(resolveDeliveryQueueMediaDir(stateDir));
  // Older queue readers skip these artifacts instead of collecting media whose
  // authority-bound queue namespace they cannot inventory.
  const artifactPrefix =
    params.artifactFormat === "command-owner-v1"
      ? "c1-"
      : params.artifactFormat === "session-generation-v1"
        ? "g1-"
        : "";
  const artifactsBySource = new Map<string, string>();
  for (const source of params.payloads.flatMap(payloadMediaSources)) {
    if (isSpoolableSource(source) && !artifactsBySource.has(source)) {
      artifactsBySource.set(
        source,
        path.join(
          spoolRoot,
          `${artifactPrefix}${generateSecureUuid()}${resolveArtifactExtension(source)}`,
        ),
      );
    }
  }
  const artifacts = [...artifactsBySource.values()];
  // The SQLite stage row is visible before any artifact. GC either preserves it
  // or expires it; enqueue then consumes it atomically or fails closed.
  const mediaStageId =
    artifacts.length > 0
      ? createDeliveryQueueMediaRetention(
          artifacts,
          "outbound-media-stage",
          stateDir,
          undefined,
          context,
        )
      : undefined;
  const store = openSpoolStore(stateDir, params.maxBytes);
  const publishedSources = new Set<string>();

  const stageSource = async (source: string): Promise<string> => {
    const stagedPath = artifactsBySource.get(source);
    if (!stagedPath) {
      throw new Error(`Delivery queue media source was not planned: ${source}`);
    }
    if (publishedSources.has(source)) {
      return stagedPath;
    }
    const media = await loadWebMedia(
      source,
      buildOutboundMediaLoadOptions({
        maxBytes: params.maxBytes,
        mediaAccess: params.mediaAccess,
        mediaLocalRoots: params.mediaAccess?.localRoots,
        mediaReadFile: params.mediaAccess?.readFile,
      }),
    );
    const finalRelative = path.basename(stagedPath);
    const partRelative = `${finalRelative}${PART_SUFFIX}`;
    try {
      // Queue rows only see the final name after the complete copy is published.
      await store.write(partRelative, media.buffer, { maxBytes: params.maxBytes });
      const root = await store.root();
      await root.move(partRelative, finalRelative, { overwrite: false });
      publishedSources.add(source);
    } catch (err) {
      await store.remove(partRelative).catch(() => undefined);
      throw err;
    }
    return stagedPath;
  };

  const stagedPayloads: ReplyPayload[] = [];
  try {
    for (const payload of params.payloads) {
      const sources = payloadMediaSources(payload).filter(isSpoolableSource);
      if (sources.length === 0) {
        stagedPayloads.push(payload);
        continue;
      }
      const staged = { ...payload };
      if (isNonEmptyMediaSource(payload.mediaUrl) && isSpoolableSource(payload.mediaUrl)) {
        staged.mediaUrl = await stageSource(payload.mediaUrl);
      }
      if (payload.mediaUrls) {
        // Sequential copies keep cleanup complete when a later source fails.
        const stagedMediaUrls: string[] = [];
        for (const mediaUrl of payload.mediaUrls) {
          stagedMediaUrls.push(
            isNonEmptyMediaSource(mediaUrl) && isSpoolableSource(mediaUrl)
              ? await stageSource(mediaUrl)
              : mediaUrl,
          );
        }
        staged.mediaUrls = stagedMediaUrls;
      }
      stagedPayloads.push(staged);
    }
  } catch (err) {
    cancelDeliveryQueueMediaRetention(mediaStageId, stateDir, context);
    await releaseSpoolArtifacts(artifacts, stateDir);
    throw err;
  }
  return {
    status: "staged",
    payloads: stagedPayloads,
    artifacts,
    ...(mediaStageId ? { mediaStageId } : {}),
  };
}

async function removeArtifact(absolutePath: string, stateDir: string | undefined): Promise<void> {
  const relative = spoolRelativePath(absolutePath, stateDir);
  if (!relative) {
    return;
  }
  try {
    await openSpoolStore(stateDir).remove(relative);
  } catch {}
}

/** Discards spool artifacts whose durable row is already gone. Never throws. */
export async function releaseSpoolArtifacts(
  artifacts: readonly string[],
  stateDir?: string,
): Promise<void> {
  for (const artifact of artifacts) {
    await removeArtifact(artifact, stateDir);
  }
}

/**
 * Removes old unreferenced spool files. Pending-row references always win over
 * age; the grace covers the stage-before-row-commit crash window and bounds all
 * final and partial artifacts that never acquire a row.
 */
async function pruneDeliveryQueueMedia(params: {
  retainPaths: ReadonlySet<string>;
  stateDir?: string;
  nowMs?: number;
  orphanGraceMs?: number;
}): Promise<void> {
  const spoolRoot = path.resolve(resolveDeliveryQueueMediaDir(params.stateDir));
  const retainPaths = new Set([...params.retainPaths].map((entry) => path.resolve(entry)));
  const cutoffMs = (params.nowMs ?? Date.now()) - (params.orphanGraceMs ?? ORPHAN_GRACE_MS);
  const entries = await fs.readdir(spoolRoot, { withFileTypes: true }).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (!entries) {
    return;
  }

  for (const entry of entries) {
    // Unknown files and symlinks are not spool artifacts; never follow them.
    if (!entry.isFile() || !ARTIFACT_NAME_RE.test(entry.name)) {
      continue;
    }
    const artifactPath = path.join(spoolRoot, entry.name);
    if (retainPaths.has(artifactPath)) {
      continue;
    }
    const stats = await fs.stat(artifactPath).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    });
    if (!stats || stats.mtimeMs > cutoffMs) {
      continue;
    }
    await removeArtifact(artifactPath, params.stateDir);
  }
}

/** Reclaims queue media using the complete pending inventory as the retain set. */
export async function pruneOrphanedDeliveryQueueMedia(
  params?: { stateDir?: string; nowMs?: number },
  context?: DeliveryQueueStateContext,
): Promise<void> {
  const captured = context ?? captureDeliveryQueueStateContext(params?.stateDir);
  const stateDir = captured.stateDir;
  const nowMs = params?.nowMs ?? Date.now();
  const snapshot = await loadDeliveryQueueMediaRetentionSnapshot(
    { expireBeforeMs: nowMs - ORPHAN_GRACE_MS },
    captured,
  );
  await pruneDeliveryQueueMedia({
    retainPaths: new Set(
      snapshot.stagedArtifacts.concat(
        snapshot.payloads.flatMap((payloads) => collectEntrySpoolPaths(payloads, stateDir)),
      ),
    ),
    stateDir,
    nowMs,
  });
}

export { collectEntrySpoolPaths } from "./delivery-queue-media-paths.js";
