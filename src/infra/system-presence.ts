import os from "node:os";

export type SystemPresence = {
  host?: string;
  ip?: string;
  version?: string;
  lastInputSeconds?: number;
  mode?: string;
  reason?: string;
  text: string;
  ts: number;
};

const entries = new Map<string, SystemPresence>();

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
  const text = `Relay: ${host}${ip ? ` (${ip})` : ""} · app ${version} · mode relay · reason self`;
  const selfEntry: SystemPresence = {
    host,
    ip,
    version,
    mode: "relay",
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

export function listSystemPresence(): SystemPresence[] {
  ensureSelfPresence();
  touchSelfPresence();
  return [...entries.values()].sort((a, b) => b.ts - a.ts);
}
