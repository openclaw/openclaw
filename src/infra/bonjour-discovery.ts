import { runCommandWithTimeout } from "../process/exec.js";
import { WIDE_AREA_DISCOVERY_DOMAIN } from "./widearea-dns.js";

export type GatewayBonjourBeacon = {
  instanceName: string;
  domain?: string;
  displayName?: string;
  host?: string;
  port?: number;
  lanHost?: string;
  tailnetDns?: string;
  bridgePort?: number;
  gatewayPort?: number;
  sshPort?: number;
  cliPath?: string;
  txt?: Record<string, string>;
};

export type GatewayBonjourDiscoverOpts = {
  timeoutMs?: number;
  domains?: string[];
  platform?: NodeJS.Platform;
  run?: typeof runCommandWithTimeout;
};

const DEFAULT_TIMEOUT_MS = 2000;

const DEFAULT_DOMAINS = ["local.", WIDE_AREA_DISCOVERY_DOMAIN] as const;

function parseIntOrNull(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseTxtTokens(tokens: string[]): Record<string, string> {
  const txt: Record<string, string> = {};
  for (const token of tokens) {
    const idx = token.indexOf("=");
    if (idx <= 0) continue;
    const key = token.slice(0, idx).trim();
    const value = token.slice(idx + 1).trim();
    if (!key) continue;
    txt[key] = value;
  }
  return txt;
}

function parseDnsSdBrowse(stdout: string): string[] {
  const instances = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line || !line.includes("_clawdbot-bridge._tcp")) continue;
    if (!line.includes("Add")) continue;
    const match = line.match(/_clawdbot-bridge\._tcp\.?\s+(.+)$/);
    if (match?.[1]) {
      instances.add(match[1].trim());
    }
  }
  return Array.from(instances.values());
}

function parseDnsSdResolve(
  stdout: string,
  instanceName: string,
): GatewayBonjourBeacon | null {
  const beacon: GatewayBonjourBeacon = { instanceName };
  let txt: Record<string, string> = {};
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    if (line.includes("can be reached at")) {
      const match = line.match(/can be reached at\s+([^\s:]+):(\d+)/i);
      if (match?.[1]) {
        beacon.host = match[1].replace(/\.$/, "");
      }
      if (match?.[2]) {
        beacon.port = parseIntOrNull(match[2]);
      }
      continue;
    }

    if (line.startsWith("txt") || line.includes("txtvers=")) {
      const tokens = line.split(/\s+/).filter(Boolean);
      txt = parseTxtTokens(tokens);
    }
  }

  beacon.txt = Object.keys(txt).length ? txt : undefined;
  if (txt.displayName) beacon.displayName = txt.displayName;
  if (txt.lanHost) beacon.lanHost = txt.lanHost;
  if (txt.tailnetDns) beacon.tailnetDns = txt.tailnetDns;
  if (txt.cliPath) beacon.cliPath = txt.cliPath;
  beacon.bridgePort = parseIntOrNull(txt.bridgePort);
  beacon.gatewayPort = parseIntOrNull(txt.gatewayPort);
  beacon.sshPort = parseIntOrNull(txt.sshPort);

  if (!beacon.displayName) beacon.displayName = instanceName;
  return beacon;
}

async function discoverViaDnsSd(
  domain: string,
  timeoutMs: number,
  run: typeof runCommandWithTimeout,
): Promise<GatewayBonjourBeacon[]> {
  const browse = await run(["dns-sd", "-B", "_clawdbot-bridge._tcp", domain], {
    timeoutMs,
  });
  const instances = parseDnsSdBrowse(browse.stdout);
  const results: GatewayBonjourBeacon[] = [];
  for (const instance of instances) {
    const resolved = await run(
      ["dns-sd", "-L", instance, "_clawdbot-bridge._tcp", domain],
      { timeoutMs },
    );
    const parsed = parseDnsSdResolve(resolved.stdout, instance);
    if (parsed) results.push({ ...parsed, domain });
  }
  return results;
}

function parseAvahiBrowse(stdout: string): GatewayBonjourBeacon[] {
  const results: GatewayBonjourBeacon[] = [];
  let current: GatewayBonjourBeacon | null = null;

  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith("=") && line.includes("_clawdbot-bridge._tcp")) {
      if (current) results.push(current);
      const marker = " _clawdbot-bridge._tcp";
      const idx = line.indexOf(marker);
      const left = idx >= 0 ? line.slice(0, idx).trim() : line;
      const parts = left.split(/\s+/);
      const instanceName = parts.length > 3 ? parts.slice(3).join(" ") : left;
      current = {
        instanceName,
        displayName: instanceName,
      };
      continue;
    }

    if (!current) continue;

    const trimmed = line.trim();
    if (trimmed.startsWith("hostname =")) {
      const match = trimmed.match(/hostname\s*=\s*\[([^\]]+)\]/);
      if (match?.[1]) current.host = match[1];
      continue;
    }

    if (trimmed.startsWith("port =")) {
      const match = trimmed.match(/port\s*=\s*\[(\d+)\]/);
      if (match?.[1]) current.port = parseIntOrNull(match[1]);
      continue;
    }

    if (trimmed.startsWith("txt =")) {
      const tokens = Array.from(trimmed.matchAll(/"([^"]*)"/g), (m) => m[1]);
      const txt = parseTxtTokens(tokens);
      current.txt = Object.keys(txt).length ? txt : undefined;
      if (txt.displayName) current.displayName = txt.displayName;
      if (txt.lanHost) current.lanHost = txt.lanHost;
      if (txt.tailnetDns) current.tailnetDns = txt.tailnetDns;
      if (txt.cliPath) current.cliPath = txt.cliPath;
      current.bridgePort = parseIntOrNull(txt.bridgePort);
      current.gatewayPort = parseIntOrNull(txt.gatewayPort);
      current.sshPort = parseIntOrNull(txt.sshPort);
    }
  }

  if (current) results.push(current);
  return results;
}

async function discoverViaAvahi(
  domain: string,
  timeoutMs: number,
  run: typeof runCommandWithTimeout,
): Promise<GatewayBonjourBeacon[]> {
  const args = ["avahi-browse", "-rt", "_clawdbot-bridge._tcp"];
  if (domain && domain !== "local.") {
    // avahi-browse wants a plain domain (no trailing dot)
    args.push("-d", domain.replace(/\.$/, ""));
  }
  const browse = await run(args, { timeoutMs });
  return parseAvahiBrowse(browse.stdout).map((beacon) => ({
    ...beacon,
    domain,
  }));
}

export async function discoverGatewayBeacons(
  opts: GatewayBonjourDiscoverOpts = {},
): Promise<GatewayBonjourBeacon[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? runCommandWithTimeout;
  const domainsRaw = Array.isArray(opts.domains) ? opts.domains : [];
  const domains = (domainsRaw.length > 0 ? domainsRaw : [...DEFAULT_DOMAINS])
    .map((d) => String(d).trim())
    .filter(Boolean)
    .map((d) => (d.endsWith(".") ? d : `${d}.`));

  try {
    if (platform === "darwin") {
      const perDomain = await Promise.allSettled(
        domains.map(
          async (domain) => await discoverViaDnsSd(domain, timeoutMs, run),
        ),
      );
      return perDomain.flatMap((r) =>
        r.status === "fulfilled" ? r.value : [],
      );
    }
    if (platform === "linux") {
      const perDomain = await Promise.allSettled(
        domains.map(
          async (domain) => await discoverViaAvahi(domain, timeoutMs, run),
        ),
      );
      return perDomain.flatMap((r) =>
        r.status === "fulfilled" ? r.value : [],
      );
    }
  } catch {
    return [];
  }
  return [];
}
