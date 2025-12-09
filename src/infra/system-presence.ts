import os from "node:os";

export type SystemPresence = {
  host?: string;
  ip?: string;
  version?: string;
  lastInputSeconds?: number;
  mode?: string;
  reason?: string;
  instanceId?: string;
  text: string;
  ts: number;
};

const entries = new Map<string, SystemPresence>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 200;

function resolvePrimaryIPv4(): string | undefined {
  const nets = os.networkInterfaces();
  const prefer = ["en0", "eth0"];
  const pick = (names: string[]) => {
    for (const name of names) {
      const list = nets[name];
      const entry = list?.find((n) => n.family === "IPv4" && !n.internal);
      if (entry?.address) return entry.address;
    }
    for (const list of Object.values(nets)) {
      const entry = list?.find((n) => n.family === "IPv4" && !n.internal);
      if (entry?.address) return entry.address;
    }
    return undefined;
  };
  return pick(prefer) ?? os.hostname();
}

function initSelfPresence() {
  const host = os.hostname();
  const ip = resolvePrimaryIPv4() ?? undefined;
  const version =
    process.env.CLAWDIS_VERSION ?? process.env.npm_package_version ?? "unknown";
  const text = `Gateway: ${host}${ip ? ` (${ip})` : ""} · app ${version} · mode gateway · reason self`;
  const selfEntry: SystemPresence = {
    host,
    ip,
    version,
    mode: "gateway",
    reason: "self",
    text,
    ts: Date.now(),
  };
  const key = host.toLowerCase();
  entries.set(key, selfEntry);
}

function ensureSelfPresence() {
  // If the map was somehow cleared (e.g., hot reload or a new worker spawn that
  // skipped module evaluation), re-seed with a local entry so UIs always show
  // at least the current relay.
  if (entries.size === 0) {
    initSelfPresence();
  }
}

function touchSelfPresence() {
  const host = os.hostname();
  const key = host.toLowerCase();
  const existing = entries.get(key);
  if (existing) {
    entries.set(key, { ...existing, ts: Date.now() });
  } else {
    initSelfPresence();
  }
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
  const [, host, ip, version, lastInputStr, mode, reasonRaw] = match;
  const lastInputSeconds = Number.parseInt(lastInputStr, 10);
  const reason = reasonRaw.trim();
  return {
    host: host.trim(),
    ip: ip.trim(),
    version: version.trim(),
    lastInputSeconds: Number.isFinite(lastInputSeconds)
      ? lastInputSeconds
      : undefined,
    mode: mode.trim(),
    reason,
    text: trimmed,
    ts: Date.now(),
  };
}

export function updateSystemPresence(text: string) {
  ensureSelfPresence();
  const parsed = parsePresence(text);
  const key =
    parsed.host?.toLowerCase() || parsed.ip || parsed.text.slice(0, 64);
  entries.set(key, parsed);
}

export function upsertPresence(
  key: string,
  presence: Partial<SystemPresence>,
) {
  ensureSelfPresence();
  const existing = entries.get(key) ?? ({} as SystemPresence);
  const merged: SystemPresence = {
    ...existing,
    ...presence,
    ts: Date.now(),
    text:
      presence.text ||
      existing.text ||
      `Node: ${presence.host ?? existing.host ?? "unknown"} · mode ${
        presence.mode ?? existing.mode ?? "unknown"
      }`,
  };
  entries.set(key, merged);
}

export function listSystemPresence(): SystemPresence[] {
  ensureSelfPresence();
  // prune expired
  const now = Date.now();
  for (const [k, v] of [...entries]) {
    if (now - v.ts > TTL_MS) entries.delete(k);
  }
  // enforce max size (LRU by ts)
  if (entries.size > MAX_ENTRIES) {
    const sorted = [...entries.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toDrop = entries.size - MAX_ENTRIES;
    for (let i = 0; i < toDrop; i++) {
      entries.delete(sorted[i][0]);
    }
  }
  touchSelfPresence();
  return [...entries.values()].sort((a, b) => b.ts - a.ts);
}
