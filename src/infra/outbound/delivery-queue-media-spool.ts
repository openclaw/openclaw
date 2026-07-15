// Delivery queue media spool owns undelivered outbound attachments whose source
// dies with its producer. TTS synthesizes into a producer-owned temp that is
// removed on producer exit, so a durable row referencing that temp replays
// against a missing file and the voice is silently dropped. Artifacts are
// grouped by producing process generation: a fresh process can then reclaim
// exactly what is provably ownerless without a lease table or owner marker.
import fs from "node:fs/promises";
import path from "node:path";
import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { resolveDeliveryQueueMediaDir } from "../../config/paths.js";
import { logVerbose } from "../../globals.js";
import {
  buildOutboundMediaLoadOptions,
  type OutboundMediaAccess,
} from "../../media/load-options.js";
import { loadWebMedia } from "../../media/web-media.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { fileStore } from "../file-store.js";
import { readProcessStartTimeForOwnerIdentity } from "../process-owner-identity.js";
import { generateSecureHex, generateSecureUuid } from "../secure-random.js";

// <pid>-<processStartTime|unknown>-<nonce>. The nonce keeps generations distinct
// when a PID is recycled inside one host uptime; the start time proves identity.
const GENERATION_DIR_RE = /^(\d+)-(\d+|unknown)-([0-9a-f]{32})$/;
const ARTIFACT_EXT_RE = /^\.[A-Za-z0-9]{1,10}$/;
const PART_SUFFIX = ".part";

function openSpoolStore(stateDir: string | undefined, maxBytes?: number) {
  return fileStore({
    rootDir: resolveDeliveryQueueMediaDir(stateDir),
    dirMode: 0o700,
    mode: 0o600,
    maxBytes,
  });
}

let currentGenerationDir: string | undefined;

/** Directory name identifying artifacts owned by this process incarnation. */
function resolveCurrentGenerationDir(): string {
  if (!currentGenerationDir) {
    const startTime = readProcessStartTimeForOwnerIdentity(process.pid);
    currentGenerationDir = `${process.pid}-${startTime ?? "unknown"}-${generateSecureHex(16)}`;
  }
  return currentGenerationDir;
}

type Generation = { pid: number; startTime: number | null };

function parseGenerationDirName(name: string): Generation | null {
  const match = GENERATION_DIR_RE.exec(name);
  if (!match) {
    return null;
  }
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const startTime = match[2] === "unknown" ? null : Number(match[2]);
  if (startTime !== null && (!Number.isInteger(startTime) || startTime < 0)) {
    return null;
  }
  return { pid, startTime };
}

type GenerationOwner = "alive" | "dead" | "unknown";

/**
 * Only a provably absent owner releases custody. A `kill(0)` EPERM, an
 * unreadable identity, or an identity we could not record all resolve to
 * `unknown` and retain: leaking a spool file costs disk, deleting a live
 * owner's file costs the user their message.
 */
function resolveGenerationOwner(generation: Generation): GenerationOwner {
  if (isPidDefinitelyDead(generation.pid)) {
    return "dead";
  }
  if (generation.startTime === null) {
    return "unknown";
  }
  const currentStartTime = readProcessStartTimeForOwnerIdentity(generation.pid);
  if (currentStartTime === null) {
    return "unknown";
  }
  // A live PID whose start time moved is a recycled id, not our producer.
  return currentStartTime === generation.startTime ? "alive" : "dead";
}

function resolveArtifactExtension(source: string): string {
  const extension = path.extname(source.split("?")[0] ?? "");
  return ARTIFACT_EXT_RE.test(extension) ? extension.toLowerCase() : "";
}

function payloadMediaSources(payload: ReplyPayload): string[] {
  const sources: string[] = [];
  if (typeof payload.mediaUrl === "string" && payload.mediaUrl.trim()) {
    sources.push(payload.mediaUrl);
  }
  for (const mediaUrl of payload.mediaUrls ?? []) {
    if (typeof mediaUrl === "string" && mediaUrl.trim()) {
      sources.push(mediaUrl);
    }
  }
  return sources;
}

/** Remote and data sources carry their own bytes; only local paths die with the producer. */
function isSpoolableSource(source: string): boolean {
  return !isPassThroughRemoteMediaSource(source) && !/^data:/i.test(source);
}

function isSensitivePayload(payload: ReplyPayload): boolean {
  // The flag only blocks durability when there is actually a media reference to persist.
  return payload.sensitiveMedia === true && payloadMediaSources(payload).length > 0;
}

export type StageQueueMediaResult =
  | { status: "staged"; payloads: ReplyPayload[]; artifacts: string[] }
  | { status: "not-durable"; reason: "sensitive-media" };

/**
 * Copies producer-owned local media into this process's generation and rewrites
 * the queue-only payloads to the copies. Throws when a source cannot be
 * authorized, read, or published; the caller maps that onto its queue policy.
 */
export async function stageQueuePayloadMedia(params: {
  payloads: readonly ReplyPayload[];
  mediaAccess?: OutboundMediaAccess;
  maxBytes: number;
  stateDir?: string;
}): Promise<StageQueueMediaResult> {
  if (params.payloads.some(isSensitivePayload)) {
    return { status: "not-durable", reason: "sensitive-media" };
  }
  const spoolRoot = resolveDeliveryQueueMediaDir(params.stateDir);
  const stagedBySource = new Map<string, string>();
  const artifacts: string[] = [];
  const store = openSpoolStore(params.stateDir, params.maxBytes);
  const generationDir = resolveCurrentGenerationDir();

  const stageSource = async (source: string): Promise<string> => {
    const cached = stagedBySource.get(source);
    if (cached) {
      return cached;
    }
    // Authorize and read through the same loader the live send uses, so the
    // spool copy can never widen what this send was already allowed to read.
    const media = await loadWebMedia(
      source,
      buildOutboundMediaLoadOptions({
        maxBytes: params.maxBytes,
        mediaAccess: params.mediaAccess,
        mediaLocalRoots: params.mediaAccess?.localRoots,
        mediaReadFile: params.mediaAccess?.readFile,
      }),
    );
    const artifactId = generateSecureUuid();
    const finalRelative = `${generationDir}/${artifactId}${resolveArtifactExtension(source)}`;
    const partRelative = `${finalRelative}${PART_SUFFIX}`;
    // Publish by rename: fs-safe's copy/write helpers create the destination
    // before streaming into it, so writing the final name directly would expose
    // an empty artifact to a concurrent reclaim or read.
    await store.write(partRelative, media.buffer, { maxBytes: params.maxBytes });
    const root = await store.root();
    await root.move(partRelative, finalRelative, { overwrite: false });
    const stagedPath = path.join(spoolRoot, finalRelative);
    stagedBySource.set(source, stagedPath);
    artifacts.push(stagedPath);
    return stagedPath;
  };

  const stagedPayloads: ReplyPayload[] = [];
  for (const payload of params.payloads) {
    const sources = payloadMediaSources(payload).filter(isSpoolableSource);
    if (sources.length === 0) {
      stagedPayloads.push(payload);
      continue;
    }
    const staged = { ...payload };
    if (typeof payload.mediaUrl === "string" && isSpoolableSource(payload.mediaUrl)) {
      staged.mediaUrl = await stageSource(payload.mediaUrl);
    }
    if (payload.mediaUrls) {
      staged.mediaUrls = await Promise.all(
        payload.mediaUrls.map(async (mediaUrl) =>
          isSpoolableSource(mediaUrl) ? await stageSource(mediaUrl) : mediaUrl,
        ),
      );
    }
    stagedPayloads.push(staged);
  }
  return { status: "staged", payloads: stagedPayloads, artifacts };
}

async function removeArtifact(absolutePath: string, stateDir: string | undefined): Promise<void> {
  const spoolRoot = resolveDeliveryQueueMediaDir(stateDir);
  const relative = path.relative(spoolRoot, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return;
  }
  // Root-scoped removal: the store rejects traversal and refuses to follow a
  // symlink out of the spool even if an artifact name was tampered with.
  await openSpoolStore(stateDir)
    .remove(relative)
    .catch(() => undefined);
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

/** Absolute spool paths a queue entry still needs in order to replay. */
export function collectEntrySpoolPaths(
  payloads: readonly ReplyPayload[],
  stateDir?: string,
): string[] {
  const spoolRoot = resolveDeliveryQueueMediaDir(stateDir);
  const paths: string[] = [];
  for (const payload of payloads) {
    for (const source of payloadMediaSources(payload)) {
      if (path.isAbsolute(source) && source.startsWith(`${spoolRoot}${path.sep}`)) {
        paths.push(source);
      }
    }
  }
  return paths;
}

/**
 * Reclaims artifacts in generations whose producer is provably gone. Live and
 * unverifiable owners are skipped whole — wall-clock age is never an ownership
 * signal, so a long-idle gateway keeps its own undelivered media.
 */
export async function reclaimDeadGenerationSpoolArtifacts(params: {
  retainPaths: ReadonlySet<string>;
  stateDir?: string;
}): Promise<void> {
  const spoolRoot = resolveDeliveryQueueMediaDir(params.stateDir);
  const entries = await fs.readdir(spoolRoot, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const generation = parseGenerationDirName(entry.name);
    if (!generation) {
      continue;
    }
    if (resolveGenerationOwner(generation) !== "dead") {
      continue;
    }
    await reclaimGeneration({
      generationDir: entry.name,
      generationPath: path.join(spoolRoot, entry.name),
      retainPaths: params.retainPaths,
      stateDir: params.stateDir,
    });
  }
}

async function reclaimGeneration(params: {
  generationDir: string;
  generationPath: string;
  retainPaths: ReadonlySet<string>;
  stateDir: string | undefined;
}): Promise<void> {
  const artifacts = await fs
    .readdir(params.generationPath, { withFileTypes: true })
    .catch(() => null);
  if (!artifacts) {
    return;
  }
  let retained = 0;
  for (const artifact of artifacts) {
    // Only regular files are ours; a symlink or directory here was not written
    // by the spool and is left untouched rather than followed.
    if (!artifact.isFile()) {
      retained += 1;
      continue;
    }
    const absolutePath = path.join(params.generationPath, artifact.name);
    if (params.retainPaths.has(absolutePath)) {
      retained += 1;
      continue;
    }
    await removeArtifact(absolutePath, params.stateDir);
  }
  if (retained === 0) {
    await fs.rmdir(params.generationPath).catch(() => undefined);
  }
  logVerbose(
    `delivery-queue media spool: reclaimed dead generation ${params.generationDir} (${retained} retained)`,
  );
}
