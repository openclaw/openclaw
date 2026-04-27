import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { loadConfig } from "../config/config.js";
import { normalizeOpenClawVersionBase } from "../config/version.js";
import { listImportedBundledPluginFacadeIds } from "../plugin-sdk/facade-runtime.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import { withBundledPluginAllowlistCompat, withBundledPluginEnablementCompat, } from "./bundled-compat.js";
import { normalizePluginsConfig } from "./config-state.js";
import { buildPluginShapeSummary, } from "./inspect-shape.js";
import { loadOpenClawPlugins } from "./loader.js";
import { loadPluginRegistrySnapshotWithMetadata, } from "./plugin-registry.js";
import { resolveBundledProviderCompatPluginIds } from "./providers.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { listImportedRuntimePluginIds } from "./runtime.js";
import { buildPluginRuntimeLoadOptions, resolvePluginRuntimeLoadContext, } from "./runtime/load-context.js";
import { loadPluginMetadataRegistrySnapshot } from "./runtime/metadata-registry-loader.js";
function buildCompatibilityNoticesForInspect(inspect) {
    const warnings = [];
    if (inspect.usesLegacyBeforeAgentStart) {
        warnings.push({
            pluginId: inspect.plugin.id,
            code: "legacy-before-agent-start",
            compatCode: "legacy-before-agent-start",
            severity: "warn",
            message: "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
        });
    }
    if (inspect.shape === "hook-only") {
        warnings.push({
            pluginId: inspect.plugin.id,
            code: "hook-only",
            compatCode: "hook-only-plugin-shape",
            severity: "info",
            message: "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.",
        });
    }
    return warnings;
}
function resolveReportedPluginVersion(plugin, env) {
    if (plugin.origin !== "bundled") {
        return plugin.version;
    }
    return (normalizeOpenClawVersionBase(resolveCompatibilityHostVersion(env)) ??
        normalizeOpenClawVersionBase(plugin.version) ??
        plugin.version);
}
function buildPluginRecordFromInstalledIndex(plugin) {
    return {
        id: plugin.pluginId,
        name: plugin.pluginId,
        ...(plugin.packageVersion ? { version: plugin.packageVersion } : {}),
        format: "openclaw",
        source: plugin.manifestPath,
        rootDir: plugin.rootDir,
        origin: plugin.origin,
        enabled: plugin.enabled,
        status: plugin.enabled ? "loaded" : "disabled",
        toolNames: [],
        hookNames: [],
        channelIds: [...plugin.contributions.channels],
        cliBackendIds: [...plugin.contributions.cliBackends],
        providerIds: [...plugin.contributions.providers],
        speechProviderIds: [],
        realtimeTranscriptionProviderIds: [],
        realtimeVoiceProviderIds: [],
        mediaUnderstandingProviderIds: [],
        imageGenerationProviderIds: [],
        videoGenerationProviderIds: [],
        musicGenerationProviderIds: [],
        webFetchProviderIds: [],
        webSearchProviderIds: [],
        memoryEmbeddingProviderIds: [],
        agentHarnessIds: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        gatewayDiscoveryServiceIds: [],
        commands: [...plugin.contributions.commandAliases],
        httpRoutes: 0,
        hookCount: 0,
        configSchema: false,
        contracts: {},
    };
}
export function buildPluginRegistrySnapshotReport(params) {
    const config = params?.config ?? loadConfig();
    const result = loadPluginRegistrySnapshotWithMetadata({
        config,
        env: params?.env,
        workspaceDir: params?.workspaceDir,
    });
    return {
        workspaceDir: params?.workspaceDir,
        ...createEmptyPluginRegistry(),
        plugins: result.snapshot.plugins.map(buildPluginRecordFromInstalledIndex),
        diagnostics: [...result.snapshot.diagnostics],
        registrySource: result.source,
        registryDiagnostics: result.diagnostics,
    };
}
function buildPluginReport(params, loadModules) {
    const baseContext = resolvePluginRuntimeLoadContext({
        config: params?.config ?? loadConfig(),
        env: params?.env,
        logger: params?.logger,
        workspaceDir: params?.workspaceDir,
    });
    const workspaceDir = baseContext.workspaceDir ?? resolveDefaultAgentWorkspaceDir();
    const context = workspaceDir === baseContext.workspaceDir
        ? baseContext
        : {
            ...baseContext,
            workspaceDir,
        };
    const rawConfig = context.rawConfig;
    const config = context.config;
    // Apply bundled-provider allowlist compat so that `plugins list` and `doctor`
    // report the same loaded/disabled status the gateway uses at runtime.  Without
    // this, bundled provider plugins are incorrectly shown as "disabled" when
    // `plugins.allow` is set because the allowlist check runs before the
    // bundled-default-enable check.  Scoped to bundled providers only (not all
    // bundled plugins) to match the runtime compat surface in providers.runtime.ts.
    const bundledProviderIds = resolveBundledProviderCompatPluginIds({
        config,
        workspaceDir,
        env: params?.env,
    });
    const effectiveConfig = withBundledPluginAllowlistCompat({
        config,
        pluginIds: bundledProviderIds,
    });
    const runtimeCompatConfig = withBundledPluginEnablementCompat({
        config: effectiveConfig,
        pluginIds: bundledProviderIds,
    });
    const registry = loadModules
        ? loadOpenClawPlugins(buildPluginRuntimeLoadOptions(context, {
            config: runtimeCompatConfig,
            activationSourceConfig: rawConfig,
            workspaceDir,
            env: params?.env,
            loadModules,
            activate: false,
            cache: false,
        }))
        : loadPluginMetadataRegistrySnapshot({
            config: runtimeCompatConfig,
            activationSourceConfig: rawConfig,
            workspaceDir,
            env: params?.env,
            logger: params?.logger,
            loadModules: false,
        });
    const importedPluginIds = new Set([
        ...(loadModules
            ? registry.plugins
                .filter((plugin) => plugin.status === "loaded" && plugin.format !== "bundle")
                .map((plugin) => plugin.id)
            : []),
        ...listImportedRuntimePluginIds(),
        ...listImportedBundledPluginFacadeIds(),
    ]);
    return {
        workspaceDir,
        ...registry,
        plugins: registry.plugins.map((plugin) => Object.assign({}, plugin, {
            imported: plugin.format !== `bundle` && importedPluginIds.has(plugin.id),
            version: resolveReportedPluginVersion(plugin, params?.env),
        })),
    };
}
export function buildPluginSnapshotReport(params) {
    return buildPluginReport(params, false);
}
export function buildPluginDiagnosticsReport(params) {
    return buildPluginReport(params, true);
}
export function buildPluginInspectReport(params) {
    const rawConfig = params.config ?? loadConfig();
    const config = resolvePluginRuntimeLoadContext({
        config: rawConfig,
        env: params.env,
        logger: params.logger,
        workspaceDir: params.workspaceDir,
    }).config;
    const report = params.report ??
        buildPluginDiagnosticsReport({
            config: rawConfig,
            logger: params.logger,
            workspaceDir: params.workspaceDir,
            env: params.env,
        });
    const plugin = report.plugins.find((entry) => entry.id === params.id || entry.name === params.id);
    if (!plugin) {
        return null;
    }
    const typedHooks = report.typedHooks
        .filter((entry) => entry.pluginId === plugin.id)
        .map((entry) => ({
        name: entry.hookName,
        priority: entry.priority,
    }))
        .toSorted((a, b) => a.name.localeCompare(b.name));
    const customHooks = report.hooks
        .filter((entry) => entry.pluginId === plugin.id)
        .map((entry) => ({
        name: entry.entry.hook.name,
        events: [...entry.events].toSorted(),
    }))
        .toSorted((a, b) => a.name.localeCompare(b.name));
    const tools = report.tools
        .filter((entry) => entry.pluginId === plugin.id)
        .map((entry) => ({
        names: [...entry.names],
        optional: entry.optional,
    }));
    const diagnostics = report.diagnostics.filter((entry) => entry.pluginId === plugin.id);
    const policyEntry = normalizePluginsConfig(config.plugins).entries[plugin.id];
    const shapeSummary = buildPluginShapeSummary({ plugin, report });
    const shape = shapeSummary.shape;
    // Populate MCP server info for bundle-format plugins with a known rootDir.
    let mcpServers = [];
    if (plugin.format === "bundle" && plugin.bundleFormat && plugin.rootDir) {
        const mcpSupport = inspectBundleMcpRuntimeSupport({
            pluginId: plugin.id,
            rootDir: plugin.rootDir,
            bundleFormat: plugin.bundleFormat,
        });
        mcpServers = [
            ...mcpSupport.supportedServerNames.map((name) => ({
                name,
                hasStdioTransport: true,
            })),
            ...mcpSupport.unsupportedServerNames.map((name) => ({
                name,
                hasStdioTransport: false,
            })),
        ];
    }
    // Populate LSP server info for bundle-format plugins with a known rootDir.
    let lspServers = [];
    if (plugin.format === "bundle" && plugin.bundleFormat && plugin.rootDir) {
        const lspSupport = inspectBundleLspRuntimeSupport({
            pluginId: plugin.id,
            rootDir: plugin.rootDir,
            bundleFormat: plugin.bundleFormat,
        });
        lspServers = [
            ...lspSupport.supportedServerNames.map((name) => ({
                name,
                hasStdioTransport: true,
            })),
            ...lspSupport.unsupportedServerNames.map((name) => ({
                name,
                hasStdioTransport: false,
            })),
        ];
    }
    const usesLegacyBeforeAgentStart = shapeSummary.usesLegacyBeforeAgentStart;
    const compatibility = buildCompatibilityNoticesForInspect({
        plugin,
        shape,
        usesLegacyBeforeAgentStart,
    });
    return {
        workspaceDir: report.workspaceDir,
        plugin,
        shape,
        capabilityMode: shapeSummary.capabilityMode,
        capabilityCount: shapeSummary.capabilityCount,
        capabilities: shapeSummary.capabilities,
        typedHooks,
        customHooks,
        tools,
        commands: [...plugin.commands],
        cliCommands: [...plugin.cliCommands],
        services: [...plugin.services],
        gatewayDiscoveryServices: [...plugin.gatewayDiscoveryServiceIds],
        gatewayMethods: [...plugin.gatewayMethods],
        mcpServers,
        lspServers,
        httpRouteCount: plugin.httpRoutes,
        bundleCapabilities: plugin.bundleCapabilities ?? [],
        diagnostics,
        policy: {
            allowPromptInjection: policyEntry?.hooks?.allowPromptInjection,
            allowConversationAccess: policyEntry?.hooks?.allowConversationAccess,
            allowModelOverride: policyEntry?.subagent?.allowModelOverride,
            allowedModels: [...(policyEntry?.subagent?.allowedModels ?? [])],
            hasAllowedModelsConfig: policyEntry?.subagent?.hasAllowedModelsConfig === true,
        },
        usesLegacyBeforeAgentStart,
        compatibility,
    };
}
export function buildAllPluginInspectReports(params) {
    const rawConfig = params?.config ?? loadConfig();
    const report = params?.report ??
        buildPluginDiagnosticsReport({
            config: rawConfig,
            logger: params?.logger,
            workspaceDir: params?.workspaceDir,
            env: params?.env,
        });
    return report.plugins
        .map((plugin) => buildPluginInspectReport({
        id: plugin.id,
        config: rawConfig,
        logger: params?.logger,
        report,
    }))
        .filter((entry) => entry !== null);
}
export function buildPluginCompatibilityWarnings(params) {
    return buildPluginCompatibilityNotices(params).map(formatPluginCompatibilityNotice);
}
export function buildPluginCompatibilityNotices(params) {
    return buildAllPluginInspectReports(params).flatMap((inspect) => inspect.compatibility);
}
export function buildPluginCompatibilitySnapshotNotices(params) {
    const report = buildPluginSnapshotReport(params);
    return buildPluginCompatibilityNotices({
        ...params,
        report,
    });
}
export function formatPluginCompatibilityNotice(notice) {
    return `${notice.pluginId} ${notice.message}`;
}
export function summarizePluginCompatibility(notices) {
    return {
        noticeCount: notices.length,
        pluginCount: new Set(notices.map((notice) => notice.pluginId)).size,
    };
}
