// Ephemeral connection presence and observed activity, shared by Gateway readers.
import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type { PresenceEntry } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { resolveMachineModelIdentifier } from "./machine-model.js";
import { pickBestEffortPrimaryLanIPv4 } from "./network-discovery-display.js";
import { resolveDarwinProductVersion } from "./os-summary.js";

export type SystemPresence = SchemaContract<Omit<PresenceEntry, "tags" | "text" | "user">> & {
  user?: PresenceEntry["user"];
  text: string;
};

type StoredPresence = {
  presence: SystemPresence;
  pending: boolean;
};

// The gateway owns a private key; caller-supplied string identities remain peers.
const SELF_KEY = Symbol("system-presence-self");
const entries = new Map<string | symbol, StoredPresence>();
const presenceKeys = new WeakMap<SystemPresence, string>();
let nextWireKey = 0;
const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 200;
const SELF_INSTANCE_ID = randomUUID();

function setPresence(
  key: string | symbol,
  presence: SystemPresence,
  pending = entries.get(key)?.pending ?? false,
) {
  // Keys repeat in every delta's order. Keep them short and never reuse an expired row's ID.
  const existing = entries.get(key)?.presence;
  const wireKey = (existing && presenceKeys.get(existing)) ?? (++nextWireKey).toString(36);
  presenceKeys.set(presence, wireKey);
  entries.set(key, { presence, pending });
}

/** Stable owner key without adding fields to legacy presence rows. */
export function getSystemPresenceKey(presence: SystemPresence): string {
  const key = presenceKeys.get(presence);
  if (key === undefined) {
    throw new Error("presence row has no owner key");
  }
  return key;
}

function initSelfPresence() {
  const host = os.hostname();
  const ip = pickBestEffortPrimaryLanIPv4() ?? os.hostname();
  const version = resolveRuntimeServiceVersion(process.env);
  const modelIdentifier = resolveMachineModelIdentifier();
  const osPlatform = os.platform();
  const release = os.release();
  const platform =
    osPlatform === "darwin"
      ? `macos ${resolveDarwinProductVersion()}`
      : `${osPlatform === "win32" ? "windows" : osPlatform} ${release}`;
  const deviceFamilies: Partial<Record<NodeJS.Platform, string>> = {
    darwin: "Mac",
    win32: "Windows",
    linux: "Linux",
  };
  const deviceFamily = deviceFamilies[osPlatform] ?? osPlatform;
  const text = `Gateway: ${host}${ip ? ` (${ip})` : ""} · app ${version} · mode gateway · reason self`;
  const selfEntry: SystemPresence = {
    host,
    ip,
    version,
    platform,
    deviceFamily,
    modelIdentifier,
    mode: "gateway",
    reason: "self",
    instanceId: SELF_INSTANCE_ID,
    text,
    ts: Date.now(),
  };
  setPresence(SELF_KEY, selfEntry);
}

initSelfPresence();

function parsePresence(text: string): SystemPresence {
  const trimmed = text.trim();
  const pattern =
    /Node:\s*([^ (]+)\s*\(([^)]+)\)\s*·\s*app\s*([^·]+?)\s*·\s*last input\s*([0-9]+)s ago\s*·\s*mode\s*([^·]+?)\s*·\s*reason\s*(.+)$/i;
  const match = trimmed.match(pattern);
  if (!match) {
    return { text: trimmed, ts: Date.now() };
  }
  // Every capture is required by the matched pattern above.
  const [, host, ip, version, lastInputStr, mode, reason] = match;
  const lastInputSeconds = Number.parseInt(lastInputStr!, 10);
  return {
    host: host!.trim(),
    ip: ip!.trim(),
    version: version!.trim(),
    lastInputSeconds: Number.isFinite(lastInputSeconds) ? lastInputSeconds : undefined,
    mode: mode!.trim(),
    reason: reason!.trim(),
    text: trimmed,
    ts: Date.now(),
  };
}

type SystemPresencePayload = {
  text: string;
  deviceId?: string;
  instanceId?: string;
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  lastInputSeconds?: number | null;
  mode?: string;
  reason?: string;
  roles?: string[];
  scopes?: string[];
  tags?: string[];
};

function mergeStringList(...values: Array<string[] | undefined>): string[] | undefined {
  const merged = normalizeUniqueTrimmedStringList(values.flat());
  return merged.length > 0 ? merged : undefined;
}

function operatorPresenceIdentity(presence: SystemPresence): string | undefined {
  if (!presence.roles?.includes("operator") || presence.roles.includes("node")) {
    return undefined;
  }
  return (
    normalizeOptionalLowercaseString(presence.deviceId) ??
    normalizeOptionalLowercaseString(presence.instanceId) ??
    normalizeOptionalLowercaseString(presence.connectionId)
  );
}

export function updateSystemPresence(payload: SystemPresencePayload) {
  const parsed = parsePresence(payload.text);
  const key =
    normalizeOptionalLowercaseString(payload.deviceId) ||
    normalizeOptionalLowercaseString(payload.instanceId) ||
    normalizeOptionalLowercaseString(parsed.host) ||
    parsed.ip ||
    truncateUtf16Safe(parsed.text, 64) ||
    normalizeLowercaseStringOrEmpty(os.hostname());
  const existing: Partial<SystemPresence> = entries.get(key)?.presence ?? {};
  const merged: SystemPresence = {
    ...existing,
    ...parsed,
    host: payload.host ?? parsed.host ?? existing.host,
    ip: payload.ip ?? parsed.ip ?? existing.ip,
    version: payload.version ?? parsed.version ?? existing.version,
    platform: payload.platform ?? existing.platform,
    deviceFamily: payload.deviceFamily ?? existing.deviceFamily,
    modelIdentifier: payload.modelIdentifier ?? existing.modelIdentifier,
    mode: payload.mode ?? parsed.mode ?? existing.mode,
    lastInputSeconds:
      payload.lastInputSeconds === null
        ? undefined
        : (payload.lastInputSeconds ?? parsed.lastInputSeconds ?? existing.lastInputSeconds),
    reason: payload.reason ?? parsed.reason ?? existing.reason,
    deviceId: payload.deviceId ?? existing.deviceId,
    roles: mergeStringList(existing.roles, payload.roles),
    scopes: mergeStringList(existing.scopes, payload.scopes),
    instanceId: payload.instanceId ?? existing.instanceId,
    text: payload.text,
    ts: Date.now(),
  };
  setPresence(key, merged);
  const trackKeys = ["host", "ip", "version", "mode", "reason"] as const;
  const changedKeys = trackKeys.filter((field) => existing[field] !== merged[field]);
  return {
    key,
    next: merged,
    changedKeys,
  };
}

export function upsertPresence(
  key: string,
  presence: Partial<SystemPresence>,
  options?: { pending: boolean },
) {
  const normalizedKey =
    normalizeOptionalLowercaseString(key) ?? normalizeLowercaseStringOrEmpty(os.hostname());
  const existing: Partial<SystemPresence> = entries.get(normalizedKey)?.presence ?? {};
  const roles = mergeStringList(existing.roles, presence.roles);
  const scopes = mergeStringList(existing.scopes, presence.scopes);
  const merged: SystemPresence = {
    ...existing,
    ...presence,
    roles,
    scopes,
    ts: Date.now(),
    text:
      presence.text ||
      existing.text ||
      `Node: ${presence.host ?? existing.host ?? "unknown"} · mode ${
        presence.mode ?? existing.mode ?? "unknown"
      }`,
  };
  if (presence.reason === "connect" || presence.reason === "disconnect") {
    const identity = operatorPresenceIdentity(merged);
    if (identity) {
      let hasLivePeer = false;
      // Keep each live tab's facts, but only the last disconnect's offline metadata.
      for (const [peerKey, { presence: peer }] of entries) {
        if (peerKey === normalizedKey || operatorPresenceIdentity(peer) !== identity) {
          continue;
        }
        if (peer.reason === "disconnect") {
          entries.delete(peerKey);
        } else {
          hasLivePeer = true;
        }
      }
      if (presence.reason === "disconnect" && hasLivePeer) {
        entries.delete(normalizedKey);
        return;
      }
    }
  }
  setPresence(normalizedKey, merged, options?.pending);
}

/** Only the connection that staged a row may make it visible to other readers. */
export function commitPresence(key: string, connectionId: string): void {
  const normalizedKey = normalizeOptionalLowercaseString(key);
  const entry = normalizedKey ? entries.get(normalizedKey) : undefined;
  if (entry?.presence.connectionId === connectionId) {
    entry.pending = false;
  }
}

/** Renews an existing connection-owned presence row without recreating expired metadata. */
export function touchPresence(key: string): boolean {
  const normalizedKey = normalizeOptionalLowercaseString(key);
  if (!normalizedKey) {
    return false;
  }
  const existing = entries.get(normalizedKey)?.presence;
  if (!existing) {
    return false;
  }
  setPresence(normalizedKey, { ...existing, ts: Date.now() });
  return true;
}

export function listSystemPresence(options?: { includeConnectionId?: string }): SystemPresence[] {
  // The private self key is initialized once and excluded from every deletion path.
  setPresence(SELF_KEY, { ...entries.get(SELF_KEY)!.presence, ts: Date.now() });
  // Presence is ephemeral; clock corrections use best-effort wall-time expiry.
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (key !== SELF_KEY && now - entry.presence.ts > TTL_MS) {
      entries.delete(key);
    }
  }
  if (entries.size > MAX_ENTRIES) {
    const sorted = [...entries.entries()]
      .filter(([key]) => key !== SELF_KEY)
      .toSorted((a, b) => a[1].presence.ts - b[1].presence.ts);
    const toDrop = entries.size - MAX_ENTRIES;
    for (const [key] of sorted.slice(0, toDrop)) {
      entries.delete(key);
    }
  }
  return [...entries.values()]
    .filter(
      (entry) =>
        !entry.pending ||
        (options?.includeConnectionId !== undefined &&
          entry.presence.connectionId === options.includeConnectionId),
    )
    .map((entry) => entry.presence)
    .toSorted((a, b) => b.ts - a.ts);
}
