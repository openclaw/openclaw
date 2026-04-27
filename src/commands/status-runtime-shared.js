import { resolveReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import { getDaemonStatusSummary, getNodeDaemonStatusSummary } from "./status.daemon.js";
let providerUsagePromise;
let securityAuditModulePromise;
let gatewayCallModulePromise;
function loadProviderUsage() {
    providerUsagePromise ??= import("../infra/provider-usage.js");
    return providerUsagePromise;
}
function loadSecurityAuditModule() {
    securityAuditModulePromise ??= import("../security/audit.runtime.js");
    return securityAuditModulePromise;
}
function loadGatewayCallModule() {
    gatewayCallModulePromise ??= import("../gateway/call.js");
    return gatewayCallModulePromise;
}
export async function resolveStatusSecurityAudit(params) {
    const { runSecurityAudit } = await loadSecurityAuditModule();
    const readOnlyPlugins = resolveReadOnlyChannelPluginsForConfig(params.config, {
        activationSourceConfig: params.sourceConfig,
    });
    return await runSecurityAudit({
        config: params.config,
        sourceConfig: params.sourceConfig,
        deep: false,
        includeFilesystem: true,
        includeChannelSecurity: true,
        ...(readOnlyPlugins.missingConfiguredChannelIds.length === 0
            ? { plugins: readOnlyPlugins.plugins }
            : {}),
    });
}
export async function resolveStatusUsageSummary(timeoutMs) {
    const { loadProviderUsageSummary } = await loadProviderUsage();
    return await loadProviderUsageSummary({ timeoutMs });
}
export async function loadStatusProviderUsageModule() {
    return await loadProviderUsage();
}
export async function resolveStatusGatewayHealth(params) {
    const { callGateway } = await loadGatewayCallModule();
    return await callGateway({
        method: "health",
        params: { probe: true },
        timeoutMs: params.timeoutMs,
        config: params.config,
    });
}
export async function resolveStatusGatewayHealthSafe(params) {
    if (!params.gatewayReachable) {
        return { error: params.gatewayProbeError ?? "gateway unreachable" };
    }
    const { callGateway } = await loadGatewayCallModule();
    return await callGateway({
        method: "health",
        params: { probe: true },
        timeoutMs: params.timeoutMs,
        config: params.config,
        ...params.callOverrides,
    }).catch((err) => ({ error: String(err) }));
}
export async function resolveStatusLastHeartbeat(params) {
    if (!params.gatewayReachable) {
        return null;
    }
    const { callGateway } = await loadGatewayCallModule();
    return await callGateway({
        method: "last-heartbeat",
        params: {},
        timeoutMs: params.timeoutMs,
        config: params.config,
    }).catch(() => null);
}
export async function resolveStatusServiceSummaries() {
    return await Promise.all([getDaemonStatusSummary(), getNodeDaemonStatusSummary()]);
}
export async function resolveStatusRuntimeDetails(params) {
    const resolveUsageSummary = params.resolveUsage ?? resolveStatusUsageSummary;
    const resolveGatewayHealthSummary = params.resolveHealth ?? resolveStatusGatewayHealth;
    const usage = params.usage ? await resolveUsageSummary(params.timeoutMs) : undefined;
    const health = params.deep
        ? params.suppressHealthErrors
            ? await resolveGatewayHealthSummary({
                config: params.config,
                timeoutMs: params.timeoutMs,
            }).catch(() => undefined)
            : await resolveGatewayHealthSummary({
                config: params.config,
                timeoutMs: params.timeoutMs,
            })
        : undefined;
    const lastHeartbeat = params.deep
        ? await resolveStatusLastHeartbeat({
            config: params.config,
            timeoutMs: params.timeoutMs,
            gatewayReachable: params.gatewayReachable,
        })
        : null;
    const [gatewayService, nodeService] = await resolveStatusServiceSummaries();
    const result = {
        usage,
        health,
        lastHeartbeat,
        gatewayService,
        nodeService,
    };
    return result;
}
export async function resolveStatusRuntimeSnapshot(params) {
    const securityAudit = params.includeSecurityAudit
        ? await (params.resolveSecurityAudit ?? resolveStatusSecurityAudit)({
            config: params.config,
            sourceConfig: params.sourceConfig,
        })
        : undefined;
    const runtimeDetails = await resolveStatusRuntimeDetails({
        config: params.config,
        timeoutMs: params.timeoutMs,
        usage: params.usage,
        deep: params.deep,
        gatewayReachable: params.gatewayReachable,
        suppressHealthErrors: params.suppressHealthErrors,
        resolveUsage: params.resolveUsage,
        resolveHealth: params.resolveHealth,
    });
    return {
        securityAudit,
        ...runtimeDetails,
    };
}
