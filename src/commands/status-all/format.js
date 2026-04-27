import { resolveGatewayPort } from "../../config/config.js";
import { resolveControlUiLinks } from "../../gateway/control-ui-links.js";
import { formatDurationPrecise } from "../../infra/format-time/format-duration.ts";
import { normalizeUpdateChannel, resolveUpdateChannelDisplay, } from "../../infra/update-channels.js";
import { formatGitInstallLabel } from "../../infra/update-check.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { formatUpdateOneLiner, resolveUpdateAvailability } from "../status.update.js";
export { formatDurationPrecise } from "../../infra/format-time/format-duration.ts";
export { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
export function resolveStatusUpdateChannelInfo(params) {
    return resolveUpdateChannelDisplay({
        configChannel: normalizeUpdateChannel(params.updateConfigChannel),
        installKind: params.update.installKind ?? "unknown",
        gitTag: params.update.git?.tag ?? null,
        gitBranch: params.update.git?.branch ?? null,
    });
}
export function buildStatusUpdateSurface(params) {
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
export function formatStatusDashboardValue(value) {
    const trimmed = normalizeOptionalString(value);
    return trimmed && trimmed.length > 0 ? trimmed : "disabled";
}
export function formatStatusTailscaleValue(params) {
    const decorateOff = params.decorateOff ?? ((value) => value);
    const decorateWarn = params.decorateWarn ?? ((value) => value);
    if (params.tailscaleMode === "off") {
        const suffix = [
            params.includeBackendStateWhenOff && params.backendState ? params.backendState : null,
            params.includeDnsNameWhenOff && params.dnsName ? params.dnsName : null,
        ]
            .filter(Boolean)
            .join(" · ");
        return decorateOff(suffix ? `off · ${suffix}` : "off");
    }
    if (params.dnsName && params.httpsUrl) {
        const parts = [
            params.tailscaleMode,
            params.includeBackendStateWhenOn ? (params.backendState ?? "unknown") : null,
            params.dnsName,
            params.httpsUrl,
        ].filter(Boolean);
        return parts.join(" · ");
    }
    const parts = [
        params.tailscaleMode,
        params.includeBackendStateWhenOn ? (params.backendState ?? "unknown") : null,
        "magicdns unknown",
    ].filter(Boolean);
    return decorateWarn(parts.join(" · "));
}
export function formatStatusServiceValue(params) {
    if (!params.installed) {
        return `${params.label} not installed`;
    }
    const installedPrefix = params.managedByOpenClaw ? "installed · " : "";
    const runtimeSuffix = params.runtimeShort
        ? ` · ${params.runtimeShort}`
        : [
            params.runtimeStatus ? ` · ${params.runtimeStatus}` : "",
            params.runtimePid ? ` (pid ${params.runtimePid})` : "",
        ].join("");
    return `${params.label} ${installedPrefix}${params.loadedText}${runtimeSuffix}`;
}
export function resolveStatusDashboardUrl(params) {
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
export function buildStatusOverviewRows(params) {
    const rows = [...(params.prefixRows ?? [])];
    rows.push({ Item: "Dashboard", Value: params.dashboardValue }, { Item: "Tailscale", Value: params.tailscaleValue }, { Item: "Channel", Value: params.channelLabel });
    if (params.gitLabel) {
        rows.push({ Item: "Git", Value: params.gitLabel });
    }
    rows.push({ Item: "Update", Value: params.updateValue }, { Item: "Gateway", Value: params.gatewayValue });
    if (params.gatewayAuthWarning) {
        rows.push({
            Item: "Gateway auth warning",
            Value: params.gatewayAuthWarning,
        });
    }
    rows.push(...(params.middleRows ?? []));
    if (params.gatewaySelfValue != null) {
        rows.push({ Item: "Gateway self", Value: params.gatewaySelfValue });
    }
    rows.push({ Item: "Gateway service", Value: params.gatewayServiceValue }, { Item: "Node service", Value: params.nodeServiceValue }, { Item: "Agents", Value: params.agentsValue });
    rows.push(...(params.suffixRows ?? []));
    return rows;
}
export function buildStatusOverviewSurfaceRows(params) {
    const updateSurface = buildStatusUpdateSurface({
        updateConfigChannel: params.cfg.update?.channel,
        update: params.update,
    });
    const { dashboardUrl, gatewayValue, gatewaySelfValue, gatewayServiceValue, nodeServiceValue } = buildStatusGatewaySurfaceValues({
        cfg: params.cfg,
        gatewayMode: params.gatewayMode,
        remoteUrlMissing: params.remoteUrlMissing,
        gatewayConnection: params.gatewayConnection,
        gatewayReachable: params.gatewayReachable,
        gatewayProbe: params.gatewayProbe,
        gatewayProbeAuth: params.gatewayProbeAuth,
        gatewaySelf: params.gatewaySelf,
        gatewayService: params.gatewayService,
        nodeService: params.nodeService,
        nodeOnlyGateway: params.nodeOnlyGateway,
        decorateOk: params.decorateOk,
        decorateWarn: params.decorateWarn,
    });
    return buildStatusOverviewRows({
        prefixRows: params.prefixRows,
        dashboardValue: formatStatusDashboardValue(dashboardUrl),
        tailscaleValue: formatStatusTailscaleValue({
            tailscaleMode: params.tailscaleMode,
            dnsName: params.tailscaleDns,
            httpsUrl: params.tailscaleHttpsUrl,
            backendState: params.tailscaleBackendState,
            includeBackendStateWhenOff: params.includeBackendStateWhenOff,
            includeBackendStateWhenOn: params.includeBackendStateWhenOn,
            includeDnsNameWhenOff: params.includeDnsNameWhenOff,
            decorateOff: params.decorateTailscaleOff,
            decorateWarn: params.decorateTailscaleWarn,
        }),
        channelLabel: updateSurface.channelLabel,
        gitLabel: updateSurface.gitLabel,
        updateValue: params.updateValue ?? updateSurface.updateLine,
        gatewayValue,
        gatewayAuthWarning: params.gatewayAuthWarningValue !== undefined
            ? params.gatewayAuthWarningValue
            : params.gatewayProbeAuthWarning,
        middleRows: params.middleRows,
        gatewaySelfValue: params.gatewaySelfFallbackValue ?? gatewaySelfValue,
        gatewayServiceValue,
        nodeServiceValue,
        agentsValue: params.agentsValue,
        suffixRows: params.suffixRows,
    });
}
export function formatGatewayAuthUsed(auth) {
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
export function formatGatewaySelfSummary(gatewaySelf) {
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
export function buildGatewayStatusSummaryParts(params) {
    const targetText = params.remoteUrlMissing
        ? `fallback ${params.gatewayConnection.url}`
        : params.gatewayConnection.url;
    const targetTextWithSource = params.gatewayConnection.urlSource
        ? `${targetText} (${params.gatewayConnection.urlSource})`
        : targetText;
    const reachText = params.remoteUrlMissing
        ? "misconfigured (remote.url missing)"
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
export function buildStatusGatewaySurfaceValues(params) {
    const decorateOk = params.decorateOk ?? ((value) => value);
    const decorateWarn = params.decorateWarn ?? ((value) => value);
    const gatewaySummary = buildGatewayStatusSummaryParts({
        gatewayMode: params.gatewayMode,
        remoteUrlMissing: params.remoteUrlMissing,
        gatewayConnection: params.gatewayConnection,
        gatewayReachable: params.gatewayReachable,
        gatewayProbe: params.gatewayProbe,
        gatewayProbeAuth: params.gatewayProbeAuth,
    });
    const gatewaySelfValue = formatGatewaySelfSummary(params.gatewaySelf);
    const gatewayValue = params.nodeOnlyGateway?.gatewayValue ??
        `${gatewaySummary.modeLabel} · ${gatewaySummary.targetTextWithSource} · ${params.remoteUrlMissing
            ? decorateWarn(gatewaySummary.reachText)
            : params.gatewayReachable
                ? decorateOk(gatewaySummary.reachText)
                : decorateWarn(gatewaySummary.reachText)}${params.gatewayReachable &&
            !params.remoteUrlMissing &&
            gatewaySummary.authText &&
            gatewaySummary.authText.length > 0
            ? ` · ${gatewaySummary.authText}`
            : ""}${gatewaySelfValue ? ` · ${gatewaySelfValue}` : ""}`;
    return {
        dashboardUrl: resolveStatusDashboardUrl({ cfg: params.cfg }),
        gatewayValue,
        gatewaySelfValue,
        gatewayServiceValue: formatStatusServiceValue({
            label: params.gatewayService.label,
            installed: params.gatewayService.installed !== false,
            managedByOpenClaw: params.gatewayService.managedByOpenClaw,
            loadedText: params.gatewayService.loadedText,
            runtimeShort: params.gatewayService.runtimeShort,
            runtimeStatus: params.gatewayService.runtime?.status,
            runtimePid: params.gatewayService.runtime?.pid,
        }),
        nodeServiceValue: formatStatusServiceValue({
            label: params.nodeService.label,
            installed: params.nodeService.installed !== false,
            managedByOpenClaw: params.nodeService.managedByOpenClaw,
            loadedText: params.nodeService.loadedText,
            runtimeShort: params.nodeService.runtimeShort,
            runtimeStatus: params.nodeService.runtime?.status,
            runtimePid: params.nodeService.runtime?.pid,
        }),
    };
}
export function buildGatewayStatusJsonPayload(params) {
    return {
        mode: params.gatewayMode,
        url: params.gatewayConnection.url,
        urlSource: params.gatewayConnection.urlSource,
        misconfigured: params.remoteUrlMissing,
        reachable: params.gatewayReachable,
        connectLatencyMs: params.gatewayProbe?.connectLatencyMs ?? null,
        self: params.gatewaySelf ?? null,
        error: params.gatewayProbe?.error ?? null,
        authWarning: params.gatewayProbeAuthWarning ?? null,
    };
}
export function redactSecrets(text) {
    if (!text) {
        return text;
    }
    let out = text;
    out = out.replace(/(\b(?:access[_-]?token|refresh[_-]?token|token|password|secret|api[_-]?key)\b\s*[:=]\s*)("?)([^"\\s]+)("?)/gi, "$1$2***$4");
    out = out.replace(/\bBearer\s+[A-Za-z0-9._-]+\b/g, "Bearer ***");
    out = out.replace(/\bsk-[A-Za-z0-9]{10,}\b/g, "sk-***");
    return out;
}
