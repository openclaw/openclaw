import { runExec } from "../process/exec.js";
import { createEmptyTaskAuditSummary } from "../tasks/task-registry.audit.shared.js";
import { createEmptyTaskRegistrySummary } from "../tasks/task-registry.summary.js";
import { buildTailscaleHttpsUrl, resolveGatewayProbeSnapshot } from "./status.scan.shared.js";
export function buildColdStartUpdateResult() {
    return {
        root: null,
        installKind: "unknown",
        packageManager: "unknown",
    };
}
export function buildColdStartAgentLocalStatuses() {
    return {
        defaultId: "main",
        agents: [],
        totalSessions: 0,
        bootstrapPendingCount: 0,
    };
}
export function buildColdStartStatusSummary() {
    return {
        runtimeVersion: null,
        heartbeat: {
            defaultAgentId: "main",
            agents: [],
        },
        channelSummary: [],
        queuedSystemEvents: [],
        tasks: createEmptyTaskRegistrySummary(),
        taskAudit: createEmptyTaskAuditSummary(),
        sessions: {
            paths: [],
            count: 0,
            defaults: { model: null, contextTokens: null },
            recent: [],
            byAgent: [],
        },
    };
}
export function shouldSkipStatusScanNetworkChecks(params) {
    return params.coldStart && !params.hasConfiguredChannels && params.all !== true;
}
export async function createStatusScanCoreBootstrap(params) {
    const tailscaleMode = params.cfg.gateway?.tailscale?.mode ?? "off";
    const skipColdStartNetworkChecks = shouldSkipStatusScanNetworkChecks({
        coldStart: params.coldStart,
        hasConfiguredChannels: params.hasConfiguredChannels,
        all: params.opts.all,
    });
    const updateTimeoutMs = params.opts.all ? 6500 : 2500;
    const tailscaleDnsPromise = tailscaleMode === "off"
        ? Promise.resolve(null)
        : params
            .getTailnetHostname((cmd, args) => runExec(cmd, args, { timeoutMs: 1200, maxBuffer: 200_000 }))
            .catch(() => null);
    const updatePromise = skipColdStartNetworkChecks
        ? Promise.resolve(buildColdStartUpdateResult())
        : params.getUpdateCheckResult({
            timeoutMs: updateTimeoutMs,
            fetchGit: true,
            includeRegistry: true,
        });
    const agentStatusPromise = skipColdStartNetworkChecks
        ? Promise.resolve(buildColdStartAgentLocalStatuses())
        : params.getAgentLocalStatuses(params.cfg);
    const gatewayProbePromise = resolveGatewayProbeSnapshot({
        cfg: params.cfg,
        opts: {
            ...params.opts,
            ...(skipColdStartNetworkChecks ? { skipProbe: true } : {}),
        },
    });
    return {
        tailscaleMode,
        tailscaleDnsPromise,
        updatePromise,
        agentStatusPromise,
        gatewayProbePromise,
        skipColdStartNetworkChecks,
        resolveTailscaleHttpsUrl: async () => buildTailscaleHttpsUrl({
            tailscaleMode,
            tailscaleDns: await tailscaleDnsPromise,
            controlUiBasePath: params.cfg.gateway?.controlUi?.basePath,
        }),
    };
}
export async function createStatusScanBootstrap(params) {
    const core = await createStatusScanCoreBootstrap({
        coldStart: params.coldStart,
        cfg: params.cfg,
        hasConfiguredChannels: params.hasConfiguredChannels,
        opts: params.opts,
        getTailnetHostname: params.getTailnetHostname,
        getUpdateCheckResult: params.getUpdateCheckResult,
        getAgentLocalStatuses: params.getAgentLocalStatuses,
    });
    const summaryPromise = core.skipColdStartNetworkChecks
        ? Promise.resolve(buildColdStartStatusSummary())
        : params.getStatusSummary({
            config: params.cfg,
            sourceConfig: params.sourceConfig,
        });
    return {
        ...core,
        summaryPromise,
    };
}
