// Shared formatting helpers for status overview, gateway summaries, and JSON payloads.
// These functions keep text and JSON status surfaces aligned without pulling in command orchestration.

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGatewayPort } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { GatewayServiceLoadState } from "../../daemon/service-types.js";
import { projectGatewayUrlForDiagnostics } from "../../gateway/connection-details.js";
import { resolveControlUiLinks } from "../../gateway/control-ui-links.js";
import { formatDurationPrecise } from "../../infra/format-time/format-duration.ts";
import {
  normalizeUpdateChannel,
  resolveUpdateChannelDisplay,
} from "../../infra/update-channels.js";
import { formatGitInstallLabel, type UpdateCheckResult } from "../../infra/update-check.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { VERSION } from "../../version.js";
import { formatUpdateOneLiner, resolveUpdateAvailability } from "../status.update.js";

export { formatTimeAgo } from "../../infra/format-time/format-relative.ts";

type StatusOverviewRow = {
  Item: string;
  Value: string;
};

type StatusGatewayConnection = {
  url: string;
  urlSource?: string;
};

type StatusGatewayProbe = {
  connectLatencyMs?: number | null;
  error?: string | null;
  startupPhase?: string;
} | null;

type StatusGatewayProbeAuth = {
  token?: string;
  password?: string;
} | null;

type StatusGatewaySelf =
  | {
      host?: string | null;
      ip?: string | null;
      version?: string | null;
      platform?: string | null;
    }
  | null
  | undefined;

type StatusManagedService = {
  label: string;
  installed: boolean | null;
  loadState?: GatewayServiceLoadState;
  managedByOpenClaw?: boolean;
  loadedText: string;
  runtimeShort?: string | null;
  installationDrift?: string;
  runtime?: {
    status?: string | null;
    pid?: number | null;
    detail?: string | null;
  } | null;
};

/** Resolves the display update channel from config, install kind, and git metadata. */
export function resolveStatusUpdateChannelInfo(params: {
  updateConfigChannel?: string | null;
  update: {
    installKind?: UpdateCheckResult["installKind"];
    git?: {
      tag?: string | null;
      branch?: string | null;
    } | null;
  };
}) {
  return resolveUpdateChannelDisplay({
    configChannel: normalizeUpdateChannel(params.updateConfigChannel),
    currentVersion: VERSION,
    installKind: params.update.installKind ?? "unknown",
    gitTag: params.update.git?.tag ?? null,
    gitBranch: params.update.git?.branch ?? null,
  });
}

/** Builds the update row fields reused by the overview table and status-all report. */
export function buildStatusUpdateSurface(params: {
  updateConfigChannel?: string | null;
  update: UpdateCheckResult;
}) {
  const channelInfo = resolveStatusUpdateChannelInfo({
    updateConfigChannel: params.updateConfigChannel,
    update: params.update,
  });
  return {
    channelInfo,
    channelLabel: channelInfo.label,
    gitLabel: formatGitInstallLabel(params.update),
    updateLine: formatUpdateOneLiner(params.update).replace(/^Update:\s*/i, ""),
    updateAvailable: resolveUpdateAvailability(params.update).available,
  };
}

/** Formats Tailscale exposure in a compact, warning-aware status row value. */
function formatStatusTailscaleValue(params: {
  tailscaleMode: string;
  dnsName?: string | null;
  httpsUrl?: string | null;
  includeBackendStateWhenOn?: boolean;
  includeDnsNameWhenOff?: boolean;
  decorateOff?: (value: string) => string;
  decorateWarn?: (value: string) => string;
}): string {
  const decorateOff = params.decorateOff ?? ((value: string) => value);
  const decorateWarn = params.decorateWarn ?? ((value: string) => value);
  if (params.tailscaleMode === "off") {
    // Off mode can still show DNS context when the caller wants diagnostic detail.
    const suffix = params.includeDnsNameWhenOff ? params.dnsName : null;
    return decorateOff(suffix ? `off · ${suffix}` : "off");
  }
  if (params.dnsName && params.httpsUrl) {
    const parts = [
      params.tailscaleMode,
      params.includeBackendStateWhenOn ? "unknown" : null,
      params.dnsName,
      params.httpsUrl,
    ].filter(Boolean);
    return parts.join(" · ");
  }
  const parts = [
    params.tailscaleMode,
    params.includeBackendStateWhenOn ? "unknown" : null,
    "magicdns unknown",
  ].filter(Boolean);
  return decorateWarn(parts.join(" · "));
}

/** Formats launchd/systemd service state into one row-friendly string. */
function formatStatusServiceValue(params: StatusManagedService): string {
  const inspectionDetail =
    params.loadState?.status === "unknown"
      ? params.loadState.detail
      : params.runtime?.status === "unknown"
        ? params.runtime.detail
        : undefined;
  const inspectionFailed = params.loadState?.status === "unknown" || Boolean(inspectionDetail);
  // A missing definition does not make a failed native inspection evidence of absence.
  if (params.installed === false && !inspectionFailed) {
    return `${params.label} not installed`;
  }
  const installedPrefix = params.managedByOpenClaw ? "installed · " : "";
  const loadedText = inspectionDetail
    ? `${params.loadedText} (inspection failed: ${redactSensitiveText(inspectionDetail, { mode: "tools" })})`
    : params.loadedText;
  const runtimeSuffix = params.runtimeShort
    ? ` · ${params.runtimeShort}`
    : [
        params.runtime?.status ? ` · ${params.runtime.status}` : "",
        params.runtime?.pid ? ` (pid ${params.runtime.pid})` : "",
      ].join("");
  const runtimeText = inspectionFailed
    ? redactSensitiveText(runtimeSuffix, { mode: "tools" })
    : runtimeSuffix;
  const installationWarning = params.installationDrift ? ` · ${params.installationDrift}` : "";
  return `${params.label} ${installedPrefix}${loadedText}${runtimeText}${installationWarning}`;
}

/** Returns the dashboard URL when the Control UI is enabled for the current gateway binding. */
function resolveStatusDashboardUrl(params: {
  cfg: Pick<OpenClawConfig, "gateway">;
}): string | null {
  if (!(params.cfg.gateway?.controlUi?.enabled ?? true)) {
    return null;
  }
  return resolveControlUiLinks({
    port: resolveGatewayPort(params.cfg),
    bind: params.cfg.gateway?.bind,
    customBindHost: params.cfg.gateway?.customBindHost,
    basePath: params.cfg.gateway?.controlUi?.basePath,
    tlsEnabled: params.cfg.gateway?.tls?.enabled === true,
  }).httpUrl;
}

/** Builds overview rows directly from raw scan/update/gateway inputs. */
export function buildStatusOverviewSurfaceRows(params: {
  cfg: Pick<OpenClawConfig, "update" | "gateway" | "telemetry">;
  update: UpdateCheckResult;
  tailscaleMode: string;
  tailscaleDns?: string | null;
  tailscaleHttpsUrl?: string | null;
  advertisedControlUiLinks?: { httpUrl: string; wsUrl: string };
  includeBackendStateWhenOn?: boolean;
  includeDnsNameWhenOff?: boolean;
  decorateTailscaleOff?: (value: string) => string;
  decorateTailscaleWarn?: (value: string) => string;
  gatewayMode: "local" | "remote";
  remoteUrlMissing: boolean;
  gatewayConnection: StatusGatewayConnection;
  gatewayReachable: boolean;
  gatewayProbe: StatusGatewayProbe;
  gatewayProbeAuth: StatusGatewayProbeAuth;
  gatewayProbeAuthWarning?: string | null;
  gatewaySelf: StatusGatewaySelf;
  gatewayService: StatusManagedService;
  nodeService: StatusManagedService;
  nodeOnlyGateway?: {
    gatewayValue: string;
  } | null;
  decorateOk?: (value: string) => string;
  decorateWarn?: (value: string) => string;
  prefixRows?: StatusOverviewRow[];
  middleRows?: StatusOverviewRow[];
  suffixRows?: StatusOverviewRow[];
  agentsValue: string;
  updateValue?: string;
  gatewayAuthWarningValue?: string | null;
  gatewaySelfFallbackValue?: string | null;
}) {
  const updateSurface = buildStatusUpdateSurface({
    updateConfigChannel: params.cfg.update?.channel,
    update: params.update,
  });
  const decorateOk = params.decorateOk ?? ((value: string) => value);
  const decorateWarn = params.decorateWarn ?? ((value: string) => value);
  const gatewaySummary = buildGatewayStatusSummaryParts(params);
  const gatewaySelfValue = formatGatewaySelfSummary(params.gatewaySelf);
  const gatewayValue =
    params.nodeOnlyGateway?.gatewayValue ??
    `${gatewaySummary.modeLabel} · ${gatewaySummary.targetTextWithSource} · ${
      params.remoteUrlMissing
        ? decorateWarn(gatewaySummary.reachText)
        : params.gatewayReachable
          ? decorateOk(gatewaySummary.reachText)
          : decorateWarn(gatewaySummary.reachText)
    }${
      params.gatewayReachable && !params.remoteUrlMissing && gatewaySummary.authText
        ? ` · ${gatewaySummary.authText}`
        : ""
    }${gatewaySelfValue ? ` · ${gatewaySelfValue}` : ""}`;
  const dashboardUrl =
    params.advertisedControlUiLinks?.httpUrl ?? resolveStatusDashboardUrl({ cfg: params.cfg });
  const gatewayServiceValue = formatStatusServiceValue(params.gatewayService);
  const nodeServiceValue = formatStatusServiceValue(params.nodeService);
  const tailscaleValue = formatStatusTailscaleValue({
    tailscaleMode: params.tailscaleMode,
    dnsName: params.tailscaleDns,
    httpsUrl: params.tailscaleHttpsUrl,
    includeBackendStateWhenOn: params.includeBackendStateWhenOn,
    includeDnsNameWhenOff: params.includeDnsNameWhenOff,
    decorateOff: params.decorateTailscaleOff,
    decorateWarn: params.decorateTailscaleWarn,
  });
  const gatewayAuthWarning =
    params.gatewayAuthWarningValue !== undefined
      ? params.gatewayAuthWarningValue
      : params.gatewayProbeAuthWarning;
  const gatewaySelfRowValue = gatewaySelfValue ?? params.gatewaySelfFallbackValue;
  const rows: StatusOverviewRow[] = [
    ...(params.prefixRows ?? []),
    { Item: "Dashboard", Value: normalizeOptionalString(dashboardUrl) ?? "disabled" },
    { Item: "Tailscale exposure", Value: tailscaleValue },
    { Item: "Channel", Value: updateSurface.channelLabel },
  ];
  if (updateSurface.gitLabel) {
    rows.push({ Item: "Git", Value: updateSurface.gitLabel });
  }
  rows.push(
    { Item: "Update", Value: params.updateValue ?? updateSurface.updateLine },
    { Item: "Gateway", Value: gatewayValue },
  );
  if (gatewayAuthWarning) {
    rows.push({ Item: "Gateway auth warning", Value: gatewayAuthWarning });
  }
  rows.push(...(params.middleRows ?? []));
  if (gatewaySelfRowValue != null) {
    rows.push({ Item: "Gateway self", Value: gatewaySelfRowValue });
  }
  rows.push(
    { Item: "Gateway service", Value: gatewayServiceValue },
    { Item: "Node service", Value: nodeServiceValue },
    { Item: "Agents", Value: params.agentsValue },
    ...(params.suffixRows ?? []),
  );
  return rows;
}

/** Returns which gateway auth material was actually used for the probe. */
function formatGatewayAuthUsed(
  auth: StatusGatewayProbeAuth,
): "token" | "password" | "token+password" | "none" {
  const hasToken = Boolean(auth?.token?.trim());
  const hasPassword = Boolean(auth?.password?.trim());
  if (hasToken && hasPassword) {
    return "token+password";
  }
  if (hasToken) {
    return "token";
  }
  if (hasPassword) {
    return "password";
  }
  return "none";
}

/** Formats gateway self metadata returned by the health endpoint. */
function formatGatewaySelfSummary(gatewaySelf: StatusGatewaySelf): string | null {
  return gatewaySelf?.host || gatewaySelf?.ip || gatewaySelf?.version || gatewaySelf?.platform
    ? [
        gatewaySelf.host ? gatewaySelf.host : null,
        gatewaySelf.ip ? `(${gatewaySelf.ip})` : null,
        gatewaySelf.version ? `app ${gatewaySelf.version}` : null,
        gatewaySelf.platform ? gatewaySelf.platform : null,
      ]
        .filter(Boolean)
        .join(" ")
    : null;
}

/** Builds gateway target, reachability, auth, and mode strings for text status output. */
function buildGatewayStatusSummaryParts(params: {
  gatewayMode: "local" | "remote";
  remoteUrlMissing: boolean;
  gatewayConnection: StatusGatewayConnection;
  gatewayReachable: boolean;
  gatewayProbe: StatusGatewayProbe;
  gatewayProbeAuth: StatusGatewayProbeAuth;
}): {
  targetText: string;
  targetTextWithSource: string;
  reachText: string;
  authText: string;
  modeLabel: string;
} {
  const displayUrl = projectGatewayUrlForDiagnostics(params.gatewayConnection.url);
  const targetText = params.remoteUrlMissing ? `fallback ${displayUrl}` : displayUrl;
  const targetTextWithSource = params.gatewayConnection.urlSource
    ? `${targetText} (${params.gatewayConnection.urlSource})`
    : targetText;
  const reachText = params.remoteUrlMissing
    ? "misconfigured (remote.url missing)"
    : params.gatewayProbe?.startupPhase
      ? `still starting (phase ${params.gatewayProbe.startupPhase})`
      : params.gatewayReachable
        ? `reachable ${formatDurationPrecise(params.gatewayProbe?.connectLatencyMs ?? 0)}`
        : params.gatewayProbe?.error
          ? `unreachable (${params.gatewayProbe.error})`
          : "unreachable";
  const authText = params.gatewayReachable
    ? `auth ${formatGatewayAuthUsed(params.gatewayProbeAuth)}`
    : "";
  const modeLabel = `${params.gatewayMode}${params.remoteUrlMissing ? " (remote.url missing)" : ""}`;
  return {
    targetText,
    targetTextWithSource,
    reachText,
    authText,
    modeLabel,
  };
}

/** Builds the stable gateway object used by `openclaw status --json`. */
export function buildGatewayStatusJsonPayload(params: {
  gatewayMode: "local" | "remote";
  gatewayConnection: StatusGatewayConnection;
  remoteUrlMissing: boolean;
  gatewayReachable: boolean;
  gatewayProbe:
    | {
        connectLatencyMs?: number | null;
        error?: string | null;
        health?: unknown;
        startupPhase?: string;
      }
    | null
    | undefined;
  gatewaySelf: StatusGatewaySelf;
  gatewayProbeAuthWarning?: string | null;
}) {
  return {
    mode: params.gatewayMode,
    url: projectGatewayUrlForDiagnostics(params.gatewayConnection.url),
    urlSource: params.gatewayConnection.urlSource,
    misconfigured: params.remoteUrlMissing,
    reachable: params.gatewayReachable,
    ...(params.gatewayProbe?.startupPhase
      ? { readiness: "still-starting", startupPhase: params.gatewayProbe.startupPhase }
      : {}),
    connectLatencyMs: params.gatewayProbe?.connectLatencyMs ?? null,
    self: params.gatewaySelf ?? null,
    error: params.gatewayProbe?.error ?? null,
    authWarning: params.gatewayProbeAuthWarning ?? null,
  };
}

/** Redacts common credential shapes before text is printed in status diagnostics. */
export function redactStatusSecrets(text: string): string {
  if (!text) {
    return text;
  }
  let out = text;
  out = out.replace(
    /(\b(?:access[_-]?token|refresh[_-]?token|token|password|secret|api[_-]?key)\b\s*[:=]\s*)("?)([^"\\s]+)("?)/gi,
    "$1$2***$4",
  );
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]+\b/g, "Bearer ***");
  out = out.replace(/\bsk-[A-Za-z0-9]{10,}\b/g, "sk-***");
  return out;
}
