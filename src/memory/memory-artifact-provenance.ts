import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../agents/workspace-bootstrap-read.js";
import { captureOfflineStateOwnerAssertion } from "../cli/local-state-owner.js";
import { isMissingPathError } from "../infra/errors.js";
import { root } from "../infra/fs-safe.js";
import { createCorePluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { CANONICAL_ROOT_MEMORY_FILENAME, exactWorkspaceEntryExists } from "./root-memory-files.js";

const MEMORY_ARTIFACT_PROVENANCE_OWNER_ID = "core:memory-artifact-provenance";
const MEMORY_ARTIFACT_PROVENANCE_NAMESPACE = "workspace-files";
const MEMORY_ARTIFACT_PROVENANCE_MAX_ENTRIES = 50_000;

export type MemoryArtifactOriginClass = "agent" | "untrusted";

type TrackedWriteProvenance = {
  fileHash: string;
  originClass: MemoryArtifactOriginClass;
  observedAt: number;
  sessionId?: string;
  sessionKey?: string;
};

export type MemoryArtifactProvenance = TrackedWriteProvenance & {
  trustRestore?: {
    source: "cli";
    restoredAt: number;
    reviewedSha256: string;
    previousTrackedWrite: TrackedWriteProvenance;
  };
};

type StoredMemoryArtifactProvenance = MemoryArtifactProvenance & {
  version: 1;
  workspaceKey: string;
  relativePath: string;
  reservationId: string;
  trustRestoreIsLatest?: true;
};

type MemoryArtifactAddress = {
  workspaceKey: string;
  relativePath: string;
  storeKey: string;
};

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
  if (
    ["MEMORY.md", "memory.md", "USER.md"].includes(normalized) ||
    /^users\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\/USER\.md$/.test(normalized)
  ) {
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
  const workspaceKey = sha256Hex(normalizeWorkspaceKey(params.workspaceDir));
  return {
    workspaceKey,
    relativePath,
    storeKey: `${workspaceKey}:${sha256Hex(relativePath)}`,
  };
}

function openStore() {
  return createCorePluginStateKeyedStore<StoredMemoryArtifactProvenance>({
    ownerId: MEMORY_ARTIFACT_PROVENANCE_OWNER_ID,
    namespace: MEMORY_ARTIFACT_PROVENANCE_NAMESPACE,
    maxEntries: MEMORY_ARTIFACT_PROVENANCE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

function normalizeStoredProvenance(
  value: StoredMemoryArtifactProvenance | undefined,
  address: Pick<MemoryArtifactAddress, "workspaceKey" | "relativePath">,
): StoredMemoryArtifactProvenance | undefined {
  if (
    value?.version !== 1 ||
    value.workspaceKey !== address.workspaceKey ||
    value.relativePath !== address.relativePath ||
    !/^[a-f0-9]{64}$/u.test(value.fileHash) ||
    (value.originClass !== "agent" && value.originClass !== "untrusted") ||
    !Number.isSafeInteger(value.observedAt) ||
    typeof value.reservationId !== "string" ||
    value.reservationId.length === 0
  ) {
    return undefined;
  }
  return value;
}

function trackedWriteProvenance(stored: StoredMemoryArtifactProvenance): TrackedWriteProvenance {
  if (stored.trustRestoreIsLatest && stored.trustRestore) {
    return stored.trustRestore.previousTrackedWrite;
  }
  return {
    fileHash: stored.fileHash,
    originClass: stored.originClass,
    observedAt: stored.observedAt,
    ...(stored.sessionId ? { sessionId: stored.sessionId } : {}),
    ...(stored.sessionKey ? { sessionKey: stored.sessionKey } : {}),
  };
}

function toPublicProvenance(stored: StoredMemoryArtifactProvenance): MemoryArtifactProvenance {
  return {
    ...trackedWriteProvenance(stored),
    fileHash: stored.fileHash,
    originClass: stored.originClass,
    ...(stored.trustRestore ? { trustRestore: stored.trustRestore } : {}),
  };
}

/** A restored row covers the bytes read by the consumer, not a later external edit. */
export function resolveRecordedMemoryArtifactOrigin(
  recorded: MemoryArtifactProvenance,
  contentSha256?: string,
): MemoryArtifactOriginClass {
  return recorded.trustRestore && recorded.fileHash !== contentSha256
    ? "untrusted"
    : recorded.originClass;
}

export async function readRootMemoryForTrust(workspaceDir: string): Promise<{
  workspaceDir: string;
  filePath: string;
  sha256: string;
}> {
  const workspace = await root(workspaceDir);
  if (!(await exactWorkspaceEntryExists(workspace.rootReal, CANONICAL_ROOT_MEMORY_FILENAME))) {
    throw new Error("The configured workspace has no root MEMORY.md.");
  }
  const { buffer, realPath } = await workspace.read(CANONICAL_ROOT_MEMORY_FILENAME, {
    symlinks: "reject",
    hardlinks: "reject",
    maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  });
  return { workspaceDir: workspace.rootReal, filePath: realPath, sha256: sha256Hex(buffer) };
}

/** Offline CLI only: bind the reviewed bytes and the prior tracked write in one row update. */
export async function restoreRootMemoryTrust(params: {
  workspaceDir: string;
  reviewedSha256: string;
}): Promise<{ filePath: string; changed: boolean }> {
  const assertCurrent = captureOfflineStateOwnerAssertion();
  const file = await readRootMemoryForTrust(params.workspaceDir);
  if (file.sha256 !== params.reviewedSha256) {
    throw new Error(
      "MEMORY.md SHA-256 does not match the reviewed hash. Review the current file and preview again.",
    );
  }
  const address = resolveAddress({
    workspaceDir: file.workspaceDir,
    relativePath: CANONICAL_ROOT_MEMORY_FILENAME,
  })!;
  const store = openStore().withCurrent({ assertCurrent });
  const observation = await store.observe(address.storeKey);
  const stored = normalizeStoredProvenance(observation.value, address);
  if (!stored) {
    throw new Error(
      "No tracked provenance exists for root MEMORY.md; there is no trust record to restore.",
    );
  }
  if (stored.originClass === "agent" && stored.fileHash === file.sha256) {
    return { filePath: file.filePath, changed: false };
  }
  if (stored.originClass !== "untrusted" && !stored.trustRestore) {
    throw new Error("The tracked provenance for root MEMORY.md is not quarantined.");
  }
  const result = await store.compareAndApply(address.storeKey, observation.comparison, {
    operation: "update",
    action: "set",
    value: {
      ...stored,
      originClass: "agent",
      fileHash: file.sha256,
      reservationId: randomUUID(),
      trustRestoreIsLatest: true,
      trustRestore: {
        source: "cli",
        restoredAt: Date.now(),
        reviewedSha256: file.sha256,
        previousTrackedWrite: trackedWriteProvenance(stored),
      },
    },
  });
  if (result.status !== "applied") {
    throw new Error("MEMORY.md provenance changed during restoration. Review and preview again.");
  }
  return { filePath: file.filePath, changed: true };
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
  const beforeHash = sha256Hex(params.contentBefore);
  const afterHash = sha256Hex(params.contentAfter);
  let previous: StoredMemoryArtifactProvenance | undefined;
  let observation = await store.observe(address.storeKey);
  for (;;) {
    previous = normalizeStoredProvenance(observation.value, address);
    const originClass =
      params.originClass === "agent" &&
      (!previous || (previous.originClass === "agent" && previous.fileHash === beforeHash))
        ? "agent"
        : "untrusted";
    const result = await store.compareAndApply(address.storeKey, observation.comparison, {
      operation: "update",
      action: "set",
      value: {
        version: 1,
        workspaceKey: address.workspaceKey,
        relativePath: address.relativePath,
        fileHash: afterHash,
        originClass,
        observedAt: params.observedAt,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(previous?.trustRestore ? { trustRestore: previous.trustRestore } : {}),
        reservationId,
      },
    });
    if (result.status !== "conflict") {
      break;
    }
    observation = result.current;
  }

  return async () => {
    const rollbackStore = openStore();
    let current = await rollbackStore.observe(address.storeKey);
    while (current.value?.reservationId === reservationId) {
      const result = await rollbackStore.compareAndApply(
        address.storeKey,
        current.comparison,
        previous
          ? { operation: "update", action: "set", value: previous }
          : { operation: "delete", action: "delete" },
      );
      if (result.status !== "conflict") {
        return;
      }
      current = result.current;
    }
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
  const expectedHash = sha256Hex(params.contentBefore);
  const store = openStore();
  let observation = await store.observe(address.storeKey);
  while (observation.value?.fileHash === expectedHash) {
    const result = await store.compareAndApply(address.storeKey, observation.comparison, {
      operation: "delete",
      action: "delete",
    });
    if (result.status !== "conflict") {
      return;
    }
    observation = result.current;
  }
}

export async function readMemoryArtifactProvenance(params: {
  workspaceDir: string;
  relativePath: string;
}): Promise<MemoryArtifactProvenance | undefined> {
  const address = resolveAddress(params);
  if (!address) {
    return undefined;
  }
  const stored = normalizeStoredProvenance(await openStore().lookup(address.storeKey), address);
  return stored ? toPublicProvenance(stored) : undefined;
}

export async function listMemoryArtifactProvenance(params: {
  workspaceDir: string;
}): Promise<Array<{ relativePath: string; provenance: MemoryArtifactProvenance }>> {
  const workspaceKey = sha256Hex(normalizeWorkspaceKey(params.workspaceDir));
  // The adjacent ASCII separators bound exactly this workspace's key prefix.
  const entries = await openStore().entriesInKeyRange({
    keyStartInclusive: `${workspaceKey}:`,
    keyEndExclusive: `${workspaceKey};`,
    limit: Number.MAX_SAFE_INTEGER,
    order: "asc",
  });
  // Stable sorting preserves the store's key order when creation times tie.
  return entries
    .toSorted((left, right) => left.createdAt - right.createdAt)
    .flatMap((entry) => {
      const stored = normalizeStoredProvenance(entry.value, {
        workspaceKey,
        relativePath: entry.value.relativePath,
      });
      return stored
        ? [{ relativePath: stored.relativePath, provenance: toPublicProvenance(stored) }]
        : [];
    });
}
