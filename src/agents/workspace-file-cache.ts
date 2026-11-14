import { LruCache } from "../infra/lru-cache.js";
import { isPathInside } from "../infra/path-guards.js";
import { DEFAULT_IDENTITY_FILENAME } from "./workspace-bootstrap-policy.js";
import {
  MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  projectWorkspaceBootstrapFileForPrompt,
} from "./workspace-bootstrap-read.js";

type WorkspaceFileCacheEntry = {
  content: string;
  identity: string;
  sizeBytes: number;
  identityPrompt?: { content: string; sizeBytes: number };
};

// Raw files and prepared prompt text share the existing process-wide byte budget.
// The entry cap also bounds empty files and high workspace fan-out.
const MAX_WORKSPACE_FILE_CACHE_BYTES = 6 * MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES;
const MAX_WORKSPACE_FILE_CACHE_ENTRIES = 64;
const workspaceFileCache = new LruCache<WorkspaceFileCacheEntry>(MAX_WORKSPACE_FILE_CACHE_ENTRIES, {
  maxBytes: MAX_WORKSPACE_FILE_CACHE_BYTES,
  sizeOf: (entry) => entry.sizeBytes + (entry.identityPrompt?.sizeBytes ?? 0),
});

export function readWorkspaceFileCache(
  filePath: string,
  identity: string,
  promptFileName?: string,
): string | undefined {
  const entry = workspaceFileCache.get(filePath);
  if (!entry) {
    return undefined;
  }
  if (entry.identity !== identity) {
    workspaceFileCache.delete(filePath);
    return undefined;
  }
  if (promptFileName === DEFAULT_IDENTITY_FILENAME) {
    if (entry.identityPrompt) {
      return entry.identityPrompt.content;
    }
    const content = projectWorkspaceBootstrapFileForPrompt(entry.content, promptFileName);
    // Replace rather than mutate: LRU deletion must subtract the old entry's size.
    workspaceFileCache.set(filePath, {
      ...entry,
      identityPrompt: {
        content,
        sizeBytes: content === entry.content ? 0 : Buffer.byteLength(content),
      },
    });
    return content;
  }
  return entry.content;
}

export function writeWorkspaceFileCache(params: {
  filePath: string;
  content: string;
  identity: string;
}): void {
  workspaceFileCache.set(params.filePath, {
    content: params.content,
    identity: params.identity,
    sizeBytes: Buffer.byteLength(params.content, "utf8"),
  });
}

export function retireWorkspaceFileCache(workspaceRoot: string): void {
  // SQLite identities are NFC even when the vanished filesystem path was not.
  // Normalize only retirement comparisons; cache reads keep raw paths distinct.
  const rootIdentityPath = workspaceRoot.normalize("NFC");
  for (const filePath of workspaceFileCache.keys()) {
    if (isPathInside(rootIdentityPath, filePath.normalize("NFC"))) {
      workspaceFileCache.delete(filePath);
    }
  }
}
