import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { loadConfig } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { normalizeOpenClawVersionBase } from "../config/version.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { listImportedBundledPluginFacadeIds } from "../plugin-sdk/facade-runtime.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
} from "./bundled-compat.js";
import { normalizePluginsConfig } from "./config-state.js";
import { loadOpenClawPlugins } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import { resolveBundledProviderCompatPluginIds } from "./providers.js";
import type { PluginRegistry } from "./registry.js";
import { listImportedRuntimePluginIds } from "./runtime.js";
import type { PluginDiagnostic, PluginHookName } from "./types.js";

export type PluginStatusReport = PluginRegistry & {
  workspaceDir?: string;
};

export type PluginCapabilityKind =
  | "cli-backend"
  | "text-inference"
  | "speech"
  | "media-understanding"
  | "image-generation"
  | "web-search"
  | "channel";

export type PluginInspectShape =
  | "hook-only"
  | "plain-capability"
  | "hybrid-capability"
  | "non-capability";

export type PluginCompatibilityNotice = {
  pluginId: string;
  code: "legacy-before-agent-start" | "hook-only";
  severity: "warn" | "info";
  message: string;
};

export type PluginCompatibilitySummary = {
  noticeCount: number;
  pluginCount: number;
};

export type PluginInspectReport = {
  workspaceDir?: string;
  plugin: PluginRegistry["plugins"][number];
  shape: PluginInspectShape;
  capabilityMode: "none" | "plain" | "hybrid";
  capabilityCount: number;
  capabilities: Array<{
    kind: PluginCapabilityKind;
    ids: string[];
  }>;
  typedHooks: Array<{
    name: PluginHookName;
    priority?: number;
  }>;
  customHooks: Array<{
    name: string;
    events: string[];
  }>;
  tools: Array<{
    names: string[];
    optional: boolean;
  }>;
  commands: string[];
  cliCommands: string[];
  services: string[];
  gatewayMethods: string[];
  mcpServers: Array<{
    name: string;
    hasStdioTransport: boolean;
  }>;
  lspServers: Array<{
    name: string;
    hasStdioTransport: boolean;
  }>;
  httpRouteCount: number;
  bundleCapabilities: string[];
  diagnostics: PluginDiagnostic[];
  runtimeSnapshot?: {
    source: string;
    summary: string[];
    notices: Array<{
      severity: "info" | "warn" | "error";
      message: string;
    }>;
    raw: Record<string, unknown>;
  };
  policy: {
    allowPromptInjection?: boolean;
    allowModelOverride?: boolean;
    allowedModels: string[];
    hasAllowedModelsConfig: boolean;
  };
  usesLegacyBeforeAgentStart: boolean;
  compatibility: PluginCompatibilityNotice[];
};

export type PluginRuntimeSnapshot = NonNullable<PluginInspectReport["runtimeSnapshot"]>;
export type PluginRuntimeSummary = {
  pluginId: string;
  snapshot: PluginRuntimeSnapshot;
  health: "ok" | "warn" | "error";
};
export type PluginRuntimeNoticeRecord = PluginRuntimeSnapshot["notices"][number] & {
  pluginId: string;
  source: string;
};

const OPENVIKING_RUNTIME_STATUS_PATH = "memory/openviking/_status.json";

function toBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildOpenVikingRuntimeSnapshot(
  workspaceDir: string,
): PluginInspectReport["runtimeSnapshot"] {
  const source = path.join(workspaceDir, OPENVIKING_RUNTIME_STATUS_PATH);
  if (!fs.existsSync(source)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(source, "utf8")) as unknown;
  } catch (error) {
    return {
      source,
      summary: ["Snapshot: unreadable"],
      notices: [
        {
          severity: "error",
          message: `failed to parse runtime snapshot: ${String(error)}`,
        },
      ],
      raw: {},
    };
  }
  if (!isPlainRecord(raw)) {
    return {
      source,
      summary: ["Snapshot: unreadable"],
      notices: [
        {
          severity: "error",
          message: "runtime snapshot is not a JSON object",
        },
      ],
      raw: {},
    };
  }

  const updatedAt = toStringValue(raw.updatedAt);
  const targetUri = toStringValue(raw.targetUri);
  const query = toStringValue(raw.query);
  const resultCount = toNumber(raw.resultCount);
  const retrievalOk = toBoolean(raw.retrievalOk);
  const retrievalError = toStringValue(raw.retrievalError);
  const writebackEnabled = toBoolean(raw.writebackEnabled);
  const writebackMode = toStringValue(raw.writebackMode);
  const writebackError = toStringValue(raw.writebackError);
  const writebackDigest = toStringValue(raw.writebackDigest);
  const writebackSkipped = toStringValue(raw.writebackSkipped);
  const writebackOutcomes = Array.isArray(raw.writebackOutcomes)
    ? raw.writebackOutcomes.filter((entry): entry is string => typeof entry === "string")
    : [];

  const summary: string[] = [];
  if (updatedAt) {
    summary.push(`Updated: ${updatedAt}`);
  }
  if (targetUri) {
    summary.push(`Target URI: ${targetUri}`);
  }
  if (typeof resultCount === "number") {
    summary.push(`Results: ${resultCount}`);
  }
  if (retrievalOk != null) {
    summary.push(`Retrieval: ${retrievalOk ? "ok" : "failed"}`);
  }
  if (query) {
    summary.push(`Query: ${query}`);
  }
  if (writebackEnabled != null) {
    summary.push(`Writeback: ${writebackEnabled ? (writebackMode ?? "enabled") : "disabled"}`);
  }
  if (writebackOutcomes.length > 0) {
    summary.push(`Writeback outputs: ${writebackOutcomes.join(", ")}`);
  }
  if (writebackDigest) {
    summary.push(`Writeback digest: ${writebackDigest}`);
  }
  if (writebackSkipped) {
    summary.push(`Writeback skipped: ${writebackSkipped}`);
  }

  const notices: NonNullable<PluginInspectReport["runtimeSnapshot"]>["notices"] = [];
  if (retrievalOk === false) {
    notices.push({
      severity: "error",
      message: retrievalError
        ? `retrieval failed: ${retrievalError}`
        : "retrieval failed without an error message",
    });
  }
  if (writebackEnabled && writebackError) {
    notices.push({
      severity: "error",
      message: `writeback failed: ${writebackError}`,
    });
  }
  if (writebackSkipped) {
    notices.push({
      severity: "info",
      message: `writeback skipped: ${writebackSkipped}`,
    });
  }

  return {
    source,
    summary,
    notices,
    raw,
  };
}

function buildPluginRuntimeSnapshot(params: {
  plugin: PluginRegistry["plugins"][number];
  workspaceDir?: string;
}): PluginInspectReport["runtimeSnapshot"] {
  if (!params.workspaceDir) {
    return undefined;
  }
  if (params.plugin.id === "openviking") {
    return buildOpenVikingRuntimeSnapshot(params.workspaceDir);
  }
  return undefined;
}

export function buildPluginRuntimeSummaries(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  pluginIds?: string[];
}): PluginRuntimeSummary[] {
  const config = params?.config ?? loadConfig();
  const workspaceDir = params?.workspaceDir
    ? params.workspaceDir
    : (resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)) ??
      resolveDefaultAgentWorkspaceDir());
  const pluginIds = params?.pluginIds ?? ["openviking"];

  return pluginIds
    .map((pluginId) => {
      const snapshot = buildPluginRuntimeSnapshot({
        plugin: {
          id: pluginId,
        } as PluginRegistry["plugins"][number],
        workspaceDir,
      });
      if (!snapshot) {
        return null;
      }
      const health = snapshot.notices.some((entry) => entry.severity === "error")
        ? "error"
        : snapshot.notices.some((entry) => entry.severity === "warn")
          ? "warn"
          : "ok";
      return { pluginId, snapshot, health };
    })
    .filter((entry): entry is PluginRuntimeSummary => entry !== null);
}

export function buildPluginRuntimeNotices(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  pluginIds?: string[];
}): PluginRuntimeNoticeRecord[] {
  return buildPluginRuntimeSummaries(params).flatMap((entry) =>
    entry.snapshot.notices.map((notice) => ({
      ...notice,
      pluginId: entry.pluginId,
      source: entry.snapshot.source,
    })),
  );
}

function buildCompatibilityNoticesForInspect(
  inspect: Pick<PluginInspectReport, "plugin" | "shape" | "usesLegacyBeforeAgentStart">,
): PluginCompatibilityNotice[] {
  const warnings: PluginCompatibilityNotice[] = [];
  if (inspect.usesLegacyBeforeAgentStart) {
    warnings.push({
      pluginId: inspect.plugin.id,
      code: "legacy-before-agent-start",
      severity: "warn",
      message:
        "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
    });
  }
  if (inspect.shape === "hook-only") {
    warnings.push({
      pluginId: inspect.plugin.id,
      code: "hook-only",
      severity: "info",
      message:
        "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.",
    });
  }
  return warnings;
}

const log = createSubsystemLogger("plugins");

function resolveStatusConfig(
  config: ReturnType<typeof loadConfig>,
  env: NodeJS.ProcessEnv | undefined,
) {
  return applyPluginAutoEnable({
    config,
    env: env ?? process.env,
  });
}

function resolveReportedPluginVersion(
  plugin: PluginRegistry["plugins"][number],
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  if (plugin.origin !== "bundled") {
    return plugin.version;
  }
  return (
    normalizeOpenClawVersionBase(resolveCompatibilityHostVersion(env)) ??
    normalizeOpenClawVersionBase(plugin.version) ??
    plugin.version
  );
}

type PluginReportParams = {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: NodeJS.ProcessEnv;
};

function buildPluginReport(
  params: PluginReportParams | undefined,
  loadModules: boolean,
): PluginStatusReport {
  const rawConfig = params?.config ?? loadConfig();
  const autoEnabled = resolveStatusConfig(rawConfig, params?.env);
  const config = autoEnabled.config;
  const workspaceDir = params?.workspaceDir
    ? params.workspaceDir
    : (resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)) ??
      resolveDefaultAgentWorkspaceDir());

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

  const registry = loadOpenClawPlugins({
    config: runtimeCompatConfig,
    activationSourceConfig: rawConfig,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir,
    env: params?.env,
    logger: createPluginLoaderLogger(log),
    activate: false,
    cache: false,
    loadModules,
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
    plugins: registry.plugins.map((plugin) => ({
      ...plugin,
      imported: plugin.format !== "bundle" && importedPluginIds.has(plugin.id),
      version: resolveReportedPluginVersion(plugin, params?.env),
    })),
  };
}

export function buildPluginSnapshotReport(params?: PluginReportParams): PluginStatusReport {
  return buildPluginReport(params, false);
}

export function buildPluginDiagnosticsReport(params?: PluginReportParams): PluginStatusReport {
  return buildPluginReport(params, true);
}

function buildCapabilityEntries(plugin: PluginRegistry["plugins"][number]) {
  return [
    { kind: "cli-backend" as const, ids: plugin.cliBackendIds ?? [] },
    { kind: "text-inference" as const, ids: plugin.providerIds },
    { kind: "speech" as const, ids: plugin.speechProviderIds },
    { kind: "media-understanding" as const, ids: plugin.mediaUnderstandingProviderIds },
    { kind: "image-generation" as const, ids: plugin.imageGenerationProviderIds },
    { kind: "web-search" as const, ids: plugin.webSearchProviderIds },
    { kind: "channel" as const, ids: plugin.channelIds },
  ].filter((entry) => entry.ids.length > 0);
}

function deriveInspectShape(params: {
  capabilityCount: number;
  typedHookCount: number;
  customHookCount: number;
  toolCount: number;
  commandCount: number;
  cliCount: number;
  serviceCount: number;
  gatewayMethodCount: number;
  httpRouteCount: number;
}): PluginInspectShape {
  if (params.capabilityCount > 1) {
    return "hybrid-capability";
  }
  if (params.capabilityCount === 1) {
    return "plain-capability";
  }
  const hasOnlyHooks =
    params.typedHookCount + params.customHookCount > 0 &&
    params.toolCount === 0 &&
    params.commandCount === 0 &&
    params.cliCount === 0 &&
    params.serviceCount === 0 &&
    params.gatewayMethodCount === 0 &&
    params.httpRouteCount === 0;
  if (hasOnlyHooks) {
    return "hook-only";
  }
  return "non-capability";
}

export function buildPluginInspectReport(params: {
  id: string;
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  report?: PluginStatusReport;
}): PluginInspectReport | null {
  const rawConfig = params.config ?? loadConfig();
  const resolvedConfig = resolveStatusConfig(rawConfig, params.env);
  const config = resolvedConfig.config;
  const report =
    params.report ??
    buildPluginDiagnosticsReport({
      config: rawConfig,
      workspaceDir: params.workspaceDir,
      env: params.env,
    });
  const plugin = report.plugins.find((entry) => entry.id === params.id || entry.name === params.id);
  if (!plugin) {
    return null;
  }

  const capabilities = buildCapabilityEntries(plugin);
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
  const runtimeSnapshot = buildPluginRuntimeSnapshot({
    plugin,
    workspaceDir: report.workspaceDir,
  });
  const policyEntry = normalizePluginsConfig(config.plugins).entries[plugin.id];
  const capabilityCount = capabilities.length;
  const shape = deriveInspectShape({
    capabilityCount,
    typedHookCount: typedHooks.length,
    customHookCount: customHooks.length,
    toolCount: tools.length,
    commandCount: plugin.commands.length,
    cliCount: plugin.cliCommands.length,
    serviceCount: plugin.services.length,
    gatewayMethodCount: plugin.gatewayMethods.length,
    httpRouteCount: plugin.httpRoutes,
  });

  // Populate MCP server info for bundle-format plugins with a known rootDir.
  let mcpServers: PluginInspectReport["mcpServers"] = [];
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
  let lspServers: PluginInspectReport["lspServers"] = [];
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

  const usesLegacyBeforeAgentStart = typedHooks.some(
    (entry) => entry.name === "before_agent_start",
  );
  const compatibility = buildCompatibilityNoticesForInspect({
    plugin,
    shape,
    usesLegacyBeforeAgentStart,
  });
  return {
    workspaceDir: report.workspaceDir,
    plugin,
    shape,
    capabilityMode: capabilityCount === 0 ? "none" : capabilityCount === 1 ? "plain" : "hybrid",
    capabilityCount,
    capabilities,
    typedHooks,
    customHooks,
    tools,
    commands: [...plugin.commands],
    cliCommands: [...plugin.cliCommands],
    services: [...plugin.services],
    gatewayMethods: [...plugin.gatewayMethods],
    mcpServers,
    lspServers,
    httpRouteCount: plugin.httpRoutes,
    bundleCapabilities: plugin.bundleCapabilities ?? [],
    diagnostics,
    runtimeSnapshot,
    policy: {
      allowPromptInjection: policyEntry?.hooks?.allowPromptInjection,
      allowModelOverride: policyEntry?.subagent?.allowModelOverride,
      allowedModels: [...(policyEntry?.subagent?.allowedModels ?? [])],
      hasAllowedModelsConfig: policyEntry?.subagent?.hasAllowedModelsConfig === true,
    },
    usesLegacyBeforeAgentStart,
    compatibility,
  };
}

export function buildAllPluginInspectReports(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  report?: PluginStatusReport;
}): PluginInspectReport[] {
  const rawConfig = params?.config ?? loadConfig();
  const report =
    params?.report ??
    buildPluginDiagnosticsReport({
      config: rawConfig,
      workspaceDir: params?.workspaceDir,
      env: params?.env,
    });

  return report.plugins
    .map((plugin) =>
      buildPluginInspectReport({
        id: plugin.id,
        config: rawConfig,
        report,
      }),
    )
    .filter((entry): entry is PluginInspectReport => entry !== null);
}

export function buildPluginCompatibilityWarnings(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  report?: PluginStatusReport;
}): string[] {
  return buildPluginCompatibilityNotices(params).map(formatPluginCompatibilityNotice);
}

export function buildPluginCompatibilityNotices(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  report?: PluginStatusReport;
}): PluginCompatibilityNotice[] {
  return buildAllPluginInspectReports(params).flatMap((inspect) => inspect.compatibility);
}

export function formatPluginCompatibilityNotice(notice: PluginCompatibilityNotice): string {
  return `${notice.pluginId} ${notice.message}`;
}

export function summarizePluginCompatibility(
  notices: PluginCompatibilityNotice[],
): PluginCompatibilitySummary {
  return {
    noticeCount: notices.length,
    pluginCount: new Set(notices.map((notice) => notice.pluginId)).size,
  };
}
