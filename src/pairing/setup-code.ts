import os from "node:os";
import type { OpenClawConfig } from "../config/types.js";

const DEFAULT_GATEWAY_PORT = 18789;

export type PairingSetupPayload = {
  url: string;
  token?: string;
  password?: string;
};

export type PairingSetupCommandResult = {
  code: number | null;
  stdout: string;
  stderr?: string;
};

export type PairingSetupCommandRunner = (
  argv: string[],
  opts: { timeoutMs: number },
) => Promise<PairingSetupCommandResult>;

export type ResolvePairingSetupOptions = {
  env?: NodeJS.ProcessEnv;
  publicUrl?: string;
  preferRemoteUrl?: boolean;
  forceSecure?: boolean;
  runCommandWithTimeout?: PairingSetupCommandRunner;
  networkInterfaces?: () => ReturnType<typeof os.networkInterfaces>;
};

export type PairingSetupResolution =
  | {
      ok: true;
      payload: PairingSetupPayload;
      authLabel: "token" | "password";
      urlSource: string;
    }
  | {
      ok: false;
      error: string;
    };

type ResolveUrlResult = {
  url?: string;
  source?: string;
  error?: string;
};

type ResolveAuthResult = {
  token?: string;
  password?: string;
  label?: "token" | "password";
  error?: string;
};

function normalizeUrl(raw: string, schemeFallback: "ws" | "wss"): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    const scheme = parsed.protocol.replace(":", "");
    if (!scheme) {
      return null;
    }
    const resolvedScheme = scheme === "http" ? "ws" : scheme === "https" ? "wss" : scheme;
    if (resolvedScheme !== "ws" && resolvedScheme !== "wss") {
      return null;
    }
    const host = parsed.hostname;
    if (!host) {
      return null;
    }
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${resolvedScheme}://${host}${port}`;
  } catch {
    // Fall through to host:port parsing.
  }

  const withoutPath = trimmed.split("/")[0] ?? "";
  if (!withoutPath) {
    return null;
  }
  return `${schemeFallback}://${withoutPath}`;
}

function resolveGatewayPort(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): number {
  const envRaw = env.OPENCLAW_GATEWAY_PORT?.trim() || env.CLAWDBOT_GATEWAY_PORT?.trim();
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const configPort = cfg.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort) && configPort > 0) {
    return configPort;
  }
  return DEFAULT_GATEWAY_PORT;
}

function resolveScheme(
  cfg: OpenClawConfig,
  opts?: {
    forceSecure?: boolean;
  },
): "ws" | "wss" {
  if (opts?.forceSecure) {
    return "wss";
  }
  return cfg.gateway?.tls?.enabled === true ? "wss" : "ws";
}

function parseIPv4Octets(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) {
    return null;
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

function isPrivateIPv4(address: string): boolean {
  const octets = parseIPv4Octets(address);
  if (!octets) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  return false;
}

function isTailnetIPv4(address: string): boolean {
  const octets = parseIPv4Octets(address);
  if (!octets) {
    return false;
  }
  const [a, b] = octets;
  return a === 100 && b >= 64 && b <= 127;
}

function pickIPv4Matching(
  networkInterfaces: () => ReturnType<typeof os.networkInterfaces>,
  matches: (address: string) => boolean,
): string | null {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      const family = entry?.family;
      const isIpv4 = family === "IPv4";
      if (!entry || entry.internal || !isIpv4) {
        continue;
      }
      const address = entry.address?.trim() ?? "";
      if (!address) {
        continue;
      }
      if (matches(address)) {
        return address;
      }
    }
  }
  return null;
}

function pickLanIPv4(
  networkInterfaces: () => ReturnType<typeof os.networkInterfaces>,
): string | null {
  return pickIPv4Matching(networkInterfaces, isPrivateIPv4);
}

function pickTailnetIPv4(
  networkInterfaces: () => ReturnType<typeof os.networkInterfaces>,
): string | null {
  return pickIPv4Matching(networkInterfaces, isTailnetIPv4);
}

function parsePossiblyNoisyJsonObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return {};
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function resolveTailnetHost(
  runCommandWithTimeout?: PairingSetupCommandRunner,
): Promise<string | null> {
  if (!runCommandWithTimeout) {
    return null;
  }
  const candidates = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  for (const candidate of candidates) {
    try {
      const result = await runCommandWithTimeout([candidate, "status", "--json"], {
        timeoutMs: 5000,
      });
      if (result.code !== 0) {
        continue;
      }
      const raw = result.stdout.trim();
      if (!raw) {
        continue;
      }
      const parsed = parsePossiblyNoisyJsonObject(raw);
      const self =
        typeof parsed.Self === "object" && parsed.Self !== null
          ? (parsed.Self as Record<string, unknown>)
          : undefined;
      const dns = typeof self?.DNSName === "string" ? self.DNSName : undefined;
      if (dns && dns.length > 0) {
        return dns.replace(/\.$/, "");
      }
      const ips = Array.isArray(self?.TailscaleIPs) ? (self.TailscaleIPs as string[]) : [];
      if (ips.length > 0) {
        return ips[0] ?? null;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function resolveAuth(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): ResolveAuthResult {
  const mode = cfg.gateway?.auth?.mode;
  const token =
    env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    env.CLAWDBOT_GATEWAY_TOKEN?.trim() ||
    cfg.gateway?.auth?.token?.trim();
  const password =
    env.OPENCLAW_GATEWAY_PASSWORD?.trim() ||
    env.CLAWDBOT_GATEWAY_PASSWORD?.trim() ||
    cfg.gateway?.auth?.password?.trim();

  if (mode === "password") {
    if (!password) {
      return { error: "Gateway auth is set to password, but no password is configured." };
    }
    return { password, label: "password" };
  }
  if (mode === "token") {
    if (!token) {
      return { error: "Gateway auth is set to token, but no token is configured." };
    }
    return { token, label: "token" };
  }
  if (token) {
    return { token, label: "token" };
  }
  if (password) {
    return { password, label: "password" };
  }
  return { error: "Gateway auth is not configured (no token or password)." };
}

async function resolveGatewayUrl(
  cfg: OpenClawConfig,
  opts: {
    env: NodeJS.ProcessEnv;
    publicUrl?: string;
    preferRemoteUrl?: boolean;
    forceSecure?: boolean;
    runCommandWithTimeout?: PairingSetupCommandRunner;
    networkInterfaces: () => ReturnType<typeof os.networkInterfaces>;
  },
): Promise<ResolveUrlResult> {
  const scheme = resolveScheme(cfg, { forceSecure: opts.forceSecure });
  const port = resolveGatewayPort(cfg, opts.env);

  if (typeof opts.publicUrl === "string" && opts.publicUrl.trim()) {
    const url = normalizeUrl(opts.publicUrl, scheme);
    if (url) {
      return { url, source: "plugins.entries.device-pair.config.publicUrl" };
    }
    return { error: "Configured publicUrl is invalid." };
  }

  const remoteUrlRaw = cfg.gateway?.remote?.url;
  const remoteUrl =
    typeof remoteUrlRaw === "string" && remoteUrlRaw.trim()
      ? normalizeUrl(remoteUrlRaw, scheme)
      : null;
  if (opts.preferRemoteUrl && remoteUrl) {
    return { url: remoteUrl, source: "gateway.remote.url" };
  }

  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode === "serve" || tailscaleMode === "funnel") {
    const host = await resolveTailnetHost(opts.runCommandWithTimeout);
    if (!host) {
      return { error: "Tailscale Serve is enabled, but MagicDNS could not be resolved." };
    }
    return { url: `wss://${host}`, source: `gateway.tailscale.mode=${tailscaleMode}` };
  }

  if (remoteUrl) {
    return { url: remoteUrl, source: "gateway.remote.url" };
  }

  const bind = cfg.gateway?.bind ?? "loopback";
  if (bind === "custom") {
    const host = cfg.gateway?.customBindHost?.trim();
    if (host) {
      return { url: `${scheme}://${host}:${port}`, source: "gateway.bind=custom" };
    }
    return { error: "gateway.bind=custom requires gateway.customBindHost." };
  }

  if (bind === "tailnet") {
    const host = pickTailnetIPv4(opts.networkInterfaces);
    if (host) {
      return { url: `${scheme}://${host}:${port}`, source: "gateway.bind=tailnet" };
    }
    return { error: "gateway.bind=tailnet set, but no tailnet IP was found." };
  }

  if (bind === "lan") {
    const host = pickLanIPv4(opts.networkInterfaces);
    if (host) {
      return { url: `${scheme}://${host}:${port}`, source: "gateway.bind=lan" };
    }
    return { error: "gateway.bind=lan set, but no private LAN IP was found." };
  }

  return {
    error:
      "Gateway is only bound to loopback. Set gateway.bind=lan, enable tailscale serve, or configure plugins.entries.device-pair.config.publicUrl.",
  };
}

export function encodePairingSetupCode(payload: PairingSetupPayload): string {
  const json = JSON.stringify(payload);
  const base64 = Buffer.from(json, "utf8").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function resolvePairingSetupFromConfig(
  cfg: OpenClawConfig,
  options: ResolvePairingSetupOptions = {},
): Promise<PairingSetupResolution> {
  const env = options.env ?? process.env;
  const auth = resolveAuth(cfg, env);
  if (auth.error) {
    return { ok: false, error: auth.error };
  }

  const urlResult = await resolveGatewayUrl(cfg, {
    env,
    publicUrl: options.publicUrl,
    preferRemoteUrl: options.preferRemoteUrl,
    forceSecure: options.forceSecure,
    runCommandWithTimeout: options.runCommandWithTimeout,
    networkInterfaces: options.networkInterfaces ?? os.networkInterfaces,
  });

  if (!urlResult.url) {
    return { ok: false, error: urlResult.error ?? "Gateway URL unavailable." };
  }

  if (!auth.label) {
    return { ok: false, error: "Gateway auth is not configured (no token or password)." };
  }

  return {
    ok: true,
    payload: {
      url: urlResult.url,
      token: auth.token,
      password: auth.password,
    },
    authLabel: auth.label,
    urlSource: urlResult.source ?? "unknown",
  };
}
