import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import { formatCliCommand } from "../cli/command-format.js";
import { withProgress } from "../cli/progress.js";
import { loadConfig, readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { readLastGatewayErrorLine } from "../daemon/diagnostics.js";
import { resolveNodeService } from "../daemon/node-service.js";
import type { GatewayService } from "../daemon/service.js";
import { resolveGatewayService } from "../daemon/service.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { resolveGatewayProbeAuth } from "../gateway/probe-auth.js";
import { probeGateway } from "../gateway/probe.js";
import { collectChannelStatusIssues } from "../infra/channels-status-issues.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import { inspectPortUsage } from "../infra/ports.js";
import { readRestartSentinel } from "../infra/restart-sentinel.js";
import { getRemoteSkillEligibility } from "../infra/skills-remote.js";
import { readTailscaleStatusJson } from "../infra/tailscale.js";
import { normalizeUpdateChannel, resolveUpdateChannelDisplay } from "../infra/update-channels.js";
import { checkUpdateStatus, formatGitInstallLabel } from "../infra/update-check.js";
import { runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { VERSION } from "../version.js";
import { resolveControlUiLinks } from "./onboard-helpers.js";
import { getAgentLocalStatuses } from "./status-all/agents.js";
import { buildChannelsTable } from "./status-all/channels.js";
import { formatDurationPrecise, formatGatewayAuthUsed } from "./status-all/format.js";
import { pickGatewaySelfPresence } from "./status-all/gateway.js";
import { buildStatusAllReportLines } from "./status-all/report-lines.js";
import { formatUpdateOneLiner } from "./status.update.js";

export async function statusAllCommand(
  runtime: RuntimeEnv,
  opts?: { timeoutMs?: number },
): Promise<void> {
  await withProgress({ label: "Scanning status --all…", total: 11 }, async (progress) => {
    progress.setLabel("Loading config…");
    const cfg = loadConfig();
    const osSummary = resolveOsSummary();
    const snap = await readConfigFileSnapshot().catch(() => null);
    progress.tick();

    progress.setLabel("Checking Tailscale…");
    const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
    const tailscale = await (async () => {
      try {
        const parsed = await readTailscaleStatusJson(runExec, {
          timeoutMs: 1200,
        });
        const backendState = typeof parsed.BackendState === "string" ? parsed.BackendState : null;
        const self =
          typeof parsed.Self === "object" && parsed.Self !== null
            ? (parsed.Self as Record<string, unknown>)
            : null;
        const dnsNameRaw = self && typeof self.DNSName === "string" ? self.DNSName : null;
        const dnsName = dnsNameRaw ? dnsNameRaw.replace(/\.$/, "") : null;
        const ips =
          self && Array.isArray(self.TailscaleIPs)
            ? (self.TailscaleIPs as unknown[])
                .filter((v) => typeof v === "string" && v.trim().length > 0)
                .map((v) => (v as string).trim())
            : [];
        return { ok: true as const, backendState, dnsName, ips, error: null };
      } catch (err) {
        return {
          ok: false as const,
          backendState: null,
          dnsName: null,
          ips: [] as string[],
          error: String(err),
        };
      }
    })();
    const tailscaleHttpsUrl =
      tailscaleMode !== "off" && tailscale.dnsName
        ? `https://${tailscale.dnsName}${normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath)}`
        : null;
    progress.tick();

    progress.setLabel("Checking for updates…");
    const root = await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });
    const update = await checkUpdateStatus({
      root,
      timeoutMs: 6500,
      fetchGit: true,
      includeRegistry: true,
    });
    const configChannel = normalizeUpdateChannel(cfg.update?.channel);
    const channelInfo = resolveUpdateChannelDisplay({
      configChannel,
      installKind: update.installKind,
      gitTag: update.git?.tag ?? null,
      gitBranch: update.git?.branch ?? null,
    });
    const channelLabel = channelInfo.label;
    const gitLabel = formatGitInstallLabel(update);
    progress.tick();

    progress.setLabel("Probing gateway…");
    const connection = buildGatewayConnectionDetails({ config: cfg });
    const isRemoteMode = cfg.gateway?.mode === "remote";
    const remoteUrlRaw =
      typeof cfg.gateway?.remote?.url === "string" ? cfg.gateway.remote.url.trim() : "";
    const remoteUrlMissing = isRemoteMode && !remoteUrlRaw;
    const gatewayMode = isRemoteMode ? "remote" : "local";

    const localFallbackAuth = resolveGatewayProbeAuth({ cfg, mode: "local" });
    const remoteAuth = resolveGatewayProbeAuth({ cfg, mode: "remote" });
    const probeAuth = isRemoteMode && !remoteUrlMissing ? remoteAuth : localFallbackAuth;

    const gatewayProbe = await probeGateway({
      url: connection.url,
      auth: probeAuth,
      timeoutMs: Math.min(5000, opts?.timeoutMs ?? 10_000),
    }).catch(() => null);
    const gatewayReachable = gatewayProbe?.ok === true;
    const gatewaySelf = pickGatewaySelfPresence(gatewayProbe?.presence ?? null);
    progress.tick();

    progress.setLabel("Checking services…");
    const readServiceSummary = async (service: GatewayService) => {
      try {
        const [loaded, runtimeInfo, command] = await Promise.all([
          service.isLoaded({ env: process.env }).catch(() => false),
          service.readRuntime(process.env).catch(() => undefined),
          service.readCommand(process.env).catch(() => null),
        ]);
        const installed = command != null;
        return {
          label: service.label,
          installed,
          loaded,
          loadedText: loaded ? service.loadedText : service.notLoadedText,
          runtime: runtimeInfo,
        };
      } catch {
        return null;
      }
    };
    const daemon = await readServiceSummary(resolveGatewayService());
    const nodeService = await readServiceSummary(resolveNodeService());
    progress.tick();

    progress.setLabel("Scanning agents…");
    const agentStatus = await getAgentLocalStatuses(cfg);
    progress.tick();
    progress.setLabel("Summarizing channels…");
    const channels = await buildChannelsTable(cfg, { showSecrets: false });
    progress.tick();

    const connectionDetailsForReport = (() => {
      if (!remoteUrlMissing) {
        return connection.message;
      }
      const bindMode = cfg.gateway?.bind ?? "loopback";
      const configPath = snap?.path?.trim() ? snap.path.trim() : "(unknown config path)";
      return [
        "Gateway mode: remote",
        "Gateway target: (missing gateway.remote.url)",
        `Config: ${configPath}`,
        `Bind: ${bindMode}`,
        `Local fallback (used for probes): ${connection.url}`,
        "Fix: set gateway.remote.url, or set gateway.mode=local.",
      ].join("\n");
    })();

    const callOverrides = remoteUrlMissing
      ? {
          url: connection.url,
          token: localFallbackAuth.token,
          password: localFallbackAuth.password,
        }
      : {};

    progress.setLabel("Querying gateway…");
    const health = gatewayReachable
      ? await callGateway({
          method: "health",
          timeoutMs: Math.min(8000, opts?.timeoutMs ?? 10_000),
          ...callOverrides,
        }).catch((err) => ({ error: String(err) }))
      : { error: gatewayProbe?.error ?? "gateway unreachable" };

    const channelsStatus = gatewayReachable
      ? await callGateway({
          method: "channels.status",
          params: { probe: false, timeoutMs: opts?.timeoutMs ?? 10_000 },
          timeoutMs: Math.min(8000, opts?.timeoutMs ?? 10_000),
          ...callOverrides,
        }).catch(() => null)
      : null;
    const channelIssues = channelsStatus ? collectChannelStatusIssues(channelsStatus) : [];
    progress.tick();

    progress.setLabel("Checking local state…");
    const sentinel = await readRestartSentinel().catch(() => null);
    const lastErr = await readLastGatewayErrorLine(process.env).catch(() => null);
    const port = resolveGatewayPort(cfg);
    const portUsage = await inspectPortUsage(port).catch(() => null);
    progress.tick();

    const defaultWorkspace =
      agentStatus.agents.find((a) => a.id === agentStatus.defaultId)?.workspaceDir ??
      agentStatus.agents[0]?.workspaceDir ??
      null;
    const skillStatus =
      defaultWorkspace != null
        ? (() => {
            try {
              return buildWorkspaceSkillStatus(defaultWorkspace, {
                config: cfg,
                eligibility: { remote: getRemoteSkillEligibility() },
              });
            } catch {
              return null;
            }
          })()
        : null;

    const controlUiEnabled = cfg.gateway?.controlUi?.enabled ?? true;
    const dashboard = controlUiEnabled
      ? resolveControlUiLinks({
          port,
          bind: cfg.gateway?.bind,
          customBindHost: cfg.gateway?.customBindHost,
          basePath: cfg.gateway?.controlUi?.basePath,
        }).httpUrl
      : null;

    const updateLine = formatUpdateOneLiner(update).replace(/^Update:\s*/i, "");

    const gatewayTarget = remoteUrlMissing ? `fallback ${connection.url}` : connection.url;
    const gatewayStatus = gatewayReachable
      ? `reachable ${formatDurationPrecise(gatewayProbe?.connectLatencyMs ?? 0)}`
      : gatewayProbe?.error
        ? `unreachable (${gatewayProbe.error})`
        : "unreachable";
    const gatewayAuth = gatewayReachable ? ` · auth ${formatGatewayAuthUsed(probeAuth)}` : "";
    const gatewaySelfLine =
      gatewaySelf?.host || gatewaySelf?.ip || gatewaySelf?.version || gatewaySelf?.platform
        ? [
            gatewaySelf.host ? gatewaySelf.host : null,
            gatewaySelf.ip ? `(${gatewaySelf.ip})` : null,
            gatewaySelf.version ? `app ${gatewaySelf.version}` : null,
            gatewaySelf.platform ? gatewaySelf.platform : null,
          ]
            .filter(Boolean)
            .join(" ")
        : null;

    const aliveThresholdMs = 10 * 60_000;
    const aliveAgents = agentStatus.agents.filter(
      (a) => a.lastActiveAgeMs != null && a.lastActiveAgeMs <= aliveThresholdMs,
    ).length;

    const overviewRows = [
      { Item: "Version", Value: VERSION },
      { Item: "OS", Value: osSummary.label },
      { Item: "Node", Value: process.versions.node },
      {
        Item: "Config",
        Value: snap?.path?.trim() ? snap.path.trim() : "(unknown config path)",
      },
      dashboard
        ? { Item: "Dashboard", Value: dashboard }
        : { Item: "Dashboard", Value: "disabled" },
      {
        Item: "Tailscale",
        Value:
          tailscaleMode === "off"
            ? `off${tailscale.backendState ? ` · ${tailscale.backendState}` : ""}${tailscale.dnsName ? ` · ${tailscale.dnsName}` : ""}`
            : tailscale.dnsName && tailscaleHttpsUrl
              ? `${tailscaleMode} · ${tailscale.backendState ?? "unknown"} · ${tailscale.dnsName} · ${tailscaleHttpsUrl}`
              : `${tailscaleMode} · ${tailscale.backendState ?? "unknown"} · magicdns unknown`,
      },
      { Item: "Channel", Value: channelLabel },
      ...(gitLabel ? [{ Item: "Git", Value: gitLabel }] : []),
      { Item: "Update", Value: updateLine },
      {
        Item: "Gateway",
        Value: `${gatewayMode}${remoteUrlMissing ? " (remote.url missing)" : ""} · ${gatewayTarget} (${connection.urlSource}) · ${gatewayStatus}${gatewayAuth}`,
      },
      { Item: "Security", Value: `Run: ${formatCliCommand("openclaw security audit --deep")}` },
      gatewaySelfLine
        ? { Item: "Gateway self", Value: gatewaySelfLine }
        : { Item: "Gateway self", Value: "unknown" },
      daemon
        ? {
            Item: "Gateway service",
            Value: !daemon.installed
              ? `${daemon.label} not installed`
              : `${daemon.label} ${daemon.installed ? "installed · " : ""}${daemon.loadedText}${daemon.runtime?.status ? ` · ${daemon.runtime.status}` : ""}${daemon.runtime?.pid ? ` (pid ${daemon.runtime.pid})` : ""}`,
          }
        : { Item: "Gateway service", Value: "unknown" },
      nodeService
        ? {
            Item: "Node service",
            Value: !nodeService.installed
              ? `${nodeService.label} not installed`
              : `${nodeService.label} ${nodeService.installed ? "installed · " : ""}${nodeService.loadedText}${nodeService.runtime?.status ? ` · ${nodeService.runtime.status}` : ""}${nodeService.runtime?.pid ? ` (pid ${nodeService.runtime.pid})` : ""}`,
          }
        : { Item: "Node service", Value: "unknown" },
      {
        Item: "Agents",
        Value: `${agentStatus.agents.length} total · ${agentStatus.bootstrapPendingCount} bootstrapping · ${aliveAgents} active · ${agentStatus.totalSessions} sessions`,
      },
    ];

    const lines = await buildStatusAllReportLines({
      progress,
      overviewRows,
      channels,
      channelIssues: channelIssues.map((issue) => ({
        channel: issue.channel,
        message: issue.message,
      })),
      agentStatus,
      connectionDetailsForReport,
      diagnosis: {
        snap,
        remoteUrlMissing,
        sentinel,
        lastErr,
        port,
        portUsage,
        tailscaleMode,
        tailscale,
        tailscaleHttpsUrl,
        skillStatus,
        channelsStatus,
        channelIssues,
        gatewayReachable,
        health,
      },
    });

    progress.setLabel("Rendering…");
    runtime.log(lines.join("\n"));
    progress.tick();
  });
}
