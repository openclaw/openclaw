/**
 * Agent Media Cache - 独立的附件缓存机制
 * 用于在 requireMention 检查之前缓存群组消息的附件
 * 每个 agent 最多 5GB，超过后从最旧的开始删除
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { logVerbose } from "../globals.js";
import { resolveConfigDir } from "../utils.js";

const MAX_CACHE_SIZE_BYTES = 5 * 1024 * 1024 * 1024; // 5GB per agent
const CACHE_INDEX_FILE = "cache-index.json";

type CacheEntry = {
  id: string;
  path: string;
  contentType?: string;
  size: number;
  savedAt: number;
  channel: string;
  groupId?: string;
  senderId?: string;
  timestamp?: number;
};

type CacheIndex = {
  entries: CacheEntry[];
  totalSize: number;
};

// 每个 agentId 的 cache index
const cacheIndexMap = new Map<string, CacheIndex>();

function resolveAgentCacheDir(agentId: string): string {
  return path.join(resolveConfigDir(), "agents", agentId, "media-cache");
}

function resolveAgentCacheIndexPath(agentId: string): string {
  return path.join(resolveAgentCacheDir(agentId), CACHE_INDEX_FILE);
}

async function loadCacheIndex(agentId: string): Promise<CacheIndex> {
  const cached = cacheIndexMap.get(agentId);
  if (cached) {
    return cached;
  }

  const indexPath = resolveAgentCacheIndexPath(agentId);
  try {
    const content = await fs.readFile(indexPath, "utf-8");
    const index = JSON.parse(content) as CacheIndex;
    cacheIndexMap.set(agentId, index);
    logVerbose(
      `agent media cache loaded: agentId=${agentId} entries=${index.entries.length} size=${formatBytes(index.totalSize)}`,
    );
    return index;
  } catch {
    const emptyIndex: CacheIndex = { entries: [], totalSize: 0 };
    cacheIndexMap.set(agentId, emptyIndex);
    return emptyIndex;
  }
}

async function saveCacheIndex(agentId: string, index: CacheIndex): Promise<void> {
  const cacheDir = resolveAgentCacheDir(agentId);
  await fs.mkdir(cacheDir, { recursive: true });
  const indexPath = resolveAgentCacheIndexPath(agentId);
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

/**
 * 清理旧文件直到总大小低于限制
 */
async function cleanupOldEntries(
  agentId: string,
  index: CacheIndex,
  targetSize: number,
): Promise<void> {
  // 按 savedAt 排序，最旧的在前
  const sorted = [...index.entries].sort((a, b) => a.savedAt - b.savedAt);

  while (index.totalSize > targetSize && sorted.length > 0) {
    const oldest = sorted.shift();
    if (!oldest) break;

    try {
      await fs.unlink(oldest.path);
      logVerbose(`agent media cache cleanup: deleted ${oldest.path} (${formatBytes(oldest.size)})`);
    } catch {
      // File may already be deleted, ignore
    }

    index.totalSize -= oldest.size;
    const idx = index.entries.findIndex((e) => e.id === oldest.id);
    if (idx >= 0) {
      index.entries.splice(idx, 1);
    }
  }
}

export type SaveToAgentCacheParams = {
  agentId: string;
  buffer: Buffer;
  contentType?: string;
  channel: string;
  groupId?: string;
  senderId?: string;
  timestamp?: number;
  originalFilename?: string;
};

/**
 * 保存媒体到 agent cache
 */
export async function saveToAgentCache(params: SaveToAgentCacheParams): Promise<{
  path: string;
  contentType?: string;
} | null> {
  const { agentId, buffer, contentType, channel, groupId, senderId, timestamp, originalFilename } =
    params;

  if (!buffer || buffer.length === 0) {
    return null;
  }

  const index = await loadCacheIndex(agentId);
  const cacheDir = resolveAgentCacheDir(agentId);
  await fs.mkdir(cacheDir, { recursive: true });

  // 如果加上新文件会超过限制，先清理
  if (index.totalSize + buffer.length > MAX_CACHE_SIZE_BYTES) {
    const targetSize = MAX_CACHE_SIZE_BYTES - buffer.length - 100 * 1024 * 1024; // 留 100MB 余量
    await cleanupOldEntries(agentId, index, Math.max(0, targetSize));
  }

  // 生成唯一 ID 和文件路径
  const id = crypto.randomUUID();
  const ext = contentType?.split("/")[1]?.split(";")[0] ?? "bin";
  const filename = originalFilename
    ? `${sanitizeFilename(originalFilename)}---${id}.${ext}`
    : `${id}.${ext}`;
  const filePath = path.join(cacheDir, filename);

  try {
    await fs.writeFile(filePath, buffer);

    const entry: CacheEntry = {
      id,
      path: filePath,
      contentType,
      size: buffer.length,
      savedAt: Date.now(),
      channel,
      groupId,
      senderId,
      timestamp,
    };

    index.entries.push(entry);
    index.totalSize += buffer.length;

    await saveCacheIndex(agentId, index);
    logVerbose(
      `agent media cache saved: agentId=${agentId} path=${filePath} size=${formatBytes(buffer.length)}`,
    );

    return { path: filePath, contentType };
  } catch (err) {
    logVerbose(`agent media cache save failed: ${String(err)}`);
    return null;
  }
}

/**
 * 获取 agent cache 的统计信息
 */
export async function getAgentCacheStats(agentId: string): Promise<{
  entries: number;
  totalSize: number;
  totalSizeFormatted: string;
}> {
  const index = await loadCacheIndex(agentId);
  return {
    entries: index.entries.length,
    totalSize: index.totalSize,
    totalSizeFormatted: formatBytes(index.totalSize),
  };
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  const sanitized = trimmed.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  return sanitized.replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
}
