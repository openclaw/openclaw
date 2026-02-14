/**
 * LINE Sender Name Cache — 從本地快取解析 LINE userId → 顯示名稱
 *
 * 優先級：
 *   1. 記憶體快取（5 分鐘 TTL）
 *   2. 本地 JSON 檔（line-profile-cache.json）
 *   3. LINE API fallback（getUserProfile，自動回寫 JSON）
 *   4. fallback → undefined（讓上層用 userId）
 *
 * 快取檔案位置：workspace/references/line-profile-cache.json
 * 格式：{ [groupId]: { [userId]: displayName } }
 */
import fs from "node:fs";
import path from "node:path";
import { logVerbose } from "../globals.js";

type ProfileCache = Record<string, Record<string, string>>;

let _cache: ProfileCache | null = null;
let _cacheLoadedAt = 0;
const CACHE_RELOAD_INTERVAL = 5 * 60 * 1000; // 每 5 分鐘重新讀取 JSON

// API fallback 的 pending 追蹤（避免同一 userId 同時多次打 API）
const _pendingLookups = new Set<string>();

function resolveCachePath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "workspace/references/line-profile-cache.json"),
    path.resolve(
      process.env.HOME ?? "/root",
      ".openclaw/workspace/references/line-profile-cache.json",
    ),
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(path.dirname(p));
      return p;
    } catch {
      // 繼續
    }
  }
  return candidates[0]; // fallback 用第一個
}

function loadCache(): ProfileCache {
  const now = Date.now();
  if (_cache && now - _cacheLoadedAt < CACHE_RELOAD_INTERVAL) {
    return _cache;
  }

  const cachePath = resolveCachePath();
  if (cachePath) {
    try {
      const raw = fs.readFileSync(cachePath, "utf-8");
      _cache = JSON.parse(raw) as ProfileCache;
      _cacheLoadedAt = now;
      logVerbose(`line: loaded sender name cache from ${cachePath}`);
      return _cache;
    } catch {
      // 檔案不存在或壞掉
    }
  }

  _cache = {};
  _cacheLoadedAt = now;
  return _cache;
}

/**
 * 將新的 userId → displayName 寫入快取（記憶體 + 檔案）
 */
function writeToCache(userId: string, displayName: string, groupId?: string): void {
  const cache = loadCache();
  const key = groupId ?? "_direct";

  if (!cache[key]) {
    cache[key] = {};
  }
  cache[key][userId] = displayName;

  // 寫回 JSON 檔案（非同步，不阻塞）
  const cachePath = resolveCachePath();
  if (cachePath) {
    try {
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
      logVerbose(`line: wrote ${displayName} (${userId}) to sender name cache`);
    } catch (err) {
      logVerbose(`line: failed to write sender name cache: ${err}`);
    }
  }
}

/**
 * 從本地快取解析 LINE userId → 顯示名稱（同步，零延遲）
 */
export function resolveLineSenderName(userId: string, groupId?: string): string | undefined {
  if (!userId || userId === "unknown") {
    return undefined;
  }

  const cache = loadCache();

  // 1. 群組快取：精確匹配
  if (groupId && cache[groupId]?.[userId]) {
    return cache[groupId][userId];
  }

  // 2. 跨群組掃描
  for (const members of Object.values(cache)) {
    if (members[userId]) {
      return members[userId];
    }
  }

  return undefined;
}

/**
 * 非同步解析：先查快取，cache miss 時打 LINE API，並回寫快取
 * 用於 inbound 流程 — 第一次見到新成員時自動學習
 */
export async function resolveLineSenderNameAsync(
  userId: string,
  groupId: string | undefined,
  opts: {
    getUserProfile?: (userId: string) => Promise<{ displayName: string } | null>;
  },
): Promise<string | undefined> {
  // 1. 先查同步快取
  const cached = resolveLineSenderName(userId, groupId);
  if (cached) {
    return cached;
  }

  // 2. 沒有 API function → 放棄
  if (!opts.getUserProfile) {
    return undefined;
  }

  // 3. 避免重複打 API
  if (_pendingLookups.has(userId)) {
    return undefined;
  }
  _pendingLookups.add(userId);

  try {
    const profile = await opts.getUserProfile(userId);
    if (profile?.displayName) {
      writeToCache(userId, profile.displayName, groupId);
      return profile.displayName;
    }
  } catch (err) {
    logVerbose(`line: API fallback failed for ${userId}: ${err}`);
  } finally {
    _pendingLookups.delete(userId);
  }

  return undefined;
}

/**
 * 取得指定群組的所有成員名稱映射
 */
export function getGroupMembers(groupId: string): Record<string, string> {
  if (!groupId) {
    return {};
  }
  const cache = loadCache();
  return cache[groupId] ?? {};
}
