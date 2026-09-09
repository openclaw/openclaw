import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { isMissingPathError } from "../infra/errors.js";
import { createCorePluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";

const MEMORY_ARTIFACT_PROVENANCE_OWNER_ID = "core:memory-artifact-provenance";
const MEMORY_ARTIFACT_PROVENANCE_NAMESPACE = "workspace-files";
const MEMORY_ARTIFACT_PROVENANCE_MAX_ENTRIES = 50_000;

export type MemoryArtifactOriginClass = "agent" | "untrusted";

export type MemoryArtifactProvenanceSegment = {
  startOffset: number;
  endOffset: number;
  contentHash: string;
  originClass: MemoryArtifactOriginClass;
  observedAt: number;
};

export type MemoryArtifactProvenance = {
  fileHash: string;
  originClass: MemoryArtifactOriginClass;
  observedAt: number;
  sessionId?: string;
  sessionKey?: string;
  segments?: MemoryArtifactProvenanceSegment[];
};

type StoredMemoryArtifactProvenance = MemoryArtifactProvenance & {
  version: 1;
  workspaceKey: string;
  relativePath: string;
  reservationId: string;
};

type MemoryArtifactAddress = {
  workspaceKey: string;
  relativePath: string;
  storeKey: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function segmentFor(params: {
  content: string;
  startOffset: number;
  endOffset: number;
  originClass: MemoryArtifactOriginClass;
  observedAt: number;
}): MemoryArtifactProvenanceSegment {
  return {
    startOffset: params.startOffset,
    endOffset: params.endOffset,
    contentHash: sha256(params.content.slice(params.startOffset, params.endOffset)),
    originClass: params.originClass,
    observedAt: params.observedAt,
  };
}

function verifiedSegments(
  content: string,
  provenance: MemoryArtifactProvenance,
): MemoryArtifactProvenanceSegment[] | null {
  if (provenance.fileHash !== sha256(content)) {
    return null;
  }
  if (!provenance.segments) {
    return content.length === 0
      ? []
      : [
          segmentFor({
            content,
            startOffset: 0,
            endOffset: content.length,
            originClass: provenance.originClass,
            observedAt: provenance.observedAt,
          }),
        ];
  }
  let cursor = 0;
  for (const segment of provenance.segments) {
    if (
      segment.startOffset !== cursor ||
      segment.endOffset <= segment.startOffset ||
      segment.endOffset > content.length ||
      segment.contentHash !== sha256(content.slice(segment.startOffset, segment.endOffset))
    ) {
      return null;
    }
    cursor = segment.endOffset;
  }
  return cursor === content.length ? provenance.segments : null;
}

function provenanceFromSegments(params: {
  content: string;
  segments: MemoryArtifactProvenanceSegment[];
  observedAt: number;
  sessionId?: string;
  sessionKey?: string;
}): MemoryArtifactProvenance {
  return {
    fileHash: sha256(params.content),
    originClass: params.segments.some((segment) => segment.originClass === "untrusted")
      ? "untrusted"
      : "agent",
    observedAt: params.observedAt,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    segments: params.segments,
  };
}

function buildWriteProvenance(params: {
  previous?: MemoryArtifactProvenance;
  contentBefore: string;
  contentAfter: string;
  originClass: MemoryArtifactOriginClass;
  observedAt: number;
  sessionId?: string;
  sessionKey?: string;
}): MemoryArtifactProvenance {
  if (!params.contentAfter.startsWith(params.contentBefore)) {
    const trustedRewrite =
      params.originClass === "agent" &&
      (!params.previous ||
        (params.previous.originClass === "agent" &&
          params.previous.fileHash === sha256(params.contentBefore)));
    const originClass = trustedRewrite ? "agent" : "untrusted";
    return provenanceFromSegments({
      content: params.contentAfter,
      segments:
        params.contentAfter.length === 0
          ? []
          : [
              segmentFor({
                content: params.contentAfter,
                startOffset: 0,
                endOffset: params.contentAfter.length,
                originClass,
                observedAt: params.observedAt,
              }),
            ],
      observedAt: params.observedAt,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
  }

  const previousSegments = params.previous
    ? verifiedSegments(params.contentBefore, params.previous)
    : params.contentBefore.length === 0
      ? []
      : null;
  const segments = [
    ...(previousSegments ??
      (params.contentBefore.length === 0
        ? []
        : [
            segmentFor({
              content: params.contentBefore,
              startOffset: 0,
              endOffset: params.contentBefore.length,
              originClass: params.previous?.originClass ?? "untrusted",
              observedAt: params.previous?.observedAt ?? params.observedAt,
            }),
          ])),
  ];
  if (params.contentAfter.length > params.contentBefore.length) {
    segments.push(
      segmentFor({
        content: params.contentAfter,
        startOffset: params.contentBefore.length,
        endOffset: params.contentAfter.length,
        originClass: params.originClass,
        observedAt: params.observedAt,
      }),
    );
  }
  return provenanceFromSegments({
    content: params.contentAfter,
    segments,
    observedAt: params.observedAt,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(a: string, b: string, prefixLength: number): number {
  const limit = Math.min(a.length, b.length) - prefixLength;
  let count = 0;
  while (count < limit && a[a.length - count - 1] === b[b.length - count - 1]) {
    count += 1;
  }
  return count;
}

function clipSegment(params: {
  content: string;
  source: MemoryArtifactProvenanceSegment;
  sourceStart: number;
  sourceEnd: number;
  targetStart: number;
}): MemoryArtifactProvenanceSegment | undefined {
  const start = Math.max(params.source.startOffset, params.sourceStart);
  const end = Math.min(params.source.endOffset, params.sourceEnd);
  if (end <= start) {
    return undefined;
  }
  const startOffset = params.targetStart + (start - params.sourceStart);
  return segmentFor({
    content: params.content,
    startOffset,
    endOffset: startOffset + (end - start),
    originClass: params.source.originClass,
    observedAt: params.source.observedAt,
  });
}

function buildRebasedProvenance(params: {
  previous?: MemoryArtifactProvenance;
  contentBefore: string;
  contentAfter: string;
  observedAt: number;
}): MemoryArtifactProvenance {
  const prior =
    (params.previous && verifiedSegments(params.contentBefore, params.previous)) ??
    (params.contentBefore.length === 0
      ? []
      : [
          segmentFor({
            content: params.contentBefore,
            startOffset: 0,
            endOffset: params.contentBefore.length,
            originClass: params.previous?.originClass ?? "untrusted",
            observedAt: params.previous?.observedAt ?? params.observedAt,
          }),
        ]);
  const prefixLength = commonPrefixLength(params.contentBefore, params.contentAfter);
  const suffixLength = commonSuffixLength(params.contentBefore, params.contentAfter, prefixLength);
  const beforeSuffixStart = params.contentBefore.length - suffixLength;
  const afterSuffixStart = params.contentAfter.length - suffixLength;
  const prefixSegments = prior.flatMap((segment) => {
    const clipped = clipSegment({
      content: params.contentAfter,
      source: segment,
      sourceStart: 0,
      sourceEnd: prefixLength,
      targetStart: 0,
    });
    return clipped ? [clipped] : [];
  });
  const changedSegments =
    afterSuffixStart > prefixLength
      ? [
          segmentFor({
            content: params.contentAfter,
            startOffset: prefixLength,
            endOffset: afterSuffixStart,
            originClass: "untrusted",
            observedAt: params.observedAt,
          }),
        ]
      : [];
  const suffixSegments = prior.flatMap((segment) => {
    const clipped = clipSegment({
      content: params.contentAfter,
      source: segment,
      sourceStart: beforeSuffixStart,
      sourceEnd: params.contentBefore.length,
      targetStart: afterSuffixStart,
    });
    return clipped ? [clipped] : [];
  });
  return provenanceFromSegments({
    content: params.contentAfter,
    segments: [...prefixSegments, ...changedSegments, ...suffixSegments],
    observedAt: params.observedAt,
  });
}

function normalizeWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir);
  let canonical = resolved;
  try {
    // Provenance follows the physical workspace so symlink or junction aliases
    // cannot split the writer and reader into different trust records.
    canonical = realpathSync.native(resolved);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  const normalized = canonical.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function normalizeMemoryArtifactRelativePath(relativePath: string): string | undefined {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    return undefined;
  }
  if (["MEMORY.md", "memory.md", "USER.md"].includes(normalized)) {
    return normalized;
  }
  if (!normalized.startsWith("memory/") || !normalized.endsWith(".md")) {
    return undefined;
  }
  if (normalized.startsWith("memory/dreaming/") || normalized.startsWith("memory/.dreams/")) {
    return undefined;
  }
  return normalized;
}

function resolveAddress(params: {
  workspaceDir: string;
  relativePath: string;
}): MemoryArtifactAddress | undefined {
  const relativePath = normalizeMemoryArtifactRelativePath(params.relativePath);
  if (!relativePath) {
    return undefined;
  }
  const workspaceKey = sha256(normalizeWorkspaceKey(params.workspaceDir));
  return {
    workspaceKey,
    relativePath,
    storeKey: `${workspaceKey}:${sha256(relativePath)}`,
  };
}

function openStore() {
  return createCorePluginStateSyncKeyedStore<StoredMemoryArtifactProvenance>({
    ownerId: MEMORY_ARTIFACT_PROVENANCE_OWNER_ID,
    namespace: MEMORY_ARTIFACT_PROVENANCE_NAMESPACE,
    maxEntries: MEMORY_ARTIFACT_PROVENANCE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

function normalizeStoredProvenance(
  value: StoredMemoryArtifactProvenance | undefined,
  address: MemoryArtifactAddress,
): StoredMemoryArtifactProvenance | undefined {
  if (
    value?.version !== 1 ||
    value.workspaceKey !== address.workspaceKey ||
    value.relativePath !== address.relativePath ||
    !/^[a-f0-9]{64}$/u.test(value.fileHash) ||
    (value.originClass !== "agent" && value.originClass !== "untrusted") ||
    !Number.isSafeInteger(value.observedAt) ||
    typeof value.reservationId !== "string" ||
    value.reservationId.length === 0 ||
    (value.segments !== undefined &&
      (!Array.isArray(value.segments) ||
        value.segments.some(
          (segment, index) =>
            !Number.isSafeInteger(segment.startOffset) ||
            !Number.isSafeInteger(segment.endOffset) ||
            segment.startOffset < 0 ||
            segment.endOffset <= segment.startOffset ||
            (index === 0
              ? segment.startOffset !== 0
              : segment.startOffset !== value.segments?.[index - 1]?.endOffset) ||
            !/^[a-f0-9]{64}$/u.test(segment.contentHash) ||
            (segment.originClass !== "agent" && segment.originClass !== "untrusted") ||
            !Number.isSafeInteger(segment.observedAt),
        )))
  ) {
    return undefined;
  }
  return value;
}

function toPublicProvenance(stored: StoredMemoryArtifactProvenance): MemoryArtifactProvenance {
  return {
    fileHash: stored.fileHash,
    originClass: stored.originClass,
    observedAt: stored.observedAt,
    ...(stored.sessionId ? { sessionId: stored.sessionId } : {}),
    ...(stored.sessionKey ? { sessionKey: stored.sessionKey } : {}),
    ...(stored.segments ? { segments: stored.segments.map((segment) => ({ ...segment })) } : {}),
  };
}

export async function recordMemoryArtifactWriteProvenance(params: {
  workspaceDir: string;
  relativePath: string;
  contentBefore: string;
  contentAfter: string;
  originClass: MemoryArtifactOriginClass;
  observedAt: number;
  sessionId?: string;
  sessionKey?: string;
}): Promise<(() => Promise<void>) | undefined> {
  const address = resolveAddress(params);
  if (!address) {
    return undefined;
  }
  const store = openStore();
  const reservationId = randomUUID();
  let previous: StoredMemoryArtifactProvenance | undefined;
  store.update(address.storeKey, (current) => {
    previous = normalizeStoredProvenance(current, address);
    const provenance = buildWriteProvenance({
      ...(previous ? { previous: toPublicProvenance(previous) } : {}),
      contentBefore: params.contentBefore,
      contentAfter: params.contentAfter,
      originClass: params.originClass,
      observedAt: params.observedAt,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
    return {
      version: 1,
      workspaceKey: address.workspaceKey,
      relativePath: address.relativePath,
      ...provenance,
      reservationId,
    };
  });

  return async () => {
    const rollbackStore = openStore();
    if (previous) {
      rollbackStore.update(address.storeKey, (current) =>
        current?.reservationId === reservationId ? previous : undefined,
      );
      return;
    }
    rollbackStore.deleteIf(address.storeKey, (current) => current.reservationId === reservationId);
  };
}

export async function rebaseMemoryArtifactWriteProvenance(params: {
  workspaceDir: string;
  relativePath: string;
  contentBefore: string;
  contentAfter: string;
  observedAt: number;
}): Promise<(() => Promise<void>) | undefined> {
  const address = resolveAddress(params);
  if (!address) {
    return undefined;
  }
  const store = openStore();
  const reservationId = randomUUID();
  let previous: StoredMemoryArtifactProvenance | undefined;
  store.update(address.storeKey, (current) => {
    previous = normalizeStoredProvenance(current, address);
    const provenance = buildRebasedProvenance({
      ...(previous ? { previous: toPublicProvenance(previous) } : {}),
      contentBefore: params.contentBefore,
      contentAfter: params.contentAfter,
      observedAt: params.observedAt,
    });
    return {
      version: 1,
      workspaceKey: address.workspaceKey,
      relativePath: address.relativePath,
      ...provenance,
      reservationId,
    };
  });

  return async () => {
    const rollbackStore = openStore();
    if (previous) {
      rollbackStore.update(address.storeKey, (current) =>
        current?.reservationId === reservationId ? previous : undefined,
      );
      return;
    }
    rollbackStore.deleteIf(address.storeKey, (current) => current.reservationId === reservationId);
  };
}

export async function clearMemoryArtifactProvenance(params: {
  workspaceDir: string;
  relativePath: string;
  contentBefore: string;
}): Promise<void> {
  const address = resolveAddress(params);
  if (!address) {
    return;
  }
  const expectedHash = sha256(params.contentBefore);
  openStore().deleteIf(address.storeKey, (current) => current.fileHash === expectedHash);
}

export async function readMemoryArtifactProvenance(params: {
  workspaceDir: string;
  relativePath: string;
}): Promise<MemoryArtifactProvenance | undefined> {
  const address = resolveAddress(params);
  if (!address) {
    return undefined;
  }
  const stored = normalizeStoredProvenance(openStore().lookup(address.storeKey), address);
  return stored ? toPublicProvenance(stored) : undefined;
}

export async function listMemoryArtifactProvenance(params: {
  workspaceDir: string;
}): Promise<Array<{ relativePath: string; provenance: MemoryArtifactProvenance }>> {
  const workspaceKey = sha256(normalizeWorkspaceKey(params.workspaceDir));
  const prefix = `${workspaceKey}:`;
  return openStore()
    .entries()
    .filter((entry) => entry.key.startsWith(prefix))
    .flatMap((entry) => {
      const address = {
        workspaceKey,
        relativePath: entry.value.relativePath,
        storeKey: entry.key,
      };
      const stored = normalizeStoredProvenance(entry.value, address);
      return stored
        ? [{ relativePath: stored.relativePath, provenance: toPublicProvenance(stored) }]
        : [];
    });
}
