import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readSessionTranscriptSearchVersion,
  searchSessionTranscripts,
} from "../config/sessions/session-transcript-search.js";
import { createRetainedCache } from "../infra/retained-cache.js";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import { readSessionMessageByIdAsync } from "./session-transcript-readers.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

const GITHUB_URL_CANDIDATE = /https:\/\/github\.com\/[^\s<>()\]}'"`]+/giu;
const MAX_REFERENCES = 3;
type ReferenceCacheEntry = { version: string | null; promise: Promise<number[]> };
const referenceCache = createRetainedCache<ReferenceCacheEntry>();

function loadReferenceSession(params: { sessionKey: string; agentId?: string }) {
  return loadGatewaySessionEntryReadOnly(params.sessionKey, {
    agentId: params.agentId,
    clone: false,
    projection: "list",
  });
}

function referenceSourceKey(loaded: ReturnType<typeof loadReferenceSession>): string {
  const { entry, agentId, canonicalKey, storePath } = loaded;
  return JSON.stringify([
    agentId,
    canonicalKey,
    storePath,
    entry?.sessionId,
    entry?.lifecycleRevision,
    entry?.repositoryWorkspaceId,
    entry?.worktree?.id,
    entry?.worktree?.branch,
    entry?.spawnedCwd,
    entry?.spawnedWorkspaceDir,
  ]);
}

export function releaseSessionPullRequestReferenceCache(signal?: AbortSignal): void {
  referenceCache.release(signal);
}

function referencedPullRequestNumber(
  href: string,
  repository: { owner: string; repo: string },
): number | undefined {
  try {
    const url = new URL(href.replace(/[.,;:!?]+$/u, ""));
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.username ||
      url.password ||
      url.port
    ) {
      return undefined;
    }
    const [, owner, repo, kind, number] = url.pathname.split("/");
    if (
      !owner ||
      !repo ||
      kind !== "pull" ||
      !number ||
      !/^[1-9]\d{0,9}$/u.test(number) ||
      decodeURIComponent(owner).toLowerCase() !== repository.owner.toLowerCase() ||
      decodeURIComponent(repo).toLowerCase() !== repository.repo.toLowerCase()
    ) {
      return undefined;
    }
    return Number(number);
  } catch {
    return undefined;
  }
}

/** References describe this conversation's work; they never grant publication authority. */
export async function loadSessionPullRequestReferences(
  params: { sessionKey: string; agentId?: string },
  repository: { owner: string; repo: string },
  cacheSignal?: AbortSignal,
): Promise<number[]> {
  const loaded = loadReferenceSession(params);
  const { entry, agentId, canonicalKey, storePath } = loaded;
  if (!entry?.sessionId || !storePath) {
    referenceCache.release(cacheSignal);
    return [];
  }
  const scope = {
    agentId,
    sessionId: entry.sessionId,
    sessionKey: canonicalKey,
    storePath,
    sessionEntry: { sessionId: entry.sessionId },
  };
  const sourceKey = referenceSourceKey(loaded);
  const key = JSON.stringify([
    sourceKey,
    repository.owner.toLowerCase(),
    repository.repo.toLowerCase(),
  ]);
  const version = readSessionTranscriptSearchVersion(scope);
  let cached = referenceCache.get(key, cacheSignal);
  if (!cached || cached.version !== version || version === null) {
    const pending: ReferenceCacheEntry = {
      version,
      promise: Promise.resolve()
        .then(async () => {
          const result = await readReferences(scope, repository);
          if (result.indexing) {
            referenceCache.delete(key, pending);
          }
          return result.references;
        })
        .catch((error: unknown) => {
          referenceCache.delete(key, pending);
          throw error;
        }),
    };
    if (version !== null) {
      referenceCache.set(key, pending, cacheSignal);
    } else {
      referenceCache.release(cacheSignal);
    }
    cached = pending;
  }
  const references = await cached.promise;
  if (
    referenceSourceKey(loadReferenceSession(params)) !== sourceKey ||
    readSessionTranscriptSearchVersion(scope) !== version
  ) {
    referenceCache.delete(key, cached);
    return [];
  }
  return [...references];
}

async function readReferences(
  scope: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
    sessionEntry: { sessionId: string };
  },
  repository: { owner: string; repo: string },
): Promise<{ references: number[]; indexing: boolean }> {
  const candidates = searchSessionTranscripts({
    ...scope,
    sessionKeys: [scope.sessionKey],
    role: "assistant",
    query: `https://github.com/${repository.owner}/${repository.repo}/pull`,
    order: "recent",
    limit: 25,
  });
  if (candidates.indexing && candidates.hits.length === 0) {
    throw new Error("Session pull request references are waiting for transcript indexing");
  }
  const references = new Set<number>();
  let remainingBytes = 128 * 1024;
  // Search skips bulky tool output; canonical hydration rejects reset-hidden hits.
  for (const candidate of candidates.hits) {
    if (remainingBytes <= 0 || references.size === MAX_REFERENCES) {
      break;
    }
    const result = await readSessionMessageByIdAsync(scope, candidate.messageId, {
      currentOnly: true,
      maxBytes: remainingBytes,
    });
    remainingBytes -= result.serializedBytes ?? 0;
    const record = asOptionalRecord(result.message);
    if (record?.role !== "assistant") {
      continue;
    }
    const blocks = readAssistantDisplayContent(record);
    const texts =
      !Array.isArray(record.openclawDisplayContent) && typeof record.content === "string"
        ? [record.content]
        : blocks.flatMap((block) =>
            block.type === "text" && typeof block.text === "string" ? [block.text] : [],
          );
    for (const text of texts.toReversed()) {
      for (const match of Array.from(text.matchAll(GITHUB_URL_CANDIDATE)).toReversed()) {
        const number = referencedPullRequestNumber(match[0], repository);
        if (number !== undefined && references.size < MAX_REFERENCES) {
          references.add(number);
        }
      }
    }
  }
  return { references: [...references], indexing: candidates.indexing };
}
