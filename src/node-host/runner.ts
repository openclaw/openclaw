import { resolveBrowserConfig } from "../browser/config.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { normalizeSecretInputString, resolveSecretInputRef } from "../config/types.secrets.js";
import { GatewayClient } from "../gateway/client.js";
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
import { secretRefKey } from "../secrets/ref-contract.js";
import { resolveSecretRefValues } from "../secrets/resolve.js";
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

async function resolveNodeHostSecretInputString(params: {
  config: OpenClawConfig;
  value: unknown;
  path: string;
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const defaults = params.config.secrets?.defaults;
  const { ref } = resolveSecretInputRef({
    value: params.value,
    defaults,
  });
  if (!ref) {
    return normalizeSecretInputString(params.value);
  }
  let resolved: Map<string, unknown>;
  try {
    resolved = await resolveSecretRefValues([ref], {
      config: params.config,
      env: params.env,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${params.path} secret reference could not be resolved: ${detail}`, {
      cause: error,
    });
  }
  const resolvedValue = normalizeSecretInputString(resolved.get(secretRefKey(ref)));
  if (!resolvedValue) {
    throw new Error(`${params.path} resolved to an empty or non-string value.`);
  }
  return resolvedValue;
}

export async function resolveNodeHostGatewayCredentials(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ token?: string; password?: string }> {
  const env = params.env ?? process.env;
  const isRemoteMode = params.config.gateway?.mode === "remote";
  const authMode = params.config.gateway?.auth?.mode;
  const tokenPath = isRemoteMode ? "gateway.remote.token" : "gateway.auth.token";
  const passwordPath = isRemoteMode ? "gateway.remote.password" : "gateway.auth.password";
  const configuredToken = isRemoteMode
    ? params.config.gateway?.remote?.token
    : params.config.gateway?.auth?.token;
  const configuredPassword = isRemoteMode
    ? params.config.gateway?.remote?.password
    : params.config.gateway?.auth?.password;

  const token =
    normalizeSecretInputString(env.OPENCLAW_GATEWAY_TOKEN) ??
    (await resolveNodeHostSecretInputString({
      config: params.config,
      value: configuredToken,
      path: tokenPath,
      env,
    }));
  const tokenCanWin = Boolean(token);
  const localPasswordCanWin =
    authMode === "password" ||
    (authMode !== "token" && authMode !== "none" && authMode !== "trusted-proxy" && !tokenCanWin);
  const shouldResolveConfiguredPassword =
    !normalizeSecretInputString(env.OPENCLAW_GATEWAY_PASSWORD) &&
    !tokenCanWin &&
    (isRemoteMode || localPasswordCanWin);
  const password =
    normalizeSecretInputString(env.OPENCLAW_GATEWAY_PASSWORD) ??
    (shouldResolveConfiguredPassword
      ? await resolveNodeHostSecretInputString({
          config: params.config,
          value: configuredPassword,
          path: passwordPath,
          env,
        })
      : normalizeSecretInputString(configuredPassword));

  return { token, password };
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

  const gateway: NodeHostGatewayConfig = {
    host: opts.gatewayHost,
    port: opts.gatewayPort,
    tls: opts.gatewayTls ?? loadConfig().gateway?.tls?.enabled ?? false,
    tlsFingerprint: opts.gatewayTlsFingerprint,
  };
  config.gateway = gateway;
  await saveNodeHostConfig(config);

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
