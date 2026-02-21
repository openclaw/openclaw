/**
 * Dynamic agent bindings — runtime per-chat agent overrides.
 *
 * Persists a simple `channel:peerId → agentId` map so users can
 * switch agents on the fly via `/agent <id>` without touching config.
 *
 * Storage: `<stateDir>/agent-overrides.json`
 */

import fs from "node:fs";
import path from "node:path";
import { logDebug } from "../logger.js";

/** In-memory cache of the overrides map. */
let cache: Map<string, string> | null = null;
let cacheFilePath: string | null = null;

function resolveFilePath(): string {
  if (cacheFilePath) {
    return cacheFilePath;
  }
  const stateDir =
    process.env.OPENCLAW_STATE_DIR ||
    path.join(process.env.HOME || "/root", ".openclaw", "state");
  cacheFilePath = path.join(stateDir, "agent-overrides.json");
  return cacheFilePath;
}

function buildKey(channel: string, peerId: string): string {
  return `${channel.toLowerCase().trim()}:${peerId.trim()}`;
}

function loadOverrides(): Map<string, string> {
  if (cache) {
    return cache;
  }
  const filePath = resolveFilePath();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    cache = new Map(Object.entries(parsed));
  } catch {
    cache = new Map();
  }
  return cache;
}

function saveOverrides(map: Map<string, string>): void {
  const filePath = resolveFilePath();
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(map);
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf-8");
  } catch (err) {
    logDebug(`[dynamic-bindings] failed to save: ${String(err)}`);
  }
}

/**
 * Get the dynamic agent override for a given channel + peer.
 * Returns the agentId if an override exists, or null otherwise.
 */
export function getDynamicAgentOverride(channel: string, peerId: string): string | null {
  const map = loadOverrides();
  const key = buildKey(channel, peerId);
  return map.get(key) ?? null;
}

/**
 * Set a dynamic agent override for a given channel + peer.
 */
export function setDynamicAgentOverride(
  channel: string,
  peerId: string,
  agentId: string,
): void {
  const map = loadOverrides();
  const key = buildKey(channel, peerId);
  map.set(key, agentId.trim());
  saveOverrides(map);
  logDebug(`[dynamic-bindings] set ${key} → ${agentId}`);
}

/**
 * Clear the dynamic agent override for a given channel + peer,
 * reverting to the default routing.
 */
export function clearDynamicAgentOverride(channel: string, peerId: string): void {
  const map = loadOverrides();
  const key = buildKey(channel, peerId);
  if (map.delete(key)) {
    saveOverrides(map);
    logDebug(`[dynamic-bindings] cleared ${key}`);
  }
}

/**
 * Get the current override for a channel + peer, or null.
 * Alias for getDynamicAgentOverride (used in command handler).
 */
export function getCurrentDynamicAgent(channel: string, peerId: string): string | null {
  return getDynamicAgentOverride(channel, peerId);
}

/**
 * Invalidate the in-memory cache (e.g. after config reload).
 */
export function invalidateDynamicBindingsCache(): void {
  cache = null;
}
