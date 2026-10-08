import { listModelRefsFromConfigValue } from "@openclaw/model-catalog-core/configured-model-refs";
// Doctor checks for context engine host requirements against configured agent runtimes.
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeEmbeddedAgentRuntime } from "../../../agents/agent-runtime-id.js";
import {
  listAgentEntriesWithSource,
  resolveAgentDir,
  resolveAmbientOwnerAgentId,
} from "../../../agents/agent-scope-config.js";
import { resolveCliBackendConfig } from "../../../agents/cli-backends.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { resolveAgentHarnessPolicy } from "../../../agents/harness/policy.js";
import { getRegisteredAgentHarness } from "../../../agents/harness/registry.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  buildGenericCliContextEngineHostSupport,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  evaluateContextEngineHostSupport,
  OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
  type ContextEngineHostSupport,
} from "../../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../../context-engine/init.js";
import {
  getContextEngineRegistration,
  resolveContextEngine,
} from "../../../context-engine/registry.js";
import type { ContextEngine, ContextEngineInfo } from "../../../context-engine/types.js";
import { acquirePluginRegistryForInspection } from "../../../plugins/loader.js";
import type { PluginRegistry } from "../../../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { defaultSlotIdForKey } from "../../../plugins/slots.js";
import { isRecord, resolveUserPath } from "../../../utils.js";

type HostCandidate = {
  /** Context-engine host capability descriptor for the runtime. */
  host: ContextEngineHostSupport;
  /** Config paths that caused doctor to consider this host. */
  paths: string[];
};

type ContextEngineInfoResult =
  | { info: ContextEngineInfo; warnings: [] }
  | { info?: undefined; warnings: string[] };

function normalizeRuntimeId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeEmbeddedAgentRuntime(value.trim().toLowerCase());
  return normalized || undefined;
}

function collectExplicitRuntimeRefs(
  cfg: OpenClawConfig,
): Array<{ runtimeId: string; path: string }> {
  const refs: Array<{ runtimeId: string; path: string }> = [];
  const push = (runtime: unknown, path: string) => {
    const runtimeId = normalizeRuntimeId(runtime);
    if (runtimeId && runtimeId !== "default") {
      refs.push({ runtimeId, path });
    }
  };

  for (const [providerId, providerConfig] of Object.entries(cfg.models?.providers ?? {})) {
    push(providerConfig?.agentRuntime?.id, `models.providers.${providerId}.agentRuntime.id`);
    providerConfig?.models?.forEach((modelConfig, index) => {
      push(
        modelConfig?.agentRuntime?.id,
        `models.providers.${providerId}.models[${index}].agentRuntime.id`,
      );
    });
  }

  for (const [modelRef, modelConfig] of Object.entries(cfg.agents?.defaults?.models ?? {})) {
    push(modelConfig?.agentRuntime?.id, `agents.defaults.models.${modelRef}.agentRuntime.id`);
  }

  for (const { entry: agent, source } of listAgentEntriesWithSource(cfg)) {
    const path =
      source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list.${source.index}`;
    for (const [modelRef, modelConfig] of Object.entries(agent.models ?? {})) {
      push(modelConfig?.agentRuntime?.id, `${path}.models.${modelRef}.agentRuntime.id`);
    }
  }

  return refs;
}

function collectSelectedModelRefs(
  cfg: OpenClawConfig,
): Array<{ modelRef: string; path: string; agentId?: string }> {
  const refs: Array<{ modelRef: string; path: string; agentId?: string }> = [];
  const pushModel = (value: unknown, path: string, agentId?: string) => {
    for (const ref of listModelRefsFromConfigValue(value)) {
      const modelRef = ref.trim();
      if (modelRef) {
        refs.push({ modelRef, path, ...(agentId ? { agentId } : {}) });
      }
    }
  };
  const pushModelMap = (models: unknown, path: string, agentId?: string) => {
    if (!isRecord(models)) {
      return;
    }
    for (const modelRef of Object.keys(models)) {
      refs.push({ modelRef, path: `${path}.${modelRef}`, ...(agentId ? { agentId } : {}) });
    }
  };

  if (cfg.agents?.defaults?.model !== undefined) {
    pushModel(cfg.agents.defaults.model, "agents.defaults.model");
  } else {
    refs.push({
      modelRef: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
      path: "agents.defaults.model (default)",
    });
  }
  pushModelMap(cfg.agents?.defaults?.models, "agents.defaults.models");

  for (const { entry: agent, source } of listAgentEntriesWithSource(cfg)) {
    const agentId = agent.id;
    const path =
      source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list.${source.index}`;
    pushModel(agent.model ?? cfg.agents?.defaults?.model, `${path}.model`, agentId);
    pushModelMap(agent.models, `${path}.models`, agentId);
  }

  return refs;
}

function resolveRuntimeHost(cfg: OpenClawConfig, runtimeId: string): ContextEngineHostSupport {
  if (runtimeId === "openclaw" || runtimeId === "auto") {
    return OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST;
  }
  if (runtimeId === "codex") {
    return CODEX_APP_SERVER_CONTEXT_ENGINE_HOST;
  }
  const harness = getRegisteredAgentHarness(runtimeId)?.harness;
  if (harness) {
    return {
      id: `harness:${harness.id}`,
      label: `${harness.label} harness`,
      capabilities: harness.contextEngineHostCapabilities ?? [],
    };
  }
  const cliBackend = resolveCliBackendConfig(runtimeId, cfg);
  return buildGenericCliContextEngineHostSupport({
    backendId: cliBackend?.id ?? runtimeId,
    capabilities: cliBackend?.contextEngineHostCapabilities,
  });
}

/** Collect effective agent-run host candidates from provider/model runtime policy. */
function collectConfiguredContextEngineAgentRunHosts(cfg: OpenClawConfig): HostCandidate[] {
  const runtimePaths = new Map<string, string[]>();
  const push = (runtimeId: string | undefined, path: string) => {
    if (!runtimeId) {
      return;
    }
    const normalized = normalizeRuntimeId(runtimeId) ?? runtimeId;
    const paths = runtimePaths.get(normalized) ?? [];
    paths.push(path);
    runtimePaths.set(normalized, paths);
  };

  for (const ref of collectExplicitRuntimeRefs(cfg)) {
    push(ref.runtimeId, ref.path);
  }
  for (const model of collectSelectedModelRefs(cfg)) {
    const parsed = parseModelCatalogRef(model.modelRef);
    if (!parsed) {
      continue;
    }
    const policy = resolveAgentHarnessPolicy({
      config: cfg,
      provider: parsed.provider,
      modelId: parsed.modelId,
      agentId: model.agentId,
    });
    push(policy.runtime, model.path);
  }

  return [...runtimePaths.entries()].map(([runtimeId, paths]) => ({
    host: resolveRuntimeHost(cfg, runtimeId),
    paths,
  }));
}

function selectedContextEngineSlotId(cfg: OpenClawConfig): string {
  const slotValue = cfg.plugins?.slots?.contextEngine;
  return typeof slotValue === "string" && slotValue.trim()
    ? slotValue.trim()
    : defaultSlotIdForKey("contextEngine");
}

async function resolveSelectedContextEngineInfo(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<ContextEngineInfoResult> {
  const engineId = selectedContextEngineSlotId(params.cfg);
  const defaultEngineId = defaultSlotIdForKey("contextEngine");
  if (engineId === defaultEngineId || engineId === "none") {
    return { info: { id: engineId, name: engineId }, warnings: [] };
  }

  const initializeDuringResolution =
    getContextEngineRegistration(engineId)?.lifecycle === "runtime";
  if (!initializeDuringResolution) {
    await ensureContextEnginesInitialized();
  }
  let pluginRegistry: PluginRegistry | undefined;
  let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
  let engine: ContextEngine | undefined;
  let outcome: { ok: true; result: ContextEngineInfoResult } | { ok: false; error: unknown };
  try {
    let inspectionWarning: string | undefined;
    if (getContextEngineRegistration(engineId)?.lifecycle !== "runtime") {
      try {
        inspection = await acquirePluginRegistryForInspection({
          config: params.cfg,
          env: params.env,
          onlyPluginIds: [engineId],
        });
        pluginRegistry = inspection.registry;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        inspectionWarning = `- plugins.slots.contextEngine: could not inspect context engine "${engineId}" host requirements because its plugin failed to load: ${message}`;
      }
      if (pluginRegistry) {
        const registration = pluginRegistry.contextEngines.get(engineId);
        if (registration?.lifecycle === "readOnlyDiscovery") {
          inspectionWarning = `- plugins.slots.contextEngine: context engine "${engineId}" is registered for read-only discovery; offline host compatibility inspection is unavailable. This does not indicate a missing runtime registration in the Gateway.`;
        } else if (registration?.lifecycle !== "runtime") {
          inspectionWarning = `- plugins.slots.contextEngine: could not inspect context engine "${engineId}" host requirements because it is not registered.`;
        }
      }
    }
    if (inspectionWarning) {
      outcome = { ok: true, result: { warnings: [inspectionWarning] } };
    } else {
      const agentId = resolveAmbientOwnerAgentId(params.cfg, undefined, {
        surface: "context-engine Doctor checks",
        hint: "Set agents.defaults.systemAgent.agentId before running Doctor.",
      });
      const resolve = () =>
        resolveContextEngine(params.cfg, {
          initialize: initializeDuringResolution ? ensureContextEnginesInitialized : undefined,
          agentDir: resolveAgentDir(params.cfg, agentId, params.env),
          workspaceDir: params.cfg.agents?.defaults?.workspace
            ? resolveUserPath(params.cfg.agents.defaults.workspace, params.env)
            : undefined,
        });
      engine = await withPluginRuntimeRegistryScope(pluginRegistry, resolve);
      const info = engine.info;
      const requirements = info.hostRequirements?.["agent-run"];
      outcome = {
        ok: true,
        result: {
          info: {
            id: info.id,
            name: info.name,
            hostRequirements: requirements
              ? {
                  "agent-run": {
                    requiredCapabilities: [...requirements.requiredCapabilities],
                    unsupportedMessage: requirements.unsupportedMessage,
                  },
                }
              : undefined,
          },
          warnings: [],
        },
      };
    }
  } catch (error) {
    outcome = { ok: false, error };
  }
  // The engine's final work must finish before its inspection can retire.
  for (const cleanup of [() => engine?.dispose?.(), () => inspection?.release()]) {
    try {
      await cleanup();
    } catch (error) {
      if (outcome.ok) {
        outcome = { ok: false, error };
      }
    }
  }
  if (!outcome.ok) {
    const { error } = outcome;
    const message = error instanceof Error ? error.message : String(error);
    return {
      warnings: [
        `- plugins.slots.contextEngine: could not inspect context engine "${engineId}" host requirements: ${message}`,
      ],
    };
  }
  return outcome.result;
}

function collectHostCompatibilityWarnings(
  info: ContextEngineInfo,
  hosts: HostCandidate[],
): string[] {
  return hosts.flatMap((candidate) => {
    const evaluation = evaluateContextEngineHostSupport({
      contextEngineInfo: info,
      operation: "agent-run",
      host: candidate.host,
    });
    return evaluation.ok
      ? []
      : [
          `- plugins.slots.contextEngine: context engine "${info.id}" is incompatible with ` +
            `${candidate.host.label} (${formatPaths(candidate.paths)}). ` +
            `Missing host capabilities: ${evaluation.missingCapabilities.join(", ")}. ` +
            `Required capabilities: ${evaluation.requirements.requiredCapabilities.join(", ")}. ` +
            `Host capabilities: ${formatHostCapabilities(candidate.host.capabilities)}.`,
        ];
  });
}

function formatPaths(paths: string[]): string {
  const unique = uniqueStrings(paths);
  if (unique.length <= 2) {
    return unique.join(", ");
  }
  return `${unique.slice(0, 2).join(", ")}, and ${unique.length - 2} more`;
}

function formatHostCapabilities(capabilities: readonly string[]): string {
  return capabilities.length > 0 ? capabilities.join(", ") : "(none)";
}

type ContextEngineDoctorParams = {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
};

async function inspectContextEngineHostCompatibility(params: ContextEngineDoctorParams) {
  const resolved = await resolveSelectedContextEngineInfo(params);
  if (!resolved.info) {
    return { ...resolved, compatibilityWarnings: [], incompatibleAllHosts: false };
  }
  const hosts = collectConfiguredContextEngineAgentRunHosts(params.cfg);
  const issues = collectHostCompatibilityWarnings(resolved.info, hosts);
  const incompatibleAllHosts = issues.length > 0 && issues.length === hosts.length;
  if (issues.length > 0) {
    issues.push(
      incompatibleAllHosts
        ? `- Run "${params.doctorFixCommand}" to remove the plugins.slots.contextEngine override and restore the default "legacy", or configure a compatible runtime/harness for agent runs.`
        : `- Some configured runtimes support context engine "${resolved.info.id}" and others do not; doctor will not rewrite the global contextEngine slot automatically. Configure unsupported models to use a compatible runtime/harness or set plugins.slots.contextEngine to "legacy".`,
    );
  }
  return {
    ...resolved,
    compatibilityWarnings: issues.length ? [issues.join("\n")] : [],
    incompatibleAllHosts,
  };
}

/** Collect doctor warnings for context engines that cannot run under configured hosts. */
export async function collectContextEngineHostCompatibilityWarnings(
  params: ContextEngineDoctorParams,
): Promise<string[]> {
  const resolved = await inspectContextEngineHostCompatibility(params);
  return [...resolved.warnings, ...resolved.compatibilityWarnings];
}

/** Repair a globally incompatible context engine by falling back to legacy. */
export async function maybeRepairContextEngineHostCompatibility(
  params: ContextEngineDoctorParams,
): Promise<{ config: OpenClawConfig; changes: string[]; warnings?: string[] }> {
  const resolved = await inspectContextEngineHostCompatibility(params);
  if (!resolved.info || !resolved.incompatibleAllHosts) {
    return {
      config: params.cfg,
      changes: [],
      warnings: [...resolved.warnings, ...resolved.compatibilityWarnings],
    };
  }

  const next = structuredClone(params.cfg);
  const slots = next.plugins?.slots;
  if (slots) {
    delete slots.contextEngine;
    if (Object.keys(slots).length === 0) {
      delete next.plugins?.slots;
    }
  }
  return {
    config: next,
    changes: [
      `Reset plugins.slots.contextEngine to the default "legacy" because context engine "${resolved.info.id}" is incompatible with every configured agent-run host.`,
    ],
    warnings: resolved.warnings,
  };
}
