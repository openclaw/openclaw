import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isMissingPathError } from "../infra/errors.js";
import { createCorePluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";

const MEMORY_ARTIFACT_PROVENANCE_OWNER_ID = "core:memory-artifact-provenance";
const MEMORY_ARTIFACT_PROVENANCE_NAMESPACE = "workspace-files";
const MEMORY_ARTIFACT_PROVENANCE_MAX_ENTRIES = 50_000;

export type MemoryArtifactOriginClass = "agent" | "untrusted";

export type MemoryArtifactProvenance = {
  fileHash: string;
  originClass: MemoryArtifactOriginClass;
  observedAt: number;
  sessionId?: string;
  sessionKey?: string;
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

function toPublicProvenance(stored: StoredMemoryArtifactProvenance): MemoryArtifactProvenance {
  return {
    fileHash: stored.fileHash,
    originClass: stored.originClass,
    observedAt: stored.observedAt,
    ...(stored.sessionId ? { sessionId: stored.sessionId } : {}),
    ...(stored.sessionKey ? { sessionKey: stored.sessionKey } : {}),
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
