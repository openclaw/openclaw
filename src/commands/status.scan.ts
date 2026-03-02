import { withProgress } from "../cli/progress.js";
import { loadConfig } from "../config/config.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { probeGateway } from "../gateway/probe.js";
import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import { getTailnetHostname } from "../infra/tailscale.js";
import { getMemorySearchManager } from "../memory/index.js";
import type { MemoryProviderStatus } from "../memory/types.js";
import { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { buildChannelsTable } from "./status-all/channels.js";
import { getAgentLocalStatuses } from "./status.agent-local.js";
import { pickGatewaySelfPresence, resolveGatewayProbeAuth } from "./status.gateway-probe.js";
import { getStatusSummary } from "./status.summary.js";
import { getUpdateCheckResult } from "./status.update.js";

type MemoryStatusSnapshot = MemoryProviderStatus & {
  agentId: string;
};

type MemoryPluginStatus = {
  enabled: boolean;
  slot: string | null;
  reason?: string;
};

type DeferredResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

type GatewayProbeSnapshot = {
  gatewayConnection: ReturnType<typeof buildGatewayConnectionDetails>;
  remoteUrlMissing: boolean;
  gatewayMode: "local" | "remote";
  gatewayProbe: Awaited<ReturnType<typeof probeGateway>> | null;
};

function deferResult<T>(promise: Promise<T>): Promise<DeferredResult<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

function unwrapDeferredResult<T>(result: DeferredResult<T>): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function resolveMemoryPluginStatus(cfg: ReturnType<typeof loadConfig>): MemoryPluginStatus {
  const pluginsEnabled = cfg.plugins?.enabled !== false;
  if (!pluginsEnabled) {
    return { enabled: false, slot: null, reason: "plugins disabled" };
  }
  const raw = typeof cfg.plugins?.slots?.memory === "string" ? cfg.plugins.slots.memory.trim() : "";
  if (raw && raw.toLowerCase() === "none") {
    return { enabled: false, slot: null, reason: 'plugins.slots.memory="none"' };
  }
  return { enabled: true, slot: raw || "memory-core" };
}

async function resolveGatewayProbeSnapshot(params: {
  cfg: ReturnType<typeof loadConfig>;
  opts: { timeoutMs?: number; all?: boolean };
}): Promise<GatewayProbeSnapshot> {
  const gatewayConnection = buildGatewayConnectionDetails();
  const isRemoteMode = params.cfg.gateway?.mode === "remote";
  const remoteUrlRaw =
    typeof params.cfg.gateway?.remote?.url === "string" ? params.cfg.gateway.remote.url : "";
  const remoteUrlMissing = isRemoteMode && !remoteUrlRaw.trim();
  const gatewayMode = isRemoteMode ? "remote" : "local";
  const gatewayProbe = remoteUrlMissing
    ? null
    : await probeGateway({
        url: gatewayConnection.url,
        auth: resolveGatewayProbeAuth(params.cfg),
        timeoutMs: Math.min(params.opts.all ? 5000 : 2500, params.opts.timeoutMs ?? 10_000),
      }).catch(() => null);
  return { gatewayConnection, remoteUrlMissing, gatewayMode, gatewayProbe };
}

async function resolveChannelsStatus(params: {
  gatewayReachable: boolean;
  opts: { timeoutMs?: number; all?: boolean };
}) {
  if (!params.gatewayReachable) {
    return null;
  }
  return await callGateway({
    method: "channels.status",
    params: {
      probe: false,
      timeoutMs: Math.min(8000, params.opts.timeoutMs ?? 10_000),
    },
    timeoutMs: Math.min(params.opts.all ? 5000 : 2500, params.opts.timeoutMs ?? 10_000),
  }).catch(() => null);
}

export type StatusScanResult = {
  cfg: ReturnType<typeof loadConfig>;
  osSummary: ReturnType<typeof resolveOsSummary>;
  tailscaleMode: string;
  tailscaleDns: string | null;
  tailscaleHttpsUrl: string | null;
  update: Awaited<ReturnType<typeof getUpdateCheckResult>>;
  gatewayConnection: ReturnType<typeof buildGatewayConnectionDetails>;
  remoteUrlMissing: boolean;
  gatewayMode: "local" | "remote";
  gatewayProbe: Awaited<ReturnType<typeof probeGateway>> | null;
  gatewayReachable: boolean;
  gatewaySelf: ReturnType<typeof pickGatewaySelfPresence>;
  channelIssues: ReturnType<typeof collectChannelStatusIssues>;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatuses>>;
  channels: Awaited<ReturnType<typeof buildChannelsTable>>;
  summary: Awaited<ReturnType<typeof getStatusSummary>>;
  memory: MemoryStatusSnapshot | null;
  memoryPlugin: MemoryPluginStatus;
};

async function resolveMemoryStatusSnapshot(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatuses>>;
  memoryPlugin: MemoryPluginStatus;
}): Promise<MemoryStatusSnapshot | null> {
  const { cfg, agentStatus, memoryPlugin } = params;
  if (!memoryPlugin.enabled) {
    return null;
  }
  if (memoryPlugin.slot !== "memory-core") {
    return null;
  }
  const agentId = agentStatus.defaultId ?? "main";
  const { manager } = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
  if (!manager) {
    return null;
  }
  try {
    await manager.probeVectorAvailability();
  } catch {}
  const status = manager.status();
  await manager.close?.().catch(() => {});
  return { agentId, ...status };
}

async function scanStatusJsonFast(opts: {
  timeoutMs?: number;
  all?: boolean;
}): Promise<StatusScanResult> {
  const cfg = loadConfig();
  const osSummary = resolveOsSummary();
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  const updateTimeoutMs = opts.all ? 6500 : 2500;
  const updatePromise = getUpdateCheckResult({
    timeoutMs: updateTimeoutMs,
    fetchGit: true,
    includeRegistry: true,
  });
  const agentStatusPromise = getAgentLocalStatuses();
  const summaryPromise = getStatusSummary();

  const tailscaleDnsPromise =
    tailscaleMode === "off"
      ? Promise.resolve<string | null>(null)
      : getTailnetHostname((cmd, args) =>
          runExec(cmd, args, { timeoutMs: 1200, maxBuffer: 200_000 }),
        ).catch(() => null);

  const gatewayProbePromise = resolveGatewayProbeSnapshot({ cfg, opts });

  const [tailscaleDns, update, agentStatus, gatewaySnapshot, summary] = await Promise.all([
    tailscaleDnsPromise,
    updatePromise,
    agentStatusPromise,
    gatewayProbePromise,
    summaryPromise,
  ]);
  const tailscaleHttpsUrl =
    tailscaleMode !== "off" && tailscaleDns
      ? `https://${tailscaleDns}${normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath)}`
      : null;

  const { gatewayConnection, remoteUrlMissing, gatewayMode, gatewayProbe } = gatewaySnapshot;
  const gatewayReachable = gatewayProbe?.ok === true;
  const gatewaySelf = gatewayProbe?.presence
    ? pickGatewaySelfPresence(gatewayProbe.presence)
    : null;
  const channelsStatusPromise = resolveChannelsStatus({ gatewayReachable, opts });
  const memoryPlugin = resolveMemoryPluginStatus(cfg);
  const memoryPromise = resolveMemoryStatusSnapshot({ cfg, agentStatus, memoryPlugin });
  const [channelsStatus, memory] = await Promise.all([channelsStatusPromise, memoryPromise]);
  const channelIssues = channelsStatus ? collectChannelStatusIssues(channelsStatus) : [];

  return {
    cfg,
    osSummary,
    tailscaleMode,
    tailscaleDns,
    tailscaleHttpsUrl,
    update,
    gatewayConnection,
    remoteUrlMissing,
    gatewayMode,
    gatewayProbe,
    gatewayReachable,
    gatewaySelf,
    channelIssues,
    agentStatus,
    channels: { rows: [], details: [] },
    summary,
    memory,
    memoryPlugin,
  };
}

export async function scanStatus(
  opts: {
    json?: boolean;
    timeoutMs?: number;
    all?: boolean;
  },
  _runtime: RuntimeEnv,
): Promise<StatusScanResult> {
  if (opts.json) {
    return await scanStatusJsonFast({ timeoutMs: opts.timeoutMs, all: opts.all });
  }
  return await withProgress(
    {
      label: "Scanning status…",
      total: 10,
      enabled: true,
    },
    async (progress) => {
      progress.setLabel("Loading config…");
      const cfg = loadConfig();
      const osSummary = resolveOsSummary();
      const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
      const tailscaleDnsPromise =
        tailscaleMode === "off"
          ? Promise.resolve<string | null>(null)
          : getTailnetHostname((cmd, args) =>
              runExec(cmd, args, { timeoutMs: 1200, maxBuffer: 200_000 }),
            ).catch(() => null);
      const updateTimeoutMs = opts.all ? 6500 : 2500;
      const updatePromise = deferResult(
        getUpdateCheckResult({
          timeoutMs: updateTimeoutMs,
          fetchGit: true,
          includeRegistry: true,
        }),
      );
      const agentStatusPromise = deferResult(getAgentLocalStatuses());
      const summaryPromise = deferResult(getStatusSummary());
      progress.tick();

      progress.setLabel("Checking Tailscale…");
      const tailscaleDns = await tailscaleDnsPromise;
      const tailscaleHttpsUrl =
        tailscaleMode !== "off" && tailscaleDns
          ? `https://${tailscaleDns}${normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath)}`
          : null;
      progress.tick();

      progress.setLabel("Checking for updates…");
      const update = unwrapDeferredResult(await updatePromise);
      progress.tick();

      progress.setLabel("Resolving agents…");
      const agentStatus = unwrapDeferredResult(await agentStatusPromise);
      progress.tick();

      progress.setLabel("Probing gateway…");
      const { gatewayConnection, remoteUrlMissing, gatewayMode, gatewayProbe } =
        await resolveGatewayProbeSnapshot({ cfg, opts });
      const gatewayReachable = gatewayProbe?.ok === true;
      const gatewaySelf = gatewayProbe?.presence
        ? pickGatewaySelfPresence(gatewayProbe.presence)
        : null;
      progress.tick();

      progress.setLabel("Querying channel status…");
      const channelsStatus = await resolveChannelsStatus({ gatewayReachable, opts });
      const channelIssues = channelsStatus ? collectChannelStatusIssues(channelsStatus) : [];
      progress.tick();

      progress.setLabel("Summarizing channels…");
      const channels = await buildChannelsTable(cfg, {
        // Show token previews in regular status; keep `status --all` redacted.
        // Set `CLAWDBOT_SHOW_SECRETS=0` to force redaction.
        showSecrets: process.env.CLAWDBOT_SHOW_SECRETS?.trim() !== "0",
      });
      progress.tick();

      progress.setLabel("Checking memory…");
      const memoryPlugin = resolveMemoryPluginStatus(cfg);
      const memory = await resolveMemoryStatusSnapshot({ cfg, agentStatus, memoryPlugin });
      progress.tick();

      progress.setLabel("Reading sessions…");
      const summary = unwrapDeferredResult(await summaryPromise);
      progress.tick();

      progress.setLabel("Rendering…");
      progress.tick();

      return {
        cfg,
        osSummary,
        tailscaleMode,
        tailscaleDns,
        tailscaleHttpsUrl,
        update,
        gatewayConnection,
        remoteUrlMissing,
        gatewayMode,
        gatewayProbe,
        gatewayReachable,
        gatewaySelf,
        channelIssues,
        agentStatus,
        channels,
        summary,
        memory,
        memoryPlugin,
      };
    },
  );
}
