import { resolveBrowserConfig } from "../browser/config.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { GatewayClient } from "../gateway/client.js";
import { resolveGatewayConnectionAuth } from "../gateway/connection-auth.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import type { SkillBinTrustEntry } from "../infra/exec-approvals.js";
import { resolveExecutableFromPathEnv } from "../infra/executable-path.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import {
  NODE_BROWSER_PROXY_COMMAND,
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_SYSTEM_RUN_COMMANDS,
} from "../infra/node-commands.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { VERSION } from "../version.js";
import { ensureNodeHostConfig, saveNodeHostConfig, type NodeHostGatewayConfig } from "./config.js";
import {
  coerceNodeInvokePayload,
  handleInvoke,
  type SkillBinsProvider,
  buildNodeInvokeResultParams,
} from "./invoke.js";

export { buildNodeInvokeResultParams };

type NodeHostRunOptions = {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls?: boolean;
  gatewayTlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
  /** HTTP headers for WebSocket upgrade (e.g. Cloudflare Zero Trust). */
  headers?: Record<string, string>;
};

const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function resolveExecutablePathFromEnv(bin: string, pathEnv: string): string | null {
  if (bin.includes("/") || bin.includes("\\")) {
    return null;
  }
  return resolveExecutableFromPathEnv(bin, pathEnv) ?? null;
}

function resolveSkillBinTrustEntries(bins: string[], pathEnv: string): SkillBinTrustEntry[] {
  const trustEntries: SkillBinTrustEntry[] = [];
  const seen = new Set<string>();
  for (const bin of bins) {
    const name = bin.trim();
    if (!name) {
      continue;
    }
    const resolvedPath = resolveExecutablePathFromEnv(name, pathEnv);
    if (!resolvedPath) {
      continue;
    }
    const key = `${name}\u0000${resolvedPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    trustEntries.push({ name, resolvedPath });
  }
  return trustEntries.toSorted(
    (left, right) =>
      left.name.localeCompare(right.name) || left.resolvedPath.localeCompare(right.resolvedPath),
  );
}

class SkillBinsCache implements SkillBinsProvider {
  private bins: SkillBinTrustEntry[] = [];
  private lastRefresh = 0;
  private readonly ttlMs = 90_000;
  private readonly fetch: () => Promise<string[]>;
  private readonly pathEnv: string;

  constructor(fetch: () => Promise<string[]>, pathEnv: string) {
    this.fetch = fetch;
    this.pathEnv = pathEnv;
  }

  async current(force = false): Promise<SkillBinTrustEntry[]> {
    if (force || Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
    return this.bins;
  }

  private async refresh() {
    try {
      const bins = await this.fetch();
      this.bins = resolveSkillBinTrustEntries(bins, this.pathEnv);
      this.lastRefresh = Date.now();
    } catch {
      if (!this.lastRefresh) {
        this.bins = [];
      }
    }
  }
}

function ensureNodePathEnv(): string {
  ensureOpenClawCliOnPath({ pathEnv: process.env.PATH ?? "" });
  const current = process.env.PATH ?? "";
  if (current.trim()) {
    return current;
  }
  process.env.PATH = DEFAULT_NODE_PATH;
  return DEFAULT_NODE_PATH;
}

export async function resolveNodeHostGatewayCredentials(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ token?: string; password?: string }> {
  const mode = params.config.gateway?.mode === "remote" ? "remote" : "local";
  const configForResolution =
    mode === "local" ? buildNodeHostLocalAuthConfig(params.config) : params.config;
  return await resolveGatewayConnectionAuth({
    config: configForResolution,
    env: params.env,
    includeLegacyEnv: false,
    localTokenPrecedence: "env-first",
    localPasswordPrecedence: "env-first", // pragma: allowlist secret
    remoteTokenPrecedence: "env-first",
    remotePasswordPrecedence: "env-first", // pragma: allowlist secret
  });
}

function buildNodeHostLocalAuthConfig(config: OpenClawConfig): OpenClawConfig {
  if (!config.gateway?.remote?.token && !config.gateway?.remote?.password) {
    return config;
  }
  const nextConfig = structuredClone(config);
  if (nextConfig.gateway?.remote) {
    // Local node-host must not inherit gateway.remote.* auth material, which can
    // suppress GatewayClient device-token fallback and cause local token mismatches.
    nextConfig.gateway.remote.token = undefined;
    nextConfig.gateway.remote.password = undefined;
  }
  return nextConfig;
}

/** Merge headers from config, opts, and env. Precedence: config < opts < OPENCLAW_NODE_HEADERS; CF_* env only applied when that header key is not already set (so explicit --header wins). */
function resolveNodeHostHeaders(params: {
  configHeaders?: Record<string, string>;
  optsHeaders?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const env = params.env ?? process.env;
  const out: Record<string, string> = { ...params.configHeaders };
  if (params.optsHeaders) {
    for (const [k, v] of Object.entries(params.optsHeaders)) {
      out[k] = v;
    }
  }
  const openclawHeaders = env.OPENCLAW_NODE_HEADERS?.trim();
  if (openclawHeaders) {
    try {
      const parsed = JSON.parse(openclawHeaders) as Record<string, string>;
      if (typeof parsed === "object" && parsed !== null) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof k === "string" && typeof v === "string") {
            out[k] = v;
          }
        }
      }
    } catch (e) {
      console.warn(
        `[openclaw] Warning: OPENCLAW_NODE_HEADERS contains invalid JSON and was ignored: ${String(e)}`,
      );
    }
  }
  const cfId = env.CF_ACCESS_CLIENT_ID?.trim();
  const cfSecret = env.CF_ACCESS_CLIENT_SECRET?.trim();
  if (cfId && out["CF-Access-Client-Id"] === undefined) {
    out["CF-Access-Client-Id"] = cfId;
  }
  if (cfSecret && out["CF-Access-Client-Secret"] === undefined) {
    out["CF-Access-Client-Secret"] = cfSecret;
  }
  return out;
}

export async function runNodeHost(opts: NodeHostRunOptions): Promise<void> {
  const config = await ensureNodeHostConfig();
  const nodeId = opts.nodeId?.trim() || config.nodeId;
  if (nodeId !== config.nodeId) {
    config.nodeId = nodeId;
  }
  const displayName =
    opts.displayName?.trim() || config.displayName || (await getMachineDisplayName());
  config.displayName = displayName;

  const resolvedHeaders = resolveNodeHostHeaders({
    configHeaders: config.gateway?.headers,
    optsHeaders: opts.headers,
    env: process.env,
  });
  const gateway: NodeHostGatewayConfig = {
    host: opts.gatewayHost,
    port: opts.gatewayPort,
    tls: opts.gatewayTls ?? loadConfig().gateway?.tls?.enabled ?? false,
    tlsFingerprint: opts.gatewayTlsFingerprint,
    headers:
      Object.keys(resolvedHeaders).length > 0
        ? resolvedHeaders
        : opts.headers !== undefined
          ? opts.headers
          : config.gateway?.headers,
  };
  config.gateway = gateway;
  await saveNodeHostConfig(config);

  const headers = resolvedHeaders;

  const cfg = loadConfig();
  const resolvedBrowser = resolveBrowserConfig(cfg.browser, cfg);
  const browserProxyEnabled =
    cfg.nodeHost?.browserProxy?.enabled !== false && resolvedBrowser.enabled;
  const { token, password } = await resolveNodeHostGatewayCredentials({
    config: cfg,
    env: process.env,
  });

  const host = gateway.host ?? "127.0.0.1";
  const port = gateway.port ?? 18789;
  const scheme = gateway.tls ? "wss" : "ws";
  const url = `${scheme}://${host}:${port}`;
  const pathEnv = ensureNodePathEnv();
  // eslint-disable-next-line no-console
  console.log(`node host PATH: ${pathEnv}`);

  const client = new GatewayClient({
    url,
    token: token || undefined,
    password: password || undefined,
    instanceId: nodeId,
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: displayName,
    clientVersion: VERSION,
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.NODE,
    role: "node",
    scopes: [],
    caps: ["system", ...(browserProxyEnabled ? ["browser"] : [])],
    commands: [
      ...NODE_SYSTEM_RUN_COMMANDS,
      ...NODE_EXEC_APPROVALS_COMMANDS,
      ...(browserProxyEnabled ? [NODE_BROWSER_PROXY_COMMAND] : []),
    ],
    pathEnv,
    permissions: undefined,
    deviceIdentity: loadOrCreateDeviceIdentity(),
    tlsFingerprint: gateway.tlsFingerprint,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    onEvent: (evt) => {
      if (evt.event !== "node.invoke.request") {
        return;
      }
      const payload = coerceNodeInvokePayload(evt.payload);
      if (!payload) {
        return;
      }
      void handleInvoke(payload, client, skillBins);
    },
    onConnectError: (err) => {
      // keep retrying (handled by GatewayClient)
      // eslint-disable-next-line no-console
      console.error(`node host gateway connect failed: ${err.message}`);
    },
    onClose: (code, reason) => {
      // eslint-disable-next-line no-console
      console.error(`node host gateway closed (${code}): ${reason}`);
    },
  });

  const skillBins = new SkillBinsCache(async () => {
    const res = await client.request<{ bins: Array<unknown> }>("skills.bins", {});
    const bins = Array.isArray(res?.bins) ? res.bins.map((bin) => String(bin)) : [];
    return bins;
  }, pathEnv);

  client.start();
  await new Promise(() => {});
}
