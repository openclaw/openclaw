import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizePluginsConfig } from "./config-state.js";
import { loadOpenClawPlugins } from "./loader.js";
import { createPluginLoaderLogger } from "./logger.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginDiagnostic, PluginHookName } from "./types.js";

export type PluginStatusReport = PluginRegistry & {
  workspaceDir?: string;
};

export type PluginCapabilityKind =
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
  httpRouteCount: number;
  diagnostics: PluginDiagnostic[];
  policy: {
    allowPromptInjection?: boolean;
    allowModelOverride?: boolean;
    allowedModels: string[];
    hasAllowedModelsConfig: boolean;
  };
  usesLegacyBeforeAgentStart: boolean;
};

const log = createSubsystemLogger("plugins");

export function buildPluginStatusReport(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  /** Use an explicit env when plugin roots should resolve independently from process.env. */
  env?: NodeJS.ProcessEnv;
}): PluginStatusReport {
  const config = params?.config ?? loadConfig();
  const workspaceDir = params?.workspaceDir
    ? params.workspaceDir
    : (resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config)) ??
      resolveDefaultAgentWorkspaceDir());

  const registry = loadOpenClawPlugins({
    config,
    workspaceDir,
    env: params?.env,
    logger: createPluginLoaderLogger(log),
  });

  return {
    workspaceDir,
    ...registry,
  };
}

function buildCapabilityEntries(plugin: PluginRegistry["plugins"][number]) {
  return [
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
  const config = params.config ?? loadConfig();
  const report =
    params.report ??
    buildPluginStatusReport({
      config,
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
  const policyEntry = normalizePluginsConfig(config.plugins).entries[plugin.id];
  const capabilityCount = capabilities.length;

  return {
    workspaceDir: report.workspaceDir,
    plugin,
    shape: deriveInspectShape({
      capabilityCount,
      typedHookCount: typedHooks.length,
      customHookCount: customHooks.length,
      toolCount: tools.length,
      commandCount: plugin.commands.length,
      cliCount: plugin.cliCommands.length,
      serviceCount: plugin.services.length,
      gatewayMethodCount: plugin.gatewayMethods.length,
      httpRouteCount: plugin.httpRoutes,
    }),
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
    httpRouteCount: plugin.httpRoutes,
    diagnostics,
    policy: {
      allowPromptInjection: policyEntry?.hooks?.allowPromptInjection,
      allowModelOverride: policyEntry?.subagent?.allowModelOverride,
      allowedModels: [...(policyEntry?.subagent?.allowedModels ?? [])],
      hasAllowedModelsConfig: policyEntry?.subagent?.hasAllowedModelsConfig === true,
    },
    usesLegacyBeforeAgentStart: typedHooks.some((entry) => entry.name === "before_agent_start"),
  };
}

export function buildAllPluginInspectReports(params?: {
  config?: ReturnType<typeof loadConfig>;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  report?: PluginStatusReport;
}): PluginInspectReport[] {
  const config = params?.config ?? loadConfig();
  const report =
    params?.report ??
    buildPluginStatusReport({
      config,
      workspaceDir: params?.workspaceDir,
      env: params?.env,
    });

  return report.plugins
    .map((plugin) =>
      buildPluginInspectReport({
        id: plugin.id,
        config,
        report,
      }),
    )
    .filter((entry): entry is PluginInspectReport => entry !== null);
}
