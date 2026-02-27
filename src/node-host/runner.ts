import { resolveBrowserConfig } from "../browser/config.js";
import { loadConfig } from "../config/config.js";
import { GatewayClient } from "../gateway/client.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { ensureBotCliOnPath } from "../infra/path-env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { VERSION } from "../version.js";
import { ensureNodeHostConfig, saveNodeHostConfig, type NodeHostGatewayConfig } from "./config.js";
import { IdleDetector } from "./idle-detector.js";
import {
  coerceNodeInvokePayload,
  handleInvoke,
  type SkillBinsProvider,
  buildNodeInvokeResultParams,
} from "./invoke.js";

export { buildNodeInvokeResultParams };

type NodeHostRunOptions = {
  gatewayHost?: string;
  gatewayPort: number;
  gatewayTls?: boolean;
  gatewayTlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
};

const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

class SkillBinsCache implements SkillBinsProvider {
  private bins = new Set<string>();
  private lastRefresh = 0;
  private readonly ttlMs = 90_000;
  private readonly fetch: () => Promise<string[]>;

  constructor(fetch: () => Promise<string[]>) {
    this.fetch = fetch;
  }

  async current(force = false): Promise<Set<string>> {
    if (force || Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
    return this.bins;
  }

  private async refresh() {
    try {
      const bins = await this.fetch();
      this.bins = new Set(bins);
      this.lastRefresh = Date.now();
    } catch {
      if (!this.lastRefresh) {
        this.bins = new Set();
      }
    }
  }
}

function ensureNodePathEnv(): string {
  ensureBotCliOnPath({ pathEnv: process.env.PATH ?? "" });
  const current = process.env.PATH ?? "";
  if (current.trim()) {
    return current;
  }
  process.env.PATH = DEFAULT_NODE_PATH;
  return DEFAULT_NODE_PATH;
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
  const marketplaceEnabled =
    config.marketplace?.enabled === true &&
    Boolean(config.marketplace?.claudeApiKey || process.env.ANTHROPIC_API_KEY);
  const isRemoteMode = cfg.gateway?.mode === "remote";
  const token =
    process.env.BOT_GATEWAY_TOKEN?.trim() ||
    (isRemoteMode ? cfg.gateway?.remote?.token : cfg.gateway?.auth?.token);
  const password =
    process.env.BOT_GATEWAY_PASSWORD?.trim() ||
    (isRemoteMode ? cfg.gateway?.remote?.password : cfg.gateway?.auth?.password);

  // Gateway URL resolution priority:
  // 1. BOT_NODE_GATEWAY_URL env var (cloud pods set this for unified gateway)
  // 2. gateway.remote.url from config (remote mode, e.g. wss://gw.hanzo.bot)
  // 3. Constructed from CLI --host/--port/--tls options
  const envGatewayUrl = process.env.BOT_NODE_GATEWAY_URL?.trim();
  const envGatewayHost = process.env.BOT_NODE_GATEWAY_HOST?.trim();
  const remoteUrl = isRemoteMode ? cfg.gateway?.remote?.url : undefined;
  const host = gateway.host ?? "127.0.0.1";
  const port = gateway.port ?? 18789;
  const scheme = gateway.tls ? "wss" : "ws";
  const url = envGatewayUrl || remoteUrl || `${scheme}://${host}:${port}`;
  const pathEnv = ensureNodePathEnv();

  // Build optional WS headers — BOT_NODE_GATEWAY_HOST overrides the Host
  // header sent to the gateway.  Useful when BOT_NODE_GATEWAY_URL points to a
  // direct IP (bypassing CDN/proxy) but nginx-ingress still needs the original
  // hostname for virtual-host routing.
  const wsHeaders: Record<string, string> | undefined = envGatewayHost
    ? { Host: envGatewayHost }
    : undefined;

  const client = new GatewayClient({
    url,
    wsHeaders,
    token: token?.trim() || undefined,
    password: password?.trim() || undefined,
    instanceId: nodeId,
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: displayName,
    clientVersion: VERSION,
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.NODE,
    role: "node",
    scopes: [],
    caps: [
      "system",
      ...(browserProxyEnabled ? ["browser"] : []),
      ...(marketplaceEnabled ? ["marketplace"] : []),
    ],
    commands: [
      "system.run",
      "system.which",
      "system.execApprovals.get",
      "system.execApprovals.set",
      ...(browserProxyEnabled ? ["browser.proxy"] : []),
      ...(marketplaceEnabled ? ["marketplace.proxy"] : []),
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
    onHelloOk: () => {
      // eslint-disable-next-line no-console
      console.log(`\n  Connected to gateway: ${url}`);
      // eslint-disable-next-line no-console
      console.log(`  Node name:   ${displayName}`);
      if (isRemoteMode) {
        // eslint-disable-next-line no-console
        console.log(`  Playground:  https://app.hanzo.bot/nodes`);
      }
      // eslint-disable-next-line no-console
      console.log("");
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
  });

  // Keep-alive handle: GatewayClient reconnect timers use .unref() and
  // won't prevent process exit.  A referenced interval ensures the event
  // loop stays active so the node host can reconnect indefinitely.
  setInterval(() => {}, 2_147_483_647);

  client.start();

  if (marketplaceEnabled && config.marketplace) {
    const idleDetector = new IdleDetector(client, config.marketplace);
    idleDetector.start();
    // eslint-disable-next-line no-console
    console.log(
      `  Marketplace: enabled (idle threshold: ${config.marketplace.idleThresholdSec ?? 300}s)`,
    );
  }

  await new Promise(() => {});
}
