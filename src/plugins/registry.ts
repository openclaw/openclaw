import path from "node:path";
import {
  getRegisteredAgentHarness,
  registerAgentHarness as registerGlobalAgentHarness,
} from "../agents/harness/registry.js";
import type { AgentHarness } from "../agents/harness/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import {
  normalizeCommandDescriptorName,
  sanitizeCommandDescriptorDescription,
} from "../cli/program/command-descriptor-utils.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearContextEnginesForOwner,
  registerContextEngineForOwner,
} from "../context-engine/registry.js";
import { createPluginGatewayMethodDescriptor } from "../gateway/methods/registry.js";
import { isOperatorScope, type OperatorScope } from "../gateway/operator-scopes.js";
import type { GatewayRequestHandler, RespondFn } from "../gateway/server-methods/types.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import type { HookEntry } from "../hooks/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_SYSTEM_NOTIFY_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
} from "../infra/node-commands.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  type OpenKeyedStoreOptions,
  type PluginStateKeyedStore,
  type PluginStateSyncKeyedStore,
} from "../plugin-state/plugin-state-store.js";
import { normalizePluginGatewayMethodScope } from "../shared/gateway-method-policy.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { uniqueValues } from "../shared/string-normalization.js";
import {
  normalizeStringEntries,
  normalizeUniqueStringEntries,
} from "../shared/string-normalization.js";
import {
  getDetachedTaskLifecycleRuntimeRegistration,
  registerDetachedTaskLifecycleRuntime,
} from "../tasks/detached-task-runtime-state.js";
import { resolveUserPath } from "../utils.js";
import { emitPluginAgentEvent } from "./agent-event-emission.js";
import type { AgentToolResultMiddleware } from "./agent-tool-result-middleware-types.js";
import {
  normalizeAgentToolResultMiddlewareRuntimeIds,
  normalizeAgentToolResultMiddlewareRuntimes,
} from "./agent-tool-result-middleware.js";
import { buildPluginApi } from "./api-builder.js";
import { normalizeRegisteredChannelPlugin } from "./channel-validation.js";
import { CODEX_APP_SERVER_EXTENSION_RUNTIME_ID } from "./codex-app-server-extension-factory.js";
import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import {
  isReservedCommandName,
  registerPluginCommand,
  validatePluginCommandDefinition,
} from "./command-registration.js";
import { clearPluginCommandsForPlugin, pluginCommands } from "./command-registry-state.js";
import {
  getRegisteredCompactionProvider,
  registerCompactionProvider,
} from "./compaction-provider.js";
import { getPluginCompatRecord } from "./compat/registry.js";
import {
  getRegisteredEmbeddingProvider,
  registerEmbeddingProvider,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";
import { sendPluginSessionAttachment } from "./host-hook-attachments.js";
import {
  clearPluginRunContext,
  getPluginRunContext,
  getPluginSessionSchedulerJobGeneration,
  registerPluginSessionSchedulerJob,
  setPluginRunContext,
} from "./host-hook-runtime.js";
import {
  schedulePluginSessionTurn,
  unschedulePluginSessionTurnsByTag,
} from "./host-hook-scheduled-turns.js";
import { enqueuePluginNextTurnInjection } from "./host-hook-state.js";
import {
  isPluginJsonValue,
  normalizePluginHostHookId,
  type PluginAgentEventSubscriptionRegistration,
  type PluginControlUiDescriptor,
  type PluginRuntimeLifecycleRegistration,
  type PluginSessionActionRegistration,
  type PluginSessionSchedulerJobRegistration,
  type PluginSessionExtensionRegistration,
  type PluginToolMetadataRegistration,
  type PluginTrustedToolPolicyRegistration,
} from "./host-hooks.js";
import { normalizePluginHttpPath } from "./http-path.js";
import { findOverlappingPluginHttpRoute } from "./http-route-overlap.js";
import {
  clearPluginInteractiveHandlersForPlugin,
  registerPluginInteractiveHandler,
} from "./interactive-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import {
  getRegisteredMemoryEmbeddingProvider,
  registerMemoryEmbeddingProvider,
} from "./memory-embedding-providers.js";
import {
  registerMemoryCapability,
  registerMemoryCorpusSupplement,
  registerMemoryFlushPlanResolverForPlugin,
  registerMemoryPromptSupplement,
  registerMemoryPromptSectionForPlugin,
  registerMemoryRuntimeForPlugin,
} from "./memory-state.js";
import { createModelCatalogRegistrationHandlers } from "./model-catalog-registration.js";
import { normalizeRegisteredProvider } from "./provider-validation.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { isPluginRegistryActivated, isPluginRegistryRetired } from "./registry-lifecycle.js";
import type {
  PluginHttpRouteRegistration as RegistryTypesPluginHttpRouteRegistration,
  PluginRecord,
  PluginRegistryParams,
  PluginSessionActionRegistryRegistration,
  PluginTextTransformsRegistration,
} from "./registry-types.js";
export type {
  PluginReloadRegistration,
  PluginRuntimeLifecycleRegistryRegistration,
  PluginSecurityAuditCollectorRegistration,
  PluginServiceRegistration,
  PluginSessionExtensionRegistryRegistration,
} from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import {
  withPluginRuntimePluginIdScope,
  withPluginRuntimePluginScope,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import { validateJsonSchemaValue, type JsonSchemaValue } from "./schema-validator.js";
import { normalizeSessionEntrySlotKey } from "./session-entry-slot-keys.js";
import { defaultSlotIdForKey, hasKind } from "./slots.js";
import {
  findUndeclaredPluginToolNames,
  normalizePluginToolContractNames,
  normalizePluginToolNames,
} from "./tool-contracts.js";
import {
  isConversationHookName,
  isPluginHookName,
  isPromptInjectionHookName,
  stripPromptMutationFieldsFromLegacyHookResult,
} from "./types.js";
import type {
  CliBackendPlugin,
  ImageGenerationProviderPlugin,
  MusicGenerationProviderPlugin,
  OpenClawPluginApi,
  OpenClawPluginChannelRegistration,
  OpenClawPluginCliCommandDescriptor,
  OpenClawPluginCliRegistrar,
  OpenClawPluginCommandDefinition,
  PluginConversationBindingResolvedEvent,
  OpenClawPluginGatewayRuntimeScopeSurface,
  OpenClawGatewayDiscoveryService,
  OpenClawPluginHostedMediaResolver,
  OpenClawPluginHttpRouteParams,
  OpenClawPluginHookOptions,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginReloadRegistration,
  OpenClawPluginSecurityAuditCollector,
  MediaUnderstandingProviderPlugin,
  TranscriptSourceProvider,
  MigrationProviderPlugin,
  OpenClawPluginService,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  PluginHookHandlerMap,
  PluginHookName,
  PluginHookRegistration as TypedPluginHookRegistration,
  PluginLogger,
  PluginRegistrationMode,
  ProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  VideoGenerationProviderPlugin,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
} from "./types.js";

export type PluginHttpRouteRegistration = RegistryTypesPluginHttpRouteRegistration & {
  gatewayRuntimeScopeSurface?: OpenClawPluginGatewayRuntimeScopeSurface;
};

const GATEWAY_METHOD_DISPATCH_CONTRACT = "authenticated-request";
const LEGACY_DEACTIVATE_HOOK_ALIAS_COMPAT = getPluginCompatRecord("legacy-deactivate-hook-alias");

function formatLegacyDeactivateHookAliasDiagnostic(): string {
  const removeAfter =
    LEGACY_DEACTIVATE_HOOK_ALIAS_COMPAT.removeAfter ?? "a future breaking release";
  return (
    `typed hook "deactivate" is deprecated (${LEGACY_DEACTIVATE_HOOK_ALIAS_COMPAT.code}); ` +
    `use "gateway_stop". This compatibility alias will be removed after ${removeAfter}.`
  );
}

type PluginOwnedProviderRegistration<T extends { id: string }> = {
  pluginId: string;
  pluginName?: string;
  provider: T;
  source: string;
  rootDir?: string;
};

function readStaticPluginToolName(tool: AnyAgentTool): string | undefined {
  try {
    const name = tool.name;
    return typeof name === "string" && name.trim().length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function withStaticPluginToolName(tool: AnyAgentTool, name: string): AnyAgentTool {
  return new Proxy(tool, {
    get(target, property, receiver) {
      if (property === "name") {
        return name;
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export type {
  PluginChannelRegistration,
  PluginChannelSetupRegistration,
  PluginCliBackendRegistration,
  PluginCliRegistration,
  PluginCommandRegistration,
  PluginConversationBindingResolvedHandlerRegistration,
  PluginHookRegistration,
  PluginAgentHarnessRegistration,
  PluginMemoryEmbeddingProviderRegistration,
  PluginNodeHostCommandRegistration,
  PluginProviderRegistration,
  PluginControlUiDescriptorRegistryRegistration,
  PluginHostedMediaResolverRegistration,
  PluginRecord,
  PluginRegistry,
  PluginRegistryParams,
  PluginTextTransformsRegistration,
  PluginToolMetadataRegistryRegistration,
  PluginTrustedToolPolicyRegistryRegistration,
  PluginToolRegistration,
  PluginSpeechProviderRegistration,
  PluginRealtimeTranscriptionProviderRegistration,
  PluginRealtimeVoiceProviderRegistration,
  PluginMediaUnderstandingProviderRegistration,
  PluginImageGenerationProviderRegistration,
  PluginVideoGenerationProviderRegistration,
  PluginMusicGenerationProviderRegistration,
  PluginWebFetchProviderRegistration,
  PluginWebSearchProviderRegistration,
} from "./registry-types.js";

type PluginTypedHookPolicy = {
  allowPromptInjection?: boolean;
  allowConversationAccess?: boolean;
  timeoutMs?: number;
  timeouts?: Record<string, number>;
};

function normalizeHookTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveTypedHookTimeoutMs(params: {
  hookName: PluginHookName;
  opts?: { timeoutMs?: number };
  policy?: PluginTypedHookPolicy;
}): number | undefined {
  return (
    normalizeHookTimeoutMs(params.policy?.timeouts?.[params.hookName]) ??
    normalizeHookTimeoutMs(params.policy?.timeoutMs) ??
    normalizeHookTimeoutMs(params.opts?.timeoutMs)
  );
}

const constrainLegacyPromptInjectionHook = (
  handler: PluginHookHandlerMap["before_agent_start"],
): PluginHookHandlerMap["before_agent_start"] => {
  return (event, ctx) => {
    const result = handler(event, ctx);
    if (result && typeof result === "object" && "then" in result) {
      return Promise.resolve(result).then((resolved) =>
        stripPromptMutationFieldsFromLegacyHookResult(resolved),
      );
    }
    return stripPromptMutationFieldsFromLegacyHookResult(result);
  };
};

export { createEmptyPluginRegistry } from "./registry-empty.js";

export function resolvePluginPath(input: string, rootDir: string | undefined): string {
  const trimmed = input.trim();
  if (!trimmed || path.isAbsolute(trimmed) || trimmed.startsWith("~")) {
    return resolveUserPath(input);
  }
  return rootDir ? path.resolve(rootDir, trimmed) : resolveUserPath(input);
}

function isOfficialCodexPluginRecord(
  record: Pick<PluginRecord, "id" | "origin" | "packageName" | "rootDir" | "source">,
) {
  if (record.id !== "codex") {
    return false;
  }
  if (record.origin !== "global") {
    return false;
  }
  if (record.packageName === "@openclaw/codex") {
    return true;
  }
  const sourcePath = path
    .normalize(record.rootDir ?? record.source)
    .split(path.sep)
    .join("/");
  return sourcePath.includes("/node_modules/@openclaw/codex");
}

function canClaimReservedCommandOwnership(
  record: Pick<PluginRecord, "id" | "origin" | "packageName" | "rootDir" | "source">,
) {
  return record.origin === "bundled" || isOfficialCodexPluginRecord(record);
}

const ACTIVE_PLUGIN_HOOK_REGISTRATIONS_KEY = Symbol.for("openclaw.activePluginHookRegistrations");
const activePluginHookRegistrations = resolveGlobalSingleton<
  Map<string, Array<{ event: string; handler: Parameters<typeof registerInternalHook>[1] }>>
>(ACTIVE_PLUGIN_HOOK_REGISTRATIONS_KEY, () => new Map());

type HookRegistration = { event: string; handler: Parameters<typeof registerInternalHook>[1] };
type HookRollbackEntry = { name: string; previousRegistrations: HookRegistration[] };
type PluginSideEffectGuard = {
  active: boolean;
};

type PluginRegistrationCapabilities = {
  /** Broad registry writes that discovery and live activation both need. */
  capabilityHandlers: boolean;
  /** Setup-runtime may publish pre-listen gateway surfaces without full activation. */
  setupRuntimeHandlers: boolean;
  /** Runtime channel registration is suppressed for setup-only and tool discovery loads. */
  runtimeChannel: boolean;
};

/**
 * Keep mode decoding centralized. PluginRegistrationMode is the public label;
 * registry code should consume these booleans instead of duplicating string
 * checks across individual registration handlers.
 */
function resolvePluginRegistrationCapabilities(
  mode: PluginRegistrationMode,
): PluginRegistrationCapabilities {
  const capabilityHandlers = mode === "full" || mode === "discovery" || mode === "tool-discovery";
  return {
    capabilityHandlers,
    setupRuntimeHandlers: mode === "setup-runtime",
    runtimeChannel: mode !== "setup-only" && mode !== "tool-discovery",
  };
}

function adaptPluginGatewayMethodHandler(handler: GatewayRequestHandler): GatewayRequestHandler {
  return async (opts) => {
    let responded = false;
    const respond: RespondFn = (ok, payload, error, meta) => {
      responded = true;
      opts.respond(ok, payload, error, meta);
    };
    const result = (await handler({ ...opts, respond })) as unknown;
    if (!responded && result !== undefined) {
      respond(true, result);
    }
  };
}

export function createPluginRegistry(registryParams: PluginRegistryParams) {
  const registry = createEmptyPluginRegistry();
  const coreGatewayMethodNames = Array.from(
    new Set([
      ...(registryParams.coreGatewayMethodNames ?? []),
      ...Object.keys(registryParams.coreGatewayHandlers ?? {}),
    ]),
  ).toSorted();
  registry.coreGatewayMethodNames = coreGatewayMethodNames;
  const coreGatewayMethods = new Set(coreGatewayMethodNames);
  const getHostCronService = () => registryParams.hostServices?.cron;
  const pluginHookRollback = new Map<string, HookRollbackEntry[]>();
  const pluginsWithChannelRegistrationConflict = new Set<string>();
  const pluginSideEffectGuards = new Map<string, Set<PluginSideEffectGuard>>();

  const pushDiagnostic = (diag: PluginDiagnostic) => {
    registry.diagnostics.push(diag);
  };
  const {
    registerModelCatalogProvider,
    registerSynthesizedTextModelCatalogProvider,
    registerSynthesizedMediaModelCatalogProvider,
    registerSynthesizedVoiceModelCatalogProvider,
  } = createModelCatalogRegistrationHandlers({
    registry,
    pushDiagnostic,
  });

  const throwRegistrationError = (message: string): never => {
    throw new Error(message);
  };

  const requireRegistrationValue = (value: string | undefined, message: string): string => {
    if (!value) {
      throw new Error(message);
    }
    return value;
  };

  const createPluginSideEffectGuard = (pluginId: string): PluginSideEffectGuard => {
    const guard = { active: true };
    const guards = pluginSideEffectGuards.get(pluginId) ?? new Set<PluginSideEffectGuard>();
    guards.add(guard);
    pluginSideEffectGuards.set(pluginId, guards);
    return guard;
  };

  const deactivatePluginSideEffectGuards = (pluginId: string): void => {
    const guards = pluginSideEffectGuards.get(pluginId);
    if (!guards) {
      return;
    }
    for (const guard of guards) {
      guard.active = false;
    }
    pluginSideEffectGuards.delete(pluginId);
  };

  const registerCodexAppServerExtensionFactory = (
    record: PluginRecord,
    factory: Parameters<OpenClawPluginApi["registerCodexAppServerExtensionFactory"]>[0],
  ) => {
    if (record.origin !== "bundled") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "only bundled plugins can register Codex app-server extension factories",
      });
      return;
    }
    if (
      !(record.contracts?.embeddedExtensionFactories ?? []).includes(
        CODEX_APP_SERVER_EXTENSION_RUNTIME_ID,
      )
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          'plugin must declare contracts.embeddedExtensionFactories: ["codex-app-server"] to register Codex app-server extension factories',
      });
      return;
    }
    if (typeof (factory as unknown) !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "codex app-server extension factory must be a function",
      });
      return;
    }
    if (
      registry.codexAppServerExtensionFactories.some(
        (entry) => entry.pluginId === record.id && entry.rawFactory === factory,
      )
    ) {
      return;
    }
    const safeFactory: CodexAppServerExtensionFactory = async (codex) => {
      try {
        await factory(codex);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        registryParams.logger.warn(
          `[plugins] codex app-server extension factory failed for ${record.id}: ${detail}`,
        );
      }
    };
    registry.codexAppServerExtensionFactories.push({
      pluginId: record.id,
      pluginName: record.name,
      rawFactory: factory,
      factory: safeFactory,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerAgentToolResultMiddleware = (
    record: PluginRecord,
    handler: Parameters<OpenClawPluginApi["registerAgentToolResultMiddleware"]>[0],
    options: Parameters<OpenClawPluginApi["registerAgentToolResultMiddleware"]>[1],
  ) => {
    if (record.origin !== "bundled") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "only bundled plugins can register agent tool result middleware",
      });
      return;
    }
    if (typeof (handler as unknown) !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "agent tool result middleware must be a function",
      });
      return;
    }
    const runtimes = normalizeAgentToolResultMiddlewareRuntimes(options);
    if (runtimes.length === 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "agent tool result middleware must target at least one supported runtime",
      });
      return;
    }
    const declared = normalizeAgentToolResultMiddlewareRuntimeIds(
      record.contracts?.agentToolResultMiddleware,
    );
    const missing = runtimes.filter((runtime) => !declared.includes(runtime));
    if (missing.length > 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must declare contracts.agentToolResultMiddleware for: ${missing.join(", ")}`,
      });
      return;
    }
    const existing = registry.agentToolResultMiddlewares.find(
      (entry) => entry.pluginId === record.id && entry.rawHandler === handler,
    );
    if (existing) {
      existing.runtimes = uniqueValues([...existing.runtimes, ...runtimes]);
      return;
    }
    const safeHandler: AgentToolResultMiddleware = async (event, ctx) => {
      try {
        return await handler(event, ctx);
      } catch (error) {
        registryParams.logger.warn(
          `[plugins] agent tool result middleware failed for ${record.id}`,
        );
        throw error;
      }
    };
    registry.agentToolResultMiddlewares.push({
      pluginId: record.id,
      pluginName: record.name,
      rawHandler: handler,
      handler: safeHandler,
      runtimes,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerTool = (
    record: PluginRecord,
    tool: AnyAgentTool | OpenClawPluginToolFactory,
    opts?: { name?: string; names?: string[]; optional?: boolean },
  ) => {
    if (pluginsWithChannelRegistrationConflict.has(record.id)) {
      return;
    }
    const declaredNames = normalizePluginToolContractNames(record.contracts);
    if (declaredNames.length === 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "plugin must declare contracts.tools before registering agent tools",
      });
      return;
    }
    const names = [...(opts?.names ?? []), ...(opts?.name ? [opts.name] : [])];
    const optional = opts?.optional === true;
    let overrideStaticToolName = false;

    if (typeof tool !== "function") {
      const toolName = readStaticPluginToolName(tool);
      if (toolName) {
        names.push(toolName);
      } else {
        overrideStaticToolName = true;
      }
    }

    const normalized = normalizePluginToolNames(names);
    if (overrideStaticToolName && normalized.length === 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "plugin tool registration missing readable tool name",
      });
      return;
    }
    const factory: OpenClawPluginToolFactory =
      typeof tool === "function"
        ? tool
        : (_ctx: OpenClawPluginToolContext) => {
            const staticName = overrideStaticToolName ? normalized[0] : undefined;
            if (staticName) {
              return withStaticPluginToolName(tool, staticName);
            }
            return tool;
          };
    const undeclared = findUndeclaredPluginToolNames({
      declaredNames,
      toolNames: normalized,
    });
    if (undeclared.length > 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must declare contracts.tools for: ${undeclared.join(", ")}`,
      });
      return;
    }
    if (normalized.length > 0) {
      record.toolNames.push(...normalized);
    }
    registry.tools.push({
      pluginId: record.id,
      pluginName: record.name,
      factory,
      names: normalized,
      declaredNames,
      optional,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerHook = (
    record: PluginRecord,
    events: string | string[],
    handler: Parameters<typeof registerInternalHook>[1],
    opts: OpenClawPluginHookOptions | undefined,
    config: OpenClawPluginApi["config"],
    pluginConfig: unknown,
  ) => {
    const normalizedEvents = normalizeStringEntries(Array.isArray(events) ? events : [events]);
    const entry = opts?.entry ?? null;
    const hookName = requireRegistrationValue(
      entry?.hook.name ?? opts?.name?.trim(),
      "hook registration missing name",
    );
    const existingHook = registry.hooks.find((entry) => entry.entry.hook.name === hookName);
    if (existingHook) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `hook already registered: ${hookName} (${existingHook.pluginId})`,
      });
      return;
    }

    const description = entry?.hook.description ?? opts?.description ?? "";
    const hookEntry: HookEntry = entry
      ? {
          ...entry,
          hook: {
            ...entry.hook,
            name: hookName,
            description,
            source: "openclaw-plugin",
            pluginId: record.id,
          },
          metadata: {
            ...entry.metadata,
            events: normalizedEvents,
          },
        }
      : {
          hook: {
            name: hookName,
            description,
            source: "openclaw-plugin",
            pluginId: record.id,
            filePath: record.source,
            baseDir: path.dirname(record.source),
            handlerPath: record.source,
          },
          frontmatter: {},
          metadata: { events: normalizedEvents },
          invocation: { enabled: true },
        };

    record.hookNames.push(hookName);
    registry.hooks.push({
      pluginId: record.id,
      entry: hookEntry,
      events: normalizedEvents,
      source: record.source,
    });

    const hookSystemEnabled = config?.hooks?.internal?.enabled !== false;
    if (
      !registryParams.activateGlobalSideEffects ||
      !hookSystemEnabled ||
      opts?.register === false
    ) {
      return;
    }

    const previousRegistrations = activePluginHookRegistrations.get(hookName) ?? [];
    for (const registration of previousRegistrations) {
      unregisterInternalHook(registration.event, registration.handler);
    }

    const nextRegistrations: Array<{
      event: string;
      handler: Parameters<typeof registerInternalHook>[1];
    }> = [];
    for (const event of normalizedEvents) {
      const wrappedHandler: typeof handler = async (evt) => {
        // Shallow-copy to avoid mutating the shared event object
        // passed to all handlers sequentially by triggerInternalHook
        return handler({ ...evt, context: { ...evt.context, pluginConfig } });
      };
      registerInternalHook(event, wrappedHandler);
      nextRegistrations.push({ event, handler: wrappedHandler });
    }
    activePluginHookRegistrations.set(hookName, nextRegistrations);
    const rollbackEntries = pluginHookRollback.get(record.id) ?? [];
    rollbackEntries.push({
      name: hookName,
      previousRegistrations: [...previousRegistrations],
    });
    pluginHookRollback.set(record.id, rollbackEntries);
  };

  const registerGatewayMethod = (
    record: PluginRecord,
    method: string,
    handler: GatewayRequestHandler,
    opts?: { scope?: OperatorScope },
  ) => {
    const trimmed = method.trim();
    if (!trimmed) {
      return;
    }
    if (coreGatewayMethods.has(trimmed) || registry.gatewayHandlers[trimmed]) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `gateway method already registered: ${trimmed}`,
      });
      return;
    }
    const wrappedHandler = adaptPluginGatewayMethodHandler(handler);
    registry.gatewayHandlers[trimmed] = wrappedHandler;
    const normalizedScope = normalizePluginGatewayMethodScope(trimmed, opts?.scope);
    if (normalizedScope.coercedToReservedAdmin) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `gateway method scope coerced to operator.admin for reserved core namespace: ${trimmed}`,
      });
    }
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: record.id,
        name: trimmed,
        handler: wrappedHandler,
        scope: normalizedScope.scope,
      }),
    );
  };

  const describeHttpRouteOwner = (entry: PluginHttpRouteRegistration): string => {
    const plugin = normalizeOptionalString(entry.pluginId) || "unknown-plugin";
    const source = normalizeOptionalString(entry.source) || "unknown-source";
    return `${plugin} (${source})`;
  };

  const canDispatchGatewayMethodsFromHttpRoute = (record: PluginRecord): boolean =>
    (record.contracts?.gatewayMethodDispatch ?? []).includes(GATEWAY_METHOD_DISPATCH_CONTRACT);

  function normalizeHttpRouteNodeCapability(
    value: unknown,
  ):
    | { ok: true; value?: NonNullable<PluginHttpRouteRegistration["nodeCapability"]> }
    | { ok: false; field: string } {
    if (!value || typeof value !== "object") {
      return { ok: true };
    }
    const surfaceValue = readHostHookField(value, "surface");
    const ttlMsValue = readHostHookField(value, "ttlMs");
    if (!surfaceValue.ok) {
      return { ok: false, field: "nodeCapability.surface" };
    }
    if (!ttlMsValue.ok) {
      return { ok: false, field: "nodeCapability.ttlMs" };
    }
    const surface = normalizeOptionalString(surfaceValue.value);
    if (!surface) {
      return { ok: true };
    }
    const ttlMs = ttlMsValue.value;
    return {
      ok: true,
      value: {
        surface,
        ...(typeof ttlMs === "number" && Number.isFinite(ttlMs) ? { ttlMs } : {}),
      },
    };
  }

  const registerHttpRoute = (record: PluginRecord, params: OpenClawPluginHttpRouteParams) => {
    const pathValue = readHostHookField(params, "path");
    const handlerValue = readHostHookField(params, "handler");
    const handleUpgradeValue = readHostHookField(params, "handleUpgrade");
    const authValue = readHostHookField(params, "auth");
    const matchValue = readHostHookField(params, "match");
    const gatewayRuntimeScopeSurfaceValue = readHostHookField(params, "gatewayRuntimeScopeSurface");
    const nodeCapabilityValue = readHostHookField(params, "nodeCapability");
    const replaceExistingValue = readHostHookField(params, "replaceExisting");
    const pushUnreadableDiagnostic = (field: string) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `http route registration has unreadable field: ${field}`,
      });
    };
    if (!pathValue.ok) {
      pushUnreadableDiagnostic("path");
      return;
    }
    if (!handlerValue.ok) {
      pushUnreadableDiagnostic("handler");
      return;
    }
    if (!handleUpgradeValue.ok) {
      pushUnreadableDiagnostic("handleUpgrade");
      return;
    }
    if (!authValue.ok) {
      pushUnreadableDiagnostic("auth");
      return;
    }
    if (!matchValue.ok) {
      pushUnreadableDiagnostic("match");
      return;
    }
    if (!gatewayRuntimeScopeSurfaceValue.ok) {
      pushUnreadableDiagnostic("gatewayRuntimeScopeSurface");
      return;
    }
    if (!nodeCapabilityValue.ok) {
      pushUnreadableDiagnostic("nodeCapability");
      return;
    }
    if (!replaceExistingValue.ok) {
      pushUnreadableDiagnostic("replaceExisting");
      return;
    }

    const normalizedPath = normalizePluginHttpPath(
      typeof pathValue.value === "string" ? pathValue.value : undefined,
    );
    if (!normalizedPath) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "http route registration missing path",
      });
      return;
    }
    const auth = authValue.value;
    if (auth !== "gateway" && auth !== "plugin") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `http route registration missing or invalid auth: ${normalizedPath}`,
      });
      return;
    }
    if (typeof handlerValue.value !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `http route registration missing or invalid handler: ${normalizedPath}`,
      });
      return;
    }
    const handler = handlerValue.value as OpenClawPluginHttpRouteParams["handler"];
    const match = matchValue.value === "prefix" ? "prefix" : "exact";
    const handleUpgrade =
      typeof handleUpgradeValue.value === "function"
        ? (handleUpgradeValue.value as NonNullable<OpenClawPluginHttpRouteParams["handleUpgrade"]>)
        : undefined;
    const gatewayRuntimeScopeSurface =
      gatewayRuntimeScopeSurfaceValue.value === "write-default" ||
      gatewayRuntimeScopeSurfaceValue.value === "trusted-operator"
        ? gatewayRuntimeScopeSurfaceValue.value
        : undefined;
    const nodeCapability = normalizeHttpRouteNodeCapability(nodeCapabilityValue.value);
    if (!nodeCapability.ok) {
      pushUnreadableDiagnostic(nodeCapability.field);
      return;
    }
    const routeEntry: PluginHttpRouteRegistration = {
      pluginId: record.id,
      path: normalizedPath,
      handler,
      ...(handleUpgrade ? { handleUpgrade } : {}),
      auth,
      match,
      ...(gatewayRuntimeScopeSurface ? { gatewayRuntimeScopeSurface } : {}),
      ...(canDispatchGatewayMethodsFromHttpRoute(record)
        ? { gatewayMethodDispatchAllowed: true }
        : {}),
      ...(nodeCapability.value ? { nodeCapability: nodeCapability.value } : {}),
      source: record.source,
    };
    const overlappingRoute = findOverlappingPluginHttpRoute(registry.httpRoutes, {
      path: normalizedPath,
      match,
    });
    if (overlappingRoute && overlappingRoute.auth !== auth) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          `http route overlap rejected: ${normalizedPath} (${match}, ${auth}) ` +
          `overlaps ${overlappingRoute.path} (${overlappingRoute.match}, ${overlappingRoute.auth}) ` +
          `owned by ${describeHttpRouteOwner(overlappingRoute)}`,
      });
      return;
    }
    const existingIndex = registry.httpRoutes.findIndex(
      (entry) => entry.path === normalizedPath && entry.match === match,
    );
    if (existingIndex >= 0) {
      const existing = registry.httpRoutes[existingIndex];
      if (!existing) {
        return;
      }
      if (replaceExistingValue.value !== true && existing.pluginId !== record.id) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `http route already registered: ${normalizedPath} (${match}) by ${describeHttpRouteOwner(existing)}`,
        });
        return;
      }
      if (existing.pluginId && existing.pluginId !== record.id) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `http route replacement rejected: ${normalizedPath} (${match}) owned by ${describeHttpRouteOwner(existing)}`,
        });
        return;
      }
      registry.httpRoutes[existingIndex] = routeEntry;
      return;
    }
    record.httpRoutes += 1;
    registry.httpRoutes.push(routeEntry);
  };

  const registerHostedMediaResolver = (
    record: PluginRecord,
    resolver: OpenClawPluginHostedMediaResolver,
  ) => {
    if (typeof resolver !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "hosted media resolver registration missing resolver",
      });
      return;
    }
    (registry.hostedMediaResolvers ??= []).push({
      pluginId: record.id,
      pluginName: record.name,
      resolver,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerChannel = (
    record: PluginRecord,
    registration: OpenClawPluginChannelRegistration | ChannelPlugin,
    mode: PluginRegistrationMode = "full",
  ) => {
    const registrationCapabilities = resolvePluginRegistrationCapabilities(mode);
    const normalized =
      typeof (registration as OpenClawPluginChannelRegistration).plugin === "object"
        ? (registration as OpenClawPluginChannelRegistration)
        : { plugin: registration as ChannelPlugin };
    const plugin = normalizeRegisteredChannelPlugin({
      pluginId: record.id,
      source: record.source,
      plugin: normalized.plugin,
      pushDiagnostic,
    });
    if (!plugin) {
      return;
    }
    const id = plugin.id;
    const existingRuntime = registry.channels.find((entry) => entry.plugin.id === id);
    if (registrationCapabilities.runtimeChannel && existingRuntime) {
      if (existingRuntime.pluginId === record.id) {
        existingRuntime.plugin = plugin;
        existingRuntime.pluginName = record.name;
        existingRuntime.source = record.source;
        existingRuntime.rootDir = record.rootDir;
        const existingSetup = registry.channelSetups.find((entry) => entry.plugin.id === id);
        if (existingSetup) {
          existingSetup.plugin = plugin;
          existingSetup.pluginName = record.name;
          existingSetup.source = record.source;
          existingSetup.enabled = record.enabled;
          existingSetup.rootDir = record.rootDir;
        }
        return;
      }
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `channel already registered: ${id} (${existingRuntime.pluginId})`,
      });
      pluginsWithChannelRegistrationConflict.add(record.id);
      return;
    }
    const existingSetup = registry.channelSetups.find((entry) => entry.plugin.id === id);
    if (existingSetup) {
      if (existingSetup.pluginId === record.id) {
        existingSetup.plugin = plugin;
        existingSetup.pluginName = record.name;
        existingSetup.source = record.source;
        existingSetup.enabled = record.enabled;
        existingSetup.rootDir = record.rootDir;
        return;
      }
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `channel setup already registered: ${id} (${existingSetup.pluginId})`,
      });
      pluginsWithChannelRegistrationConflict.add(record.id);
      return;
    }
    if (!record.channelIds.includes(id)) {
      record.channelIds.push(id);
    }
    registry.channelSetups.push({
      pluginId: record.id,
      pluginName: record.name,
      plugin,
      source: record.source,
      enabled: record.enabled,
      rootDir: record.rootDir,
    });
    if (!registrationCapabilities.runtimeChannel) {
      return;
    }
    registry.channels.push({
      pluginId: record.id,
      pluginName: record.name,
      plugin,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerProvider = (record: PluginRecord, provider: ProviderPlugin) => {
    const normalizedProvider = normalizeRegisteredProvider({
      pluginId: record.id,
      source: record.source,
      provider,
      pushDiagnostic,
    });
    if (!normalizedProvider) {
      return;
    }
    const id = normalizedProvider.id;
    const existing = registry.providers.find((entry) => entry.provider.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `provider already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    if (!record.providerIds.includes(id)) {
      record.providerIds.push(id);
    }
    registry.providers.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: normalizedProvider,
      source: record.source,
      rootDir: record.rootDir,
    });
    registerSynthesizedTextModelCatalogProvider({
      record,
      provider: normalizedProvider,
    });
  };

  const registerAgentHarness = (record: PluginRecord, harness: AgentHarness) => {
    const id = normalizeOptionalString((harness as Partial<AgentHarness> | undefined)?.id) ?? "";
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "agent harness registration missing id",
      });
      return;
    }
    if (typeof harness.supports !== "function" || typeof harness.runAttempt !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent harness "${id}" registration missing required runtime methods`,
      });
      return;
    }
    const existing =
      registryParams.activateGlobalSideEffects === false
        ? registry.agentHarnesses.find((entry) => entry.harness.id === id)
        : getRegisteredAgentHarness(id);
    if (existing) {
      const ownerPluginId =
        "ownerPluginId" in existing
          ? existing.ownerPluginId
          : "pluginId" in existing
            ? existing.pluginId
            : undefined;
      const ownerDetail = ownerPluginId ? ` (owner: ${ownerPluginId})` : "";
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent harness already registered: ${id}${ownerDetail}`,
      });
      return;
    }
    const normalizedHarness = {
      ...harness,
      id,
      pluginId: harness.pluginId ?? record.id,
    };
    if (registryParams.activateGlobalSideEffects !== false) {
      registerGlobalAgentHarness(normalizedHarness, { ownerPluginId: record.id });
    }
    record.agentHarnessIds.push(id);
    registry.agentHarnesses.push({
      pluginId: record.id,
      pluginName: record.name,
      harness: normalizedHarness,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerCliBackend = (record: PluginRecord, backend: CliBackendPlugin) => {
    const id = backend.id.trim();
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "cli backend registration missing id",
      });
      return;
    }
    const existing = (registry.cliBackends ?? []).find((entry) => entry.backend.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `cli backend already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    (registry.cliBackends ??= []).push({
      pluginId: record.id,
      pluginName: record.name,
      backend: {
        ...backend,
        id,
      },
      source: record.source,
      rootDir: record.rootDir,
    });
    record.cliBackendIds.push(id);
  };

  const registerTextTransforms = (
    record: PluginRecord,
    transforms: PluginTextTransformsRegistration["transforms"],
  ) => {
    if (
      (!transforms.input || transforms.input.length === 0) &&
      (!transforms.output || transforms.output.length === 0)
    ) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "text transform registration has no input or output replacements",
      });
      return;
    }
    registry.textTransforms.push({
      pluginId: record.id,
      pluginName: record.name,
      transforms,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerEmbeddingProviderForPlugin = (
    record: PluginRecord,
    adapter: EmbeddingProviderAdapter,
  ) => {
    const id = adapter.id.trim();
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "embedding provider registration missing id",
      });
      return;
    }
    if (!(record.contracts?.embeddingProviders ?? []).includes(id)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must declare contracts.embeddingProviders for adapter: ${id}`,
      });
      return;
    }
    const existing =
      registryParams.activateGlobalSideEffects === false
        ? registry.embeddingProviders.find((entry) => entry.provider.id === id)
        : getRegisteredEmbeddingProvider(id);
    if (existing) {
      const ownerPluginId =
        "ownerPluginId" in existing
          ? existing.ownerPluginId
          : "pluginId" in existing
            ? existing.pluginId
            : undefined;
      const ownerDetail = ownerPluginId ? ` (owner: ${ownerPluginId})` : "";
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `embedding provider already registered: ${id}${ownerDetail}`,
      });
      return;
    }
    if (registryParams.activateGlobalSideEffects !== false) {
      registerEmbeddingProvider(adapter, {
        ownerPluginId: record.id,
      });
    }
    registry.embeddingProviders.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: adapter,
      source: record.source,
      rootDir: record.rootDir,
    });
    if (!record.embeddingProviderIds.includes(id)) {
      record.embeddingProviderIds.push(id);
    }
  };

  const registerUniqueProviderLike = <T extends { id: string }>(params: {
    record: PluginRecord;
    provider: T;
    kindLabel: string;
    registrations: Array<PluginOwnedProviderRegistration<T>>;
    ownedIds: string[];
  }): boolean => {
    const { record, kindLabel } = params;
    const idValue = readHostHookField(params.provider, "id");
    if (!idValue.ok) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `${kindLabel} registration has unreadable field: id`,
      });
      return false;
    }
    const id = normalizeOptionalString(idValue.value) ?? "";
    const missingLabel = `${kindLabel} registration missing id`;
    const duplicateLabel = `${kindLabel} already registered: ${id}`;
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: missingLabel,
      });
      return false;
    }
    const existing = params.registrations.find((entry) => entry.provider.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `${duplicateLabel} (${existing.pluginId})`,
      });
      return false;
    }
    if (!params.ownedIds.includes(id)) {
      params.ownedIds.push(id);
    }
    params.registrations.push({
      pluginId: record.id,
      pluginName: record.name,
      provider: params.provider,
      source: record.source,
      rootDir: record.rootDir,
    });
    return true;
  };

  const registerSpeechProvider = (record: PluginRecord, provider: SpeechProviderPlugin) => {
    const registered = registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "speech provider",
      registrations: registry.speechProviders,
      ownedIds: record.speechProviderIds,
    });
    if (registered) {
      registerSynthesizedVoiceModelCatalogProvider({
        record,
        provider,
        capabilities: { tts: true },
        modes: ["tts"],
      });
    }
  };

  const registerRealtimeTranscriptionProvider = (
    record: PluginRecord,
    provider: RealtimeTranscriptionProviderPlugin,
  ) => {
    const registered = registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "realtime transcription provider",
      registrations: registry.realtimeTranscriptionProviders,
      ownedIds: record.realtimeTranscriptionProviderIds,
    });
    if (registered) {
      registerSynthesizedVoiceModelCatalogProvider({
        record,
        provider,
        capabilities: { realtime_transcription: true },
        modes: ["realtime_transcription"],
      });
    }
  };

  const registerRealtimeVoiceProvider = (
    record: PluginRecord,
    provider: RealtimeVoiceProviderPlugin,
  ) => {
    const registered = registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "realtime voice provider",
      registrations: registry.realtimeVoiceProviders,
      ownedIds: record.realtimeVoiceProviderIds,
    });
    if (registered) {
      registerSynthesizedVoiceModelCatalogProvider({
        record,
        provider,
        capabilities: { realtime_voice: true },
        modes: ["realtime_voice"],
      });
    }
  };

  const registerMediaUnderstandingProvider = (
    record: PluginRecord,
    provider: MediaUnderstandingProviderPlugin,
  ) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "media provider",
      registrations: registry.mediaUnderstandingProviders,
      ownedIds: record.mediaUnderstandingProviderIds,
    });
  };

  const registerTranscriptSourceProvider = (
    record: PluginRecord,
    provider: TranscriptSourceProvider,
  ) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "transcripts source provider",
      registrations: registry.transcriptSourceProviders,
      ownedIds: record.transcriptSourceProviderIds,
    });
  };

  const registerImageGenerationProvider = (
    record: PluginRecord,
    provider: ImageGenerationProviderPlugin,
  ) => {
    const registered = registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "image-generation provider",
      registrations: registry.imageGenerationProviders,
      ownedIds: record.imageGenerationProviderIds,
    });
    if (registered) {
      registerSynthesizedMediaModelCatalogProvider({
        record,
        kind: "image_generation",
        provider,
      });
    }
  };

  const registerVideoGenerationProvider = (
    record: PluginRecord,
    provider: VideoGenerationProviderPlugin,
  ) => {
    const registered = registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "video-generation provider",
      registrations: registry.videoGenerationProviders,
      ownedIds: record.videoGenerationProviderIds,
    });
    if (registered) {
      registerSynthesizedMediaModelCatalogProvider({
        record,
        kind: "video_generation",
        provider,
      });
    }
  };

  const registerMusicGenerationProvider = (
    record: PluginRecord,
    provider: MusicGenerationProviderPlugin,
  ) => {
    const registered = registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "music-generation provider",
      registrations: registry.musicGenerationProviders,
      ownedIds: record.musicGenerationProviderIds,
    });
    if (registered) {
      registerSynthesizedMediaModelCatalogProvider({
        record,
        kind: "music_generation",
        provider,
      });
    }
  };

  const registerWebFetchProvider = (record: PluginRecord, provider: WebFetchProviderPlugin) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "web fetch provider",
      registrations: registry.webFetchProviders,
      ownedIds: record.webFetchProviderIds,
    });
  };

  const registerWebSearchProvider = (record: PluginRecord, provider: WebSearchProviderPlugin) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "web search provider",
      registrations: registry.webSearchProviders,
      ownedIds: record.webSearchProviderIds,
    });
  };

  const registerMigrationProvider = (record: PluginRecord, provider: MigrationProviderPlugin) => {
    registerUniqueProviderLike({
      record,
      provider,
      kindLabel: "migration provider",
      registrations: registry.migrationProviders,
      ownedIds: record.migrationProviderIds,
    });
  };

  const registerCli = (
    record: PluginRecord,
    registrar: OpenClawPluginCliRegistrar,
    opts?: {
      parentPath?: string[];
      commands?: string[];
      descriptors?: OpenClawPluginCliCommandDescriptor[];
    },
  ) => {
    const normalizeCommandRoot = (raw: string, source: "command" | "descriptor") => {
      const normalized = normalizeCommandDescriptorName(raw);
      if (!normalized) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `invalid cli ${source} name: ${JSON.stringify(raw.trim())}`,
        });
      }
      return normalized;
    };
    const parentPath = (opts?.parentPath ?? []).map((segment) =>
      normalizeCommandRoot(segment, "command"),
    );
    if (parentPath.some((segment) => segment === null)) {
      return;
    }
    const normalizedParentPath = parentPath as string[];
    const descriptors = (opts?.descriptors ?? [])
      .map((descriptor) => {
        const name = normalizeCommandRoot(descriptor.name, "descriptor");
        const description = sanitizeCommandDescriptorDescription(descriptor.description);
        return name && description
          ? {
              name,
              description,
              hasSubcommands: descriptor.hasSubcommands,
            }
          : null;
      })
      .filter(
        (descriptor): descriptor is OpenClawPluginCliCommandDescriptor => descriptor !== null,
      );
    const commands = [
      ...(opts?.commands ?? []),
      ...descriptors.map((descriptor) => descriptor.name),
    ]
      .map((cmd) => normalizeCommandRoot(cmd, "command"))
      .filter((command): command is string => command !== null);
    if (commands.length === 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "cli registration missing explicit commands metadata",
      });
      return;
    }
    const serializeCommandPath = (command: string) => [...normalizedParentPath, command].join(" ");
    const commandPaths = commands.map(serializeCommandPath);
    const commandPathSet = new Set(commandPaths);
    const existing = registry.cliRegistrars.find((entry) =>
      entry.commands
        .map((command) => [...(entry.parentPath ?? []), command].join(" "))
        .some((commandPath) => commandPathSet.has(commandPath)),
    );
    if (existing) {
      const existingCommandPaths = new Set(
        existing.commands.map((command) => [...(existing.parentPath ?? []), command].join(" ")),
      );
      const overlap = commandPaths.find((commandPath) => existingCommandPaths.has(commandPath));
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `cli command already registered: ${overlap ?? commands[0]} (${existing.pluginId})`,
      });
      return;
    }
    record.cliCommands.push(...commandPaths);
    registry.cliRegistrars.push({
      pluginId: record.id,
      pluginName: record.name,
      register: registrar,
      parentPath: normalizedParentPath,
      commands,
      descriptors,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const reservedNodeHostCommands = new Set<string>([
    ...NODE_SYSTEM_RUN_COMMANDS,
    ...NODE_EXEC_APPROVALS_COMMANDS,
    NODE_SYSTEM_NOTIFY_COMMAND,
  ]);

  const registerReload = (record: PluginRecord, registration: OpenClawPluginReloadRegistration) => {
    const restartPrefixesValue = readHostHookField(registration, "restartPrefixes");
    const hotPrefixesValue = readHostHookField(registration, "hotPrefixes");
    const noopPrefixesValue = readHostHookField(registration, "noopPrefixes");
    const pushUnreadableDiagnostic = (field: keyof OpenClawPluginReloadRegistration) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `reload registration has unreadable field: ${field}`,
      });
    };
    if (!restartPrefixesValue.ok) {
      pushUnreadableDiagnostic("restartPrefixes");
      return;
    }
    if (!hotPrefixesValue.ok) {
      pushUnreadableDiagnostic("hotPrefixes");
      return;
    }
    if (!noopPrefixesValue.ok) {
      pushUnreadableDiagnostic("noopPrefixes");
      return;
    }
    const normalized: OpenClawPluginReloadRegistration = {
      restartPrefixes: normalizeStringEntries(
        Array.isArray(restartPrefixesValue.value) ? restartPrefixesValue.value : undefined,
      ),
      hotPrefixes: normalizeStringEntries(
        Array.isArray(hotPrefixesValue.value) ? hotPrefixesValue.value : undefined,
      ),
      noopPrefixes: normalizeStringEntries(
        Array.isArray(noopPrefixesValue.value) ? noopPrefixesValue.value : undefined,
      ),
    };
    if (
      (normalized.restartPrefixes?.length ?? 0) === 0 &&
      (normalized.hotPrefixes?.length ?? 0) === 0 &&
      (normalized.noopPrefixes?.length ?? 0) === 0
    ) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: "reload registration missing prefixes",
      });
      return;
    }
    registry.reloads ??= [];
    registry.reloads.push({
      pluginId: record.id,
      pluginName: record.name,
      registration: normalized,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerNodeHostCommand = (
    record: PluginRecord,
    nodeCommand: OpenClawPluginNodeHostCommand,
  ) => {
    const commandValue = readHostHookField(nodeCommand, "command");
    const capValue = readHostHookField(nodeCommand, "cap");
    const dangerousValue = readHostHookField(nodeCommand, "dangerous");
    const handleValue = readHostHookField(nodeCommand, "handle");
    const pushUnreadableDiagnostic = (field: keyof OpenClawPluginNodeHostCommand) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `node host command registration has unreadable field: ${field}`,
      });
    };
    if (!commandValue.ok) {
      pushUnreadableDiagnostic("command");
      return;
    }
    if (!capValue.ok) {
      pushUnreadableDiagnostic("cap");
      return;
    }
    if (!dangerousValue.ok) {
      pushUnreadableDiagnostic("dangerous");
      return;
    }
    if (!handleValue.ok) {
      pushUnreadableDiagnostic("handle");
      return;
    }
    const command = typeof commandValue.value === "string" ? commandValue.value.trim() : "";
    if (!command) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "node host command registration missing command",
      });
      return;
    }
    if (reservedNodeHostCommands.has(command)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `node host command reserved by core: ${command}`,
      });
      return;
    }
    if (typeof handleValue.value !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `node host command registration missing handler: ${command}`,
      });
      return;
    }
    registry.nodeHostCommands ??= [];
    const existing = registry.nodeHostCommands.find((entry) => entry.command.command === command);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `node host command already registered: ${command} (${existing.pluginId})`,
      });
      return;
    }
    registry.nodeHostCommands.push({
      pluginId: record.id,
      pluginName: record.name,
      command: {
        command,
        handle: handleValue.value as OpenClawPluginNodeHostCommand["handle"],
        cap: normalizeOptionalString(capValue.value),
        ...(typeof dangerousValue.value === "boolean" ? { dangerous: dangerousValue.value } : {}),
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerNodeInvokePolicy = (
    record: PluginRecord,
    policy: OpenClawPluginNodeInvokePolicy,
    pluginConfig?: Record<string, unknown>,
  ) => {
    const commandsValue = readHostHookField(policy, "commands");
    const defaultPlatformsValue = readHostHookField(policy, "defaultPlatforms");
    const dangerousValue = readHostHookField(policy, "dangerous");
    const foregroundRestrictedOnIosValue = readHostHookField(policy, "foregroundRestrictedOnIos");
    const handleValue = readHostHookField(policy, "handle");
    const pushUnreadableDiagnostic = (field: keyof OpenClawPluginNodeInvokePolicy) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `node invoke policy registration has unreadable field: ${field}`,
      });
    };
    if (!commandsValue.ok) {
      pushUnreadableDiagnostic("commands");
      return;
    }
    if (!defaultPlatformsValue.ok) {
      pushUnreadableDiagnostic("defaultPlatforms");
      return;
    }
    if (!dangerousValue.ok) {
      pushUnreadableDiagnostic("dangerous");
      return;
    }
    if (!foregroundRestrictedOnIosValue.ok) {
      pushUnreadableDiagnostic("foregroundRestrictedOnIos");
      return;
    }
    if (!handleValue.ok) {
      pushUnreadableDiagnostic("handle");
      return;
    }
    const commands = normalizeUniqueStringEntries(
      Array.isArray(commandsValue.value) ? commandsValue.value : [],
    );
    if (commands.length === 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "node invoke policy registration missing commands",
      });
      return;
    }
    if (typeof handleValue.value !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `node invoke policy registration missing handler: ${commands.join(", ")}`,
      });
      return;
    }
    registry.nodeInvokePolicies ??= [];
    for (const command of commands) {
      const existing = registry.nodeInvokePolicies.find((entry) =>
        entry.policy.commands.includes(command),
      );
      if (existing) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `node invoke policy already registered for ${command} (${existing.pluginId})`,
        });
        return;
      }
    }
    registry.nodeInvokePolicies.push({
      pluginId: record.id,
      pluginName: record.name,
      policy: {
        commands,
        handle: handleValue.value as OpenClawPluginNodeInvokePolicy["handle"],
        ...(Array.isArray(defaultPlatformsValue.value)
          ? {
              defaultPlatforms:
                defaultPlatformsValue.value as OpenClawPluginNodeInvokePolicy["defaultPlatforms"],
            }
          : {}),
        ...(typeof dangerousValue.value === "boolean" ? { dangerous: dangerousValue.value } : {}),
        ...(typeof foregroundRestrictedOnIosValue.value === "boolean"
          ? { foregroundRestrictedOnIos: foregroundRestrictedOnIosValue.value }
          : {}),
      },
      pluginConfig,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerSecurityAuditCollector = (
    record: PluginRecord,
    collector: OpenClawPluginSecurityAuditCollector,
  ) => {
    if (typeof collector !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "security audit collector registration missing collector",
      });
      return;
    }
    registry.securityAuditCollectors ??= [];
    registry.securityAuditCollectors.push({
      pluginId: record.id,
      pluginName: record.name,
      collector,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerService = (record: PluginRecord, service: OpenClawPluginService) => {
    const idValue = readHostHookField(service, "id");
    const startValue = readHostHookField(service, "start");
    const stopValue = readHostHookField(service, "stop");
    const pushUnreadableDiagnostic = (field: keyof OpenClawPluginService) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `service registration has unreadable field: ${field}`,
      });
    };
    if (!idValue.ok) {
      pushUnreadableDiagnostic("id");
      return;
    }
    if (!startValue.ok) {
      pushUnreadableDiagnostic("start");
      return;
    }
    if (!stopValue.ok) {
      pushUnreadableDiagnostic("stop");
      return;
    }
    const id = typeof idValue.value === "string" ? idValue.value.trim() : "";
    if (!id) {
      return;
    }
    if (typeof startValue.value !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `service registration missing start handler: ${id}`,
      });
      return;
    }
    const existing = registry.services.find((entry) => entry.service.id === id);
    if (existing) {
      // Idempotent: the same plugin can hit registration twice across snapshot vs
      // activating loads (see #62033). Keep the first registration.
      if (existing.pluginId === record.id) {
        return;
      }
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `service already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    record.services.push(id);
    registry.services.push({
      pluginId: record.id,
      pluginName: record.name,
      service: {
        id,
        start: (ctx) => (startValue.value as OpenClawPluginService["start"]).call(service, ctx),
        ...(typeof stopValue.value === "function"
          ? {
              stop: (ctx) =>
                (stopValue.value as NonNullable<OpenClawPluginService["stop"]>).call(service, ctx),
            }
          : {}),
      },
      source: record.source,
      origin: record.origin,
      trustedOfficialInstall: record.trustedOfficialInstall,
      rootDir: record.rootDir,
    });
  };

  const registerGatewayDiscoveryService = (
    record: PluginRecord,
    service: OpenClawGatewayDiscoveryService,
  ) => {
    const idValue = readHostHookField(service, "id");
    const advertiseValue = readHostHookField(service, "advertise");
    const pushUnreadableDiagnostic = (field: keyof OpenClawGatewayDiscoveryService) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `gateway discovery service registration has unreadable field: ${field}`,
      });
    };
    if (!idValue.ok) {
      pushUnreadableDiagnostic("id");
      return;
    }
    if (!advertiseValue.ok) {
      pushUnreadableDiagnostic("advertise");
      return;
    }
    const id = typeof idValue.value === "string" ? idValue.value.trim() : "";
    if (!id) {
      return;
    }
    if (typeof advertiseValue.value !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `gateway discovery service registration missing advertise handler: ${id}`,
      });
      return;
    }
    const existing = registry.gatewayDiscoveryServices.find((entry) => entry.service.id === id);
    if (existing) {
      if (existing.pluginId === record.id) {
        return;
      }
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `gateway discovery service already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    record.gatewayDiscoveryServiceIds.push(id);
    registry.gatewayDiscoveryServices.push({
      pluginId: record.id,
      pluginName: record.name,
      service: {
        id,
        advertise: (ctx) =>
          (advertiseValue.value as OpenClawGatewayDiscoveryService["advertise"]).call(service, ctx),
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerCommand = (record: PluginRecord, command: OpenClawPluginCommandDefinition) => {
    const nameValue = readHostHookField(command, "name");
    const nativeNamesValue = readHostHookField(command, "nativeNames");
    const nativeProgressMessagesValue = readHostHookField(command, "nativeProgressMessages");
    const descriptionValue = readHostHookField(command, "description");
    const descriptionLocalizationsValue = readHostHookField(command, "descriptionLocalizations");
    const channelsValue = readHostHookField(command, "channels");
    const agentPromptGuidanceValue = readHostHookField(command, "agentPromptGuidance");
    const acceptsArgsValue = readHostHookField(command, "acceptsArgs");
    const requireAuthValue = readHostHookField(command, "requireAuth");
    const requiredScopesValue = readHostHookField(command, "requiredScopes");
    const exposeSenderIsOwnerValue = readHostHookField(command, "exposeSenderIsOwner");
    const ownershipValue = readHostHookField(command, "ownership");
    const handlerValue = readHostHookField(command, "handler");
    const pushUnreadableDiagnostic = (field: keyof OpenClawPluginCommandDefinition) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `command registration has unreadable field: ${field}`,
      });
    };
    const pushValidationDiagnostic = (message: string) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `command registration failed: ${message}`,
      });
    };
    if (!nameValue.ok) {
      pushUnreadableDiagnostic("name");
      return;
    }
    if (!nativeNamesValue.ok) {
      pushUnreadableDiagnostic("nativeNames");
      return;
    }
    if (!nativeProgressMessagesValue.ok) {
      pushUnreadableDiagnostic("nativeProgressMessages");
      return;
    }
    if (!descriptionValue.ok) {
      pushUnreadableDiagnostic("description");
      return;
    }
    if (!descriptionLocalizationsValue.ok) {
      pushUnreadableDiagnostic("descriptionLocalizations");
      return;
    }
    if (!channelsValue.ok) {
      pushUnreadableDiagnostic("channels");
      return;
    }
    if (!agentPromptGuidanceValue.ok) {
      pushUnreadableDiagnostic("agentPromptGuidance");
      return;
    }
    if (!acceptsArgsValue.ok) {
      pushUnreadableDiagnostic("acceptsArgs");
      return;
    }
    if (!requireAuthValue.ok) {
      pushUnreadableDiagnostic("requireAuth");
      return;
    }
    if (!requiredScopesValue.ok) {
      pushUnreadableDiagnostic("requiredScopes");
      return;
    }
    if (!exposeSenderIsOwnerValue.ok) {
      pushUnreadableDiagnostic("exposeSenderIsOwner");
      return;
    }
    if (!ownershipValue.ok) {
      pushUnreadableDiagnostic("ownership");
      return;
    }
    if (!handlerValue.ok) {
      pushUnreadableDiagnostic("handler");
      return;
    }
    const handler = handlerValue.value;
    if (typeof handler !== "function") {
      pushValidationDiagnostic("Command handler must be a function");
      return;
    }
    if (typeof nameValue.value !== "string") {
      pushValidationDiagnostic("Command name must be a string");
      return;
    }
    if (typeof descriptionValue.value !== "string") {
      pushValidationDiagnostic("Command description must be a string");
      return;
    }
    const name = nameValue.value.trim();
    if (!name) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "command registration missing name",
      });
      return;
    }
    const sanitizedCommand: OpenClawPluginCommandDefinition = {
      name,
      description: descriptionValue.value.trim(),
      handler: (ctx) => handler.call(command, ctx),
      ...(nativeNamesValue.value !== undefined
        ? {
            nativeNames: nativeNamesValue.value as OpenClawPluginCommandDefinition["nativeNames"],
          }
        : {}),
      ...(nativeProgressMessagesValue.value !== undefined
        ? {
            nativeProgressMessages:
              nativeProgressMessagesValue.value as OpenClawPluginCommandDefinition["nativeProgressMessages"],
          }
        : {}),
      ...(descriptionLocalizationsValue.value !== undefined
        ? {
            descriptionLocalizations:
              descriptionLocalizationsValue.value as OpenClawPluginCommandDefinition["descriptionLocalizations"],
          }
        : {}),
      ...(channelsValue.value !== undefined
        ? { channels: channelsValue.value as OpenClawPluginCommandDefinition["channels"] }
        : {}),
      ...(agentPromptGuidanceValue.value !== undefined
        ? {
            agentPromptGuidance:
              agentPromptGuidanceValue.value as OpenClawPluginCommandDefinition["agentPromptGuidance"],
          }
        : {}),
      ...(typeof acceptsArgsValue.value === "boolean"
        ? { acceptsArgs: acceptsArgsValue.value }
        : {}),
      ...(typeof requireAuthValue.value === "boolean"
        ? { requireAuth: requireAuthValue.value }
        : {}),
      ...(requiredScopesValue.value !== undefined
        ? {
            requiredScopes:
              requiredScopesValue.value as OpenClawPluginCommandDefinition["requiredScopes"],
          }
        : {}),
      ...(typeof exposeSenderIsOwnerValue.value === "boolean"
        ? { exposeSenderIsOwner: exposeSenderIsOwnerValue.value }
        : {}),
      ...(ownershipValue.value === "reserved" || ownershipValue.value === "plugin"
        ? { ownership: ownershipValue.value }
        : {}),
    };
    const allowReservedCommandNames = sanitizedCommand.ownership === "reserved";
    if (allowReservedCommandNames && !canClaimReservedCommandOwnership(record)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `only bundled plugins can claim reserved command ownership: ${name}`,
      });
      return;
    }
    if (allowReservedCommandNames && !isReservedCommandName(name)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `reserved command ownership requires a reserved command name: ${name}`,
      });
      return;
    }
    if (allowReservedCommandNames && record.id !== normalizeLowercaseStringOrEmpty(name)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `command registration failed: Reserved command ownership requires plugin id "${record.id}" to match reserved command name "${normalizeLowercaseStringOrEmpty(name)}"`,
      });
      return;
    }

    // For snapshot (non-activating) loads, record the command locally without touching the
    // global plugin command registry so running gateway commands stay intact.
    // We still validate the command definition so diagnostics match the real activation path.
    // NOTE: cross-plugin duplicate command detection is intentionally skipped here because
    // snapshot registries are isolated and never write to the global command table. Conflicts
    // will surface when the plugin is loaded via the normal activation path at gateway startup.
    if (!registryParams.activateGlobalSideEffects) {
      const validationError = validatePluginCommandDefinition(sanitizedCommand, {
        allowReservedCommandNames,
      });
      if (validationError) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `command registration failed: ${validationError}`,
        });
        return;
      }
    } else {
      const { ownership: _ownership, ...commandForRegistration } = sanitizedCommand;
      void _ownership;
      const result = registerPluginCommand(
        record.id,
        allowReservedCommandNames ? commandForRegistration : sanitizedCommand,
        {
          pluginName: record.name,
          pluginRoot: record.rootDir,
          allowReservedCommandNames,
          allowOwnerStatusExposure: canClaimReservedCommandOwnership(record),
        },
      );
      if (!result.ok) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `command registration failed: ${result.error}`,
        });
        return;
      }
      if (allowReservedCommandNames) {
        const registeredCommand = pluginCommands.get(`/${name.toLowerCase()}`);
        if (registeredCommand?.pluginId === record.id) {
          registeredCommand.ownership = "reserved";
        }
      }
    }

    record.commands.push(name);
    registry.commands.push({
      pluginId: record.id,
      pluginName: record.name,
      command: sanitizedCommand,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const normalizeHostHookString = (value: unknown): string =>
    typeof value === "string" ? normalizePluginHostHookId(value) : "";

  const readHostHookField = (
    value: unknown,
    key: string,
  ):
    | { ok: true; value: unknown }
    | {
        ok: false;
      } => {
    try {
      return { ok: true, value: (value as Record<string, unknown>)[key] };
    } catch {
      return { ok: false };
    }
  };

  const isToolMetadataRisk = (
    value: unknown,
  ): value is NonNullable<PluginToolMetadataRegistration["risk"]> =>
    value === "low" || value === "medium" || value === "high";

  const normalizeOptionalHostHookString = (value: unknown): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      return "";
    }
    return value.trim();
  };

  const normalizeHostHookStringList = (value: unknown): string[] | undefined | null => {
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      return null;
    }
    const normalized = value.map((item) => normalizeOptionalHostHookString(item));
    if (normalized.some((item) => !item)) {
      return null;
    }
    return normalized as string[];
  };

  const validateSessionActionSchema = (
    record: PluginRecord,
    id: string,
    schema: unknown,
  ): schema is JsonSchemaValue => {
    if (schema === undefined) {
      return true;
    }
    if (!isPluginJsonValue(schema)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session action schema must be JSON-compatible: ${id}`,
      });
      return false;
    }
    if (
      typeof schema !== "boolean" &&
      (!schema || typeof schema !== "object" || Array.isArray(schema))
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session action schema must be a JSON schema object or boolean: ${id}`,
      });
      return false;
    }
    try {
      validateJsonSchemaValue({
        schema,
        cacheKey: `plugin-session-action-registration:${record.id}:${id}`,
        value: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session action schema is not valid JSON Schema: ${id}: ${message}`,
      });
      return false;
    }
    return true;
  };

  const controlUiSurfaces = new Set<PluginControlUiDescriptor["surface"]>([
    "session",
    "tool",
    "run",
    "settings",
  ]);

  const registerSessionExtension = (
    record: PluginRecord,
    extension: PluginSessionExtensionRegistration,
  ) => {
    const namespaceValue = readHostHookField(extension, "namespace");
    const descriptionValue = readHostHookField(extension, "description");
    const projectValue = readHostHookField(extension, "project");
    const cleanupValue = readHostHookField(extension, "cleanup");
    const sessionEntrySlotKeyValue = readHostHookField(extension, "sessionEntrySlotKey");
    const sessionEntrySlotSchemaValue = readHostHookField(extension, "sessionEntrySlotSchema");
    const pushUnreadableDiagnostic = (field: keyof PluginSessionExtensionRegistration) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session extension registration has unreadable field: ${field}`,
      });
    };
    if (!namespaceValue.ok) {
      pushUnreadableDiagnostic("namespace");
      return;
    }
    if (!descriptionValue.ok) {
      pushUnreadableDiagnostic("description");
      return;
    }
    if (!projectValue.ok) {
      pushUnreadableDiagnostic("project");
      return;
    }
    if (!cleanupValue.ok) {
      pushUnreadableDiagnostic("cleanup");
      return;
    }
    if (!sessionEntrySlotKeyValue.ok) {
      pushUnreadableDiagnostic("sessionEntrySlotKey");
      return;
    }
    if (!sessionEntrySlotSchemaValue.ok) {
      pushUnreadableDiagnostic("sessionEntrySlotSchema");
      return;
    }
    const namespace = normalizeHostHookString(namespaceValue.value);
    const description = normalizeHostHookString(descriptionValue.value);
    const project = projectValue.value;
    const cleanup = cleanupValue.value;
    const sessionEntrySlotKey = sessionEntrySlotKeyValue.value;
    const sessionEntrySlotSchema = sessionEntrySlotSchemaValue.value;
    let normalizedSessionEntrySlotKey: string | undefined;
    let invalidMessage: string | undefined;
    if (!namespace || !description) {
      invalidMessage = "session extension registration requires namespace and description";
    } else if (project !== undefined && typeof project !== "function") {
      invalidMessage = "session extension projector must be a function";
    } else if (project?.constructor?.name === "AsyncFunction") {
      invalidMessage = "session extension projector must be synchronous";
    } else if (cleanup !== undefined && typeof cleanup !== "function") {
      invalidMessage = "session extension cleanup must be a function";
    } else if (sessionEntrySlotSchema !== undefined && !isPluginJsonValue(sessionEntrySlotSchema)) {
      invalidMessage = `session extension sessionEntrySlotSchema must be JSON-compatible: ${namespace}`;
    } else if (sessionEntrySlotKey !== undefined) {
      const slotKey = normalizeSessionEntrySlotKey(sessionEntrySlotKey);
      if (!slotKey.ok) {
        invalidMessage = slotKey.error;
      } else {
        normalizedSessionEntrySlotKey = slotKey.key;
      }
    }
    if (invalidMessage) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: invalidMessage,
      });
      return;
    }
    const entrySlotSchema =
      sessionEntrySlotSchema as PluginSessionExtensionRegistration["sessionEntrySlotSchema"];
    const existing = (registry.sessionExtensions ?? []).find(
      (entry) => entry.pluginId === record.id && entry.extension.namespace === namespace,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session extension already registered: ${namespace}`,
      });
      return;
    }
    if (normalizedSessionEntrySlotKey) {
      const existingSlot = (registry.sessionExtensions ?? []).find((entry) => {
        const existingSlotKey = entry.extension.sessionEntrySlotKey;
        if (existingSlotKey === undefined) {
          return false;
        }
        const normalizedExistingSlotKey = normalizeSessionEntrySlotKey(existingSlotKey);
        return (
          normalizedExistingSlotKey.ok &&
          normalizedExistingSlotKey.key === normalizedSessionEntrySlotKey
        );
      });
      if (existingSlot) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `sessionEntrySlotKey already registered: ${normalizedSessionEntrySlotKey}`,
        });
        return;
      }
    }
    (registry.sessionExtensions ??= []).push({
      pluginId: record.id,
      pluginName: record.name,
      extension: {
        namespace,
        description,
        ...(project !== undefined
          ? { project: project as PluginSessionExtensionRegistration["project"] }
          : {}),
        ...(cleanup !== undefined
          ? { cleanup: cleanup as PluginSessionExtensionRegistration["cleanup"] }
          : {}),
        ...(normalizedSessionEntrySlotKey
          ? { sessionEntrySlotKey: normalizedSessionEntrySlotKey }
          : {}),
        ...(entrySlotSchema !== undefined ? { sessionEntrySlotSchema: entrySlotSchema } : {}),
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerTrustedToolPolicy = (
    record: PluginRecord,
    policy: PluginTrustedToolPolicyRegistration,
  ) => {
    if (record.origin !== "bundled") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "only bundled plugins can register trusted tool policies",
      });
      return;
    }
    const idValue = readHostHookField(policy, "id");
    const descriptionValue = readHostHookField(policy, "description");
    const evaluateValue = readHostHookField(policy, "evaluate");
    const pushUnreadableDiagnostic = (field: keyof PluginTrustedToolPolicyRegistration) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `trusted tool policy registration has unreadable field: ${field}`,
      });
    };
    if (!idValue.ok) {
      pushUnreadableDiagnostic("id");
      return;
    }
    if (!descriptionValue.ok) {
      pushUnreadableDiagnostic("description");
      return;
    }
    if (!evaluateValue.ok) {
      pushUnreadableDiagnostic("evaluate");
      return;
    }
    const id = normalizeHostHookString(idValue.value);
    const description = normalizeHostHookString(descriptionValue.value);
    const evaluate = evaluateValue.value;
    if (!id || !description || typeof evaluate !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "trusted tool policy registration requires id, description, and evaluate()",
      });
      return;
    }
    const existing = (registry.trustedToolPolicies ?? []).find((entry) => entry.policy.id === id);
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `trusted tool policy already registered: ${id} (${existing.pluginId})`,
      });
      return;
    }
    (registry.trustedToolPolicies ??= []).push({
      pluginId: record.id,
      pluginName: record.name,
      policy: {
        id,
        description,
        evaluate: evaluate as PluginTrustedToolPolicyRegistration["evaluate"],
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerToolMetadata = (record: PluginRecord, metadata: PluginToolMetadataRegistration) => {
    const toolNameValue = readHostHookField(metadata, "toolName");
    const displayNameValue = readHostHookField(metadata, "displayName");
    const descriptionValue = readHostHookField(metadata, "description");
    const riskValue = readHostHookField(metadata, "risk");
    const tagsValue = readHostHookField(metadata, "tags");
    const pushUnreadableDiagnostic = (field: keyof PluginToolMetadataRegistration) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `tool metadata registration has unreadable metadata: ${field}`,
      });
    };
    if (!toolNameValue.ok) {
      pushUnreadableDiagnostic("toolName");
      return;
    }
    if (!displayNameValue.ok) {
      pushUnreadableDiagnostic("displayName");
      return;
    }
    if (!descriptionValue.ok) {
      pushUnreadableDiagnostic("description");
      return;
    }
    if (!riskValue.ok) {
      pushUnreadableDiagnostic("risk");
      return;
    }
    if (!tagsValue.ok) {
      pushUnreadableDiagnostic("tags");
      return;
    }
    const toolName = normalizeHostHookString(toolNameValue.value);
    if (!toolName) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "tool metadata registration missing toolName",
      });
      return;
    }
    const declaredNames = normalizePluginToolContractNames(record.contracts);
    const undeclared = findUndeclaredPluginToolNames({
      declaredNames,
      toolNames: [toolName],
    });
    if (undeclared.length > 0) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `plugin must declare contracts.tools for tool metadata: ${undeclared.join(", ")}`,
      });
      return;
    }
    // Uniqueness is scoped to (pluginId + toolName): different plugins may each
    // register metadata under the same toolName for their own tools, but a given
    // plugin may not register the same toolName twice. At projection time
    // (tools-effective-inventory.ts, tools-catalog.ts) the metadata is matched
    // back to the tool's owning pluginId so plugin-X cannot decorate plugin-Y's
    // tool (or a core tool) by registering metadata with the same name.
    const existing = (registry.toolMetadata ?? []).find(
      (entry) => entry.pluginId === record.id && entry.metadata.toolName === toolName,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `tool metadata already registered: ${toolName} (${existing.pluginId})`,
      });
      return;
    }
    const displayName = normalizeOptionalHostHookString(displayNameValue.value);
    const description = normalizeOptionalHostHookString(descriptionValue.value);
    const tags = normalizeHostHookStringList(tagsValue.value);
    const risk = riskValue.value;
    if (
      displayName === "" ||
      description === "" ||
      tags === null ||
      (risk !== undefined && !isToolMetadataRisk(risk))
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `tool metadata registration has invalid metadata: ${toolName}`,
      });
      return;
    }
    (registry.toolMetadata ??= []).push({
      pluginId: record.id,
      pluginName: record.name,
      metadata: {
        toolName,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(risk !== undefined ? { risk } : {}),
        ...(tags !== undefined ? { tags } : {}),
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerControlUiDescriptor = (
    record: PluginRecord,
    descriptor: PluginControlUiDescriptor,
  ) => {
    const idValue = readHostHookField(descriptor, "id");
    const surfaceValue = readHostHookField(descriptor, "surface");
    const labelValue = readHostHookField(descriptor, "label");
    const descriptionValue = readHostHookField(descriptor, "description");
    const placementValue = readHostHookField(descriptor, "placement");
    const schemaValue = readHostHookField(descriptor, "schema");
    const requiredScopesValue = readHostHookField(descriptor, "requiredScopes");
    const pushUnreadableDiagnostic = (field: string) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `control UI descriptor registration has unreadable field: ${field}`,
      });
    };
    if (!idValue.ok) {
      pushUnreadableDiagnostic("id");
      return;
    }
    if (!surfaceValue.ok) {
      pushUnreadableDiagnostic("surface");
      return;
    }
    if (!labelValue.ok) {
      pushUnreadableDiagnostic("label");
      return;
    }
    if (!descriptionValue.ok) {
      pushUnreadableDiagnostic("description");
      return;
    }
    if (!placementValue.ok) {
      pushUnreadableDiagnostic("placement");
      return;
    }
    if (!schemaValue.ok) {
      pushUnreadableDiagnostic("schema");
      return;
    }
    if (!requiredScopesValue.ok) {
      pushUnreadableDiagnostic("requiredScopes");
      return;
    }

    const id = normalizeHostHookString(idValue.value);
    const label = normalizeHostHookString(labelValue.value);
    const description = normalizeOptionalHostHookString(descriptionValue.value);
    const placement = normalizeOptionalHostHookString(placementValue.value);
    const requiredScopes = normalizeHostHookStringList(requiredScopesValue.value);
    const surface = typeof surfaceValue.value === "string" ? surfaceValue.value : "";
    const schema = schemaValue.value;
    if (
      !id ||
      !label ||
      !controlUiSurfaces.has(surface as PluginControlUiDescriptor["surface"]) ||
      description === "" ||
      placement === "" ||
      requiredScopes === null
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message:
          "control UI descriptor registration requires id, surface, label, and valid optional fields",
      });
      return;
    }
    // Validate each requiredScope against the known OperatorScope set so untyped
    // (JS) plugins cannot project arbitrary strings to clients as if they were
    // valid operator scopes.
    if (requiredScopes !== undefined) {
      const unknownScope = requiredScopes.find((scope) => !isOperatorScope(scope));
      if (unknownScope !== undefined) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `control UI descriptor requiredScopes contains unknown operator scope: ${unknownScope}`,
        });
        return;
      }
    }
    if (schema !== undefined && !isPluginJsonValue(schema)) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `control UI descriptor schema must be JSON-compatible: ${id}`,
      });
      return;
    }
    const existing = (registry.controlUiDescriptors ?? []).find(
      (entry) => entry.pluginId === record.id && entry.descriptor.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `control UI descriptor already registered: ${id}`,
      });
      return;
    }
    (registry.controlUiDescriptors ??= []).push({
      pluginId: record.id,
      pluginName: record.name,
      descriptor: {
        id,
        surface: surface as PluginControlUiDescriptor["surface"],
        label,
        ...(description !== undefined ? { description } : {}),
        ...(placement !== undefined ? { placement } : {}),
        ...(schema !== undefined ? { schema } : {}),
        ...(requiredScopes !== undefined
          ? { requiredScopes: requiredScopes as OperatorScope[] }
          : {}),
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerRuntimeLifecycle = (
    record: PluginRecord,
    lifecycle: PluginRuntimeLifecycleRegistration,
  ) => {
    const idValue = readHostHookField(lifecycle, "id");
    const descriptionValue = readHostHookField(lifecycle, "description");
    const cleanupValue = readHostHookField(lifecycle, "cleanup");
    const pushUnreadableDiagnostic = (field: keyof PluginRuntimeLifecycleRegistration) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `runtime lifecycle registration has unreadable field: ${field}`,
      });
    };
    if (!idValue.ok) {
      pushUnreadableDiagnostic("id");
      return;
    }
    if (!descriptionValue.ok) {
      pushUnreadableDiagnostic("description");
      return;
    }
    if (!cleanupValue.ok) {
      pushUnreadableDiagnostic("cleanup");
      return;
    }
    const id = normalizeHostHookString(idValue.value);
    const description = normalizeOptionalHostHookString(descriptionValue.value);
    if (!id) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "runtime lifecycle registration missing id",
      });
      return;
    }
    const existing = (registry.runtimeLifecycles ?? []).find(
      (entry) => entry.pluginId === record.id && entry.lifecycle.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `runtime lifecycle already registered: ${id}`,
      });
      return;
    }
    if (description === "") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `runtime lifecycle description must be a string: ${id}`,
      });
      return;
    }
    const cleanup = cleanupValue.value;
    if (cleanup !== undefined && typeof cleanup !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `runtime lifecycle cleanup must be a function: ${id}`,
      });
      return;
    }
    (registry.runtimeLifecycles ??= []).push({
      pluginId: record.id,
      pluginName: record.name,
      lifecycle: {
        id,
        ...(description !== undefined ? { description } : {}),
        ...(cleanup !== undefined
          ? { cleanup: cleanup as PluginRuntimeLifecycleRegistration["cleanup"] }
          : {}),
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerAgentEventSubscription = (
    record: PluginRecord,
    subscription: PluginAgentEventSubscriptionRegistration,
  ) => {
    const idValue = readHostHookField(subscription, "id");
    const descriptionValue = readHostHookField(subscription, "description");
    const streamsValue = readHostHookField(subscription, "streams");
    const handleValue = readHostHookField(subscription, "handle");
    const pushUnreadableDiagnostic = (field: keyof PluginAgentEventSubscriptionRegistration) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent event subscription registration has unreadable field: ${field}`,
      });
    };
    if (!idValue.ok) {
      pushUnreadableDiagnostic("id");
      return;
    }
    if (!descriptionValue.ok) {
      pushUnreadableDiagnostic("description");
      return;
    }
    if (!streamsValue.ok) {
      pushUnreadableDiagnostic("streams");
      return;
    }
    if (!handleValue.ok) {
      pushUnreadableDiagnostic("handle");
      return;
    }
    const id = normalizeHostHookString(idValue.value);
    const description = normalizeOptionalHostHookString(descriptionValue.value);
    const handle = handleValue.value;
    if (!id || typeof handle !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "agent event subscription registration requires id and handle",
      });
      return;
    }
    if (description === "") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent event subscription description must be a string: ${id}`,
      });
      return;
    }
    const streams = normalizeHostHookStringList(streamsValue.value);
    if (streams === null) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent event subscription streams must be an array of strings: ${id}`,
      });
      return;
    }
    const existing = (registry.agentEventSubscriptions ?? []).find(
      (entry) => entry.pluginId === record.id && entry.subscription.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `agent event subscription already registered: ${id}`,
      });
      return;
    }
    (registry.agentEventSubscriptions ??= []).push({
      pluginId: record.id,
      pluginName: record.name,
      subscription: {
        id,
        ...(description !== undefined ? { description } : {}),
        ...(streams !== undefined ? { streams } : {}),
        handle: handle as PluginAgentEventSubscriptionRegistration["handle"],
      },
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const registerSessionSchedulerJob = (
    record: PluginRecord,
    job: PluginSessionSchedulerJobRegistration,
  ) => {
    const idValue = readHostHookField(job, "id");
    const sessionKeyValue = readHostHookField(job, "sessionKey");
    const kindValue = readHostHookField(job, "kind");
    const descriptionValue = readHostHookField(job, "description");
    const cleanupValue = readHostHookField(job, "cleanup");
    const pushUnreadableDiagnostic = (field: keyof PluginSessionSchedulerJobRegistration) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session scheduler job registration has unreadable field: ${field}`,
      });
    };
    if (!idValue.ok) {
      pushUnreadableDiagnostic("id");
      return undefined;
    }
    if (!sessionKeyValue.ok) {
      pushUnreadableDiagnostic("sessionKey");
      return undefined;
    }
    if (!kindValue.ok) {
      pushUnreadableDiagnostic("kind");
      return undefined;
    }
    if (!descriptionValue.ok) {
      pushUnreadableDiagnostic("description");
      return undefined;
    }
    if (!cleanupValue.ok) {
      pushUnreadableDiagnostic("cleanup");
      return undefined;
    }
    const jobId = normalizeHostHookString(idValue.value);
    const sessionKey = normalizeHostHookString(sessionKeyValue.value);
    const kind = normalizeHostHookString(kindValue.value);
    if (
      jobId &&
      (registry.sessionSchedulerJobs ?? []).some(
        (entry) => entry.pluginId === record.id && entry.job.id === jobId,
      )
    ) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session scheduler job already registered: ${jobId}`,
      });
      return undefined;
    }
    if (!jobId || !sessionKey || !kind) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "session scheduler job registration requires unique id, sessionKey, and kind",
      });
      return undefined;
    }
    const description = normalizeOptionalHostHookString(descriptionValue.value);
    if (description === "") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session scheduler job description must be a string: ${jobId}`,
      });
      return undefined;
    }
    const cleanup = cleanupValue.value;
    if (cleanup !== undefined && typeof cleanup !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session scheduler job cleanup must be a function: ${jobId}`,
      });
      return undefined;
    }
    const sanitizedJob: PluginSessionSchedulerJobRegistration = {
      id: jobId,
      sessionKey,
      kind,
      ...(description !== undefined ? { description } : {}),
      ...(cleanup !== undefined
        ? { cleanup: cleanup as PluginSessionSchedulerJobRegistration["cleanup"] }
        : {}),
    };
    if (registryParams.activateGlobalSideEffects === false) {
      (registry.sessionSchedulerJobs ??= []).push({
        pluginId: record.id,
        pluginName: record.name,
        job: sanitizedJob,
        source: record.source,
        rootDir: record.rootDir,
      });
      return { id: jobId, pluginId: record.id, sessionKey, kind };
    }
    const handle = registerPluginSessionSchedulerJob({
      pluginId: record.id,
      pluginName: record.name,
      ownerRegistry: registry,
      job: sanitizedJob,
    });
    if (!handle) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "session scheduler job registration requires unique id, sessionKey, and kind",
      });
      return undefined;
    }
    (registry.sessionSchedulerJobs ??= []).push({
      pluginId: record.id,
      pluginName: record.name,
      job: {
        ...sanitizedJob,
        id: handle.id,
        sessionKey: handle.sessionKey,
        kind: handle.kind,
      },
      generation: getPluginSessionSchedulerJobGeneration({
        pluginId: record.id,
        jobId: handle.id,
        sessionKey: handle.sessionKey,
      }),
      source: record.source,
      rootDir: record.rootDir,
    });
    return handle;
  };

  const registerSessionAction = (record: PluginRecord, action: PluginSessionActionRegistration) => {
    const idValue = readHostHookField(action, "id");
    const descriptionValue = readHostHookField(action, "description");
    const schemaValue = readHostHookField(action, "schema");
    const requiredScopesValue = readHostHookField(action, "requiredScopes");
    const handlerValue = readHostHookField(action, "handler");
    const pushUnreadableDiagnostic = (field: keyof PluginSessionActionRegistration) => {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session action registration has unreadable field: ${field}`,
      });
    };
    if (!idValue.ok) {
      pushUnreadableDiagnostic("id");
      return;
    }
    if (!descriptionValue.ok) {
      pushUnreadableDiagnostic("description");
      return;
    }
    if (!schemaValue.ok) {
      pushUnreadableDiagnostic("schema");
      return;
    }
    if (!requiredScopesValue.ok) {
      pushUnreadableDiagnostic("requiredScopes");
      return;
    }
    if (!handlerValue.ok) {
      pushUnreadableDiagnostic("handler");
      return;
    }
    const id = normalizeHostHookString(idValue.value);
    const description = normalizeOptionalHostHookString(descriptionValue.value);
    const requiredScopes = normalizeHostHookStringList(requiredScopesValue.value);
    const handler = handlerValue.value;
    if (!id || description === "" || requiredScopes === null || typeof handler !== "function") {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: "session action registration requires id, handler, and valid optional fields",
      });
      return;
    }
    if (requiredScopes !== undefined) {
      const unknownScope = requiredScopes.find((scope) => !isOperatorScope(scope));
      if (unknownScope !== undefined) {
        pushDiagnostic({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: `session action requiredScopes contains unknown operator scope: ${unknownScope}`,
        });
        return;
      }
    }
    const schema = schemaValue.value;
    if (!validateSessionActionSchema(record, id, schema)) {
      return;
    }
    const actionSchema = schema as PluginSessionActionRegistration["schema"];
    const existing = (registry.sessionActions ?? []).find(
      (entry) => entry.pluginId === record.id && entry.action.id === id,
    );
    if (existing) {
      pushDiagnostic({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: `session action already registered: ${id}`,
      });
      return;
    }
    (registry.sessionActions ??= []).push({
      pluginId: record.id,
      pluginName: record.name,
      action: {
        id,
        ...(description !== undefined ? { description } : {}),
        ...(actionSchema !== undefined ? { schema: actionSchema } : {}),
        ...(requiredScopes !== undefined
          ? { requiredScopes: requiredScopes as OperatorScope[] }
          : {}),
        handler: handler as PluginSessionActionRegistration["handler"],
      },
      source: record.source,
      rootDir: record.rootDir,
    } satisfies PluginSessionActionRegistryRegistration);
  };

  const registerTypedHook = <K extends PluginHookName>(
    record: PluginRecord,
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: { priority?: number; timeoutMs?: number },
    policy?: PluginTypedHookPolicy,
  ) => {
    if (!isPluginHookName(hookName)) {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `unknown typed hook "${String(hookName)}" ignored`,
      });
      return;
    }
    const effectiveHookName = hookName === "deactivate" ? "gateway_stop" : hookName;
    if (hookName === "deactivate") {
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: formatLegacyDeactivateHookAliasDiagnostic(),
      });
    }
    let effectiveHandler = handler;
    if (policy?.allowPromptInjection === false && isPromptInjectionHookName(effectiveHookName)) {
      if (effectiveHookName !== "before_agent_start") {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `typed hook "${effectiveHookName}" blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
        });
        return;
      }
      pushDiagnostic({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `typed hook "${effectiveHookName}" prompt fields constrained by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
      });
      effectiveHandler = constrainLegacyPromptInjectionHook(
        handler as PluginHookHandlerMap["before_agent_start"],
      ) as PluginHookHandlerMap[K];
    }
    if (isConversationHookName(effectiveHookName)) {
      const explicitConversationAccess = policy?.allowConversationAccess;
      if (record.origin !== "bundled" && explicitConversationAccess !== true) {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message:
            `typed hook "${effectiveHookName}" blocked because non-bundled plugins must set ` +
            `plugins.entries.${record.id}.hooks.allowConversationAccess=true`,
        });
        return;
      }
      if (record.origin === "bundled" && explicitConversationAccess === false) {
        pushDiagnostic({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `typed hook "${effectiveHookName}" blocked by plugins.entries.${record.id}.hooks.allowConversationAccess=false`,
        });
        return;
      }
    }
    const timeoutMs = resolveTypedHookTimeoutMs({ hookName: effectiveHookName, opts, policy });
    record.hookCount += 1;
    registry.typedHooks.push({
      pluginId: record.id,
      hookName: effectiveHookName,
      handler: effectiveHandler,
      priority: opts?.priority,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      source: record.source,
    } as TypedPluginHookRegistration);
  };

  const registerConversationBindingResolvedHandler = (
    record: PluginRecord,
    handler: (event: PluginConversationBindingResolvedEvent) => void | Promise<void>,
  ) => {
    registry.conversationBindingResolvedHandlers.push({
      pluginId: record.id,
      pluginName: record.name,
      pluginRoot: record.rootDir,
      handler,
      source: record.source,
      rootDir: record.rootDir,
    });
  };

  const normalizeLogger = (logger: PluginLogger): PluginLogger => ({
    info: logger.info,
    warn: logger.warn,
    error: logger.error,
    debug: logger.debug,
  });

  const pluginRuntimeById = new Map<string, PluginRuntime>();
  const pluginRuntimeRecordById = new Map<string, PluginRecord>();

  const addPluginRuntimeResolutionContext = (params: {
    error: unknown;
    pluginId: string;
    prop: PropertyKey;
  }): never => {
    const { error, pluginId, prop } = params;
    if (
      error instanceof Error &&
      error.message.startsWith("Unable to resolve plugin runtime module") &&
      !error.message.includes("pluginRuntimeContext=")
    ) {
      const record =
        pluginRuntimeRecordById.get(pluginId) ??
        registry.plugins.find((entry) => entry.id === pluginId);
      const propName =
        typeof prop === "symbol" ? (prop.description ?? prop.toString()) : String(prop);
      error.message = [
        error.message,
        `pluginRuntimeContext=pluginId:${pluginId}`,
        `property:${propName}`,
        ...(record?.source ? [`source:${record.source}`] : []),
      ].join("; ");
    }
    throw error;
  };

  const resolvePluginRuntime = (pluginId: string): PluginRuntime => {
    const cached = pluginRuntimeById.get(pluginId);
    if (cached) {
      return cached;
    }
    const runtime = new Proxy(registryParams.runtime, {
      get(target, prop, receiver) {
        const runWithPluginScope = <T>(run: () => T): T => {
          const record =
            pluginRuntimeRecordById.get(pluginId) ??
            registry.plugins.find((entry) => entry.id === pluginId);
          return record?.source
            ? withPluginRuntimePluginScope({ pluginId, pluginSource: record.source }, run)
            : withPluginRuntimePluginScope({ pluginId }, run);
        };
        const getRuntimeProperty = () => {
          try {
            return Reflect.get(target, prop, receiver);
          } catch (error) {
            return addPluginRuntimeResolutionContext({ error, pluginId, prop });
          }
        };
        if (prop === "state") {
          const baseState = getRuntimeProperty();
          const assertPluginStateAllowed = () => {
            const record =
              pluginRuntimeRecordById.get(pluginId) ??
              registry.plugins.find((entry) => entry.id === pluginId);
            if (record?.origin !== "bundled" && record?.trustedOfficialInstall !== true) {
              throw new Error(
                "openKeyedStore is only available for trusted plugins in this release.",
              );
            }
          };
          return {
            ...baseState,
            openKeyedStore: <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
              assertPluginStateAllowed();
              return createPluginStateKeyedStore<T>(pluginId, options);
            },
            openSyncKeyedStore: <T>(
              options: OpenKeyedStoreOptions,
            ): PluginStateSyncKeyedStore<T> => {
              assertPluginStateAllowed();
              return createPluginStateSyncKeyedStore<T>(pluginId, options);
            },
          } satisfies PluginRuntime["state"];
        }
        if (prop === "config") {
          const config: PluginRuntime["config"] = getRuntimeProperty();
          return {
            ...config,
            current: () => runWithPluginScope(() => config.current()),
            mutateConfigFile: (params) => runWithPluginScope(() => config.mutateConfigFile(params)),
            replaceConfigFile: (params) =>
              runWithPluginScope(() => config.replaceConfigFile(params)),
          } satisfies PluginRuntime["config"];
        }
        if (prop === "llm") {
          const llm = getRuntimeProperty();
          return {
            complete: (params) =>
              withPluginRuntimePluginIdScope(pluginId, () => llm.complete(params)),
          } satisfies PluginRuntime["llm"];
        }
        if (prop !== "subagent") {
          return getRuntimeProperty();
        }
        const subagent = getRuntimeProperty();
        return {
          run: (params) => withPluginRuntimePluginIdScope(pluginId, () => subagent.run(params)),
          waitForRun: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.waitForRun(params)),
          getSessionMessages: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.getSessionMessages(params)),
          getSession: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.getSession(params)),
          deleteSession: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.deleteSession(params)),
        } satisfies PluginRuntime["subagent"];
      },
    });
    pluginRuntimeById.set(pluginId, runtime);
    return runtime;
  };

  const createApi = (
    record: PluginRecord,
    params: {
      config: OpenClawPluginApi["config"];
      pluginConfig?: Record<string, unknown>;
      hookPolicy?: PluginTypedHookPolicy;
      registrationMode?: PluginRegistrationMode;
    },
  ): OpenClawPluginApi => {
    const registrationMode = params.registrationMode ?? "full";
    const registrationCapabilities = resolvePluginRegistrationCapabilities(registrationMode);
    pluginRuntimeRecordById.set(record.id, record);
    const sideEffectGuard = createPluginSideEffectGuard(record.id);
    const isLoadedRecordInRegistry = () =>
      registry.plugins.some((plugin) => plugin.id === record.id && plugin.status === "loaded");
    const isLoadedRecordInActiveRegistry = () =>
      getActivePluginRegistry() === registry && isLoadedRecordInRegistry();
    const isActivatingLoadedRecord = () =>
      registryParams.activateGlobalSideEffects !== false &&
      record.enabled &&
      record.status === "loaded" &&
      !registry.plugins.some((plugin) => plugin.id === record.id);
    const shouldCommitWorkflowSideEffect = () =>
      sideEffectGuard.active &&
      !isPluginRegistryRetired(registry) &&
      (isActivatingLoadedRecord() ||
        (isPluginRegistryActivated(registry) && isLoadedRecordInRegistry()));
    return buildPluginApi({
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      source: record.source,
      rootDir: record.rootDir,
      registrationMode,
      config: params.config,
      pluginConfig: params.pluginConfig,
      runtime: resolvePluginRuntime(record.id),
      logger: normalizeLogger(registryParams.logger),
      resolvePath: (input: string) => resolvePluginPath(input, record.rootDir),
      handlers: {
        ...(registrationCapabilities.capabilityHandlers
          ? {
              registerTool: (tool, opts) => registerTool(record, tool, opts),
              registerHook: (events, handler, opts) =>
                registerHook(record, events, handler, opts, params.config, params.pluginConfig),
              registerHttpRoute: (routeParams) => registerHttpRoute(record, routeParams),
              registerHostedMediaResolver: (resolver) =>
                registerHostedMediaResolver(record, resolver),
              registerProvider: (provider) => registerProvider(record, provider),
              registerModelCatalogProvider: (provider) =>
                registerModelCatalogProvider(record, provider),
              registerEmbeddingProvider: (provider) =>
                registerEmbeddingProviderForPlugin(record, provider),
              registerAgentHarness: (harness) => registerAgentHarness(record, harness),
              registerDetachedTaskRuntime: (runtime) => {
                const existing = getDetachedTaskLifecycleRuntimeRegistration();
                if (existing && existing.pluginId !== record.id) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `detached task runtime already registered by ${existing.pluginId}`,
                  });
                  return;
                }
                registerDetachedTaskLifecycleRuntime(record.id, runtime);
              },
              registerSpeechProvider: (provider) => registerSpeechProvider(record, provider),
              registerRealtimeTranscriptionProvider: (provider) =>
                registerRealtimeTranscriptionProvider(record, provider),
              registerRealtimeVoiceProvider: (provider) =>
                registerRealtimeVoiceProvider(record, provider),
              registerMediaUnderstandingProvider: (provider) =>
                registerMediaUnderstandingProvider(record, provider),
              registerTranscriptSourceProvider: (provider) =>
                registerTranscriptSourceProvider(record, provider),
              registerImageGenerationProvider: (provider) =>
                registerImageGenerationProvider(record, provider),
              registerVideoGenerationProvider: (provider) =>
                registerVideoGenerationProvider(record, provider),
              registerMusicGenerationProvider: (provider) =>
                registerMusicGenerationProvider(record, provider),
              registerWebFetchProvider: (provider) => registerWebFetchProvider(record, provider),
              registerWebSearchProvider: (provider) => registerWebSearchProvider(record, provider),
              registerMigrationProvider: (provider) => registerMigrationProvider(record, provider),
              registerGatewayMethod: (method, handler, opts) =>
                registerGatewayMethod(record, method, handler, opts),
              registerService: (service) => registerService(record, service),
              registerGatewayDiscoveryService: (service) =>
                registerGatewayDiscoveryService(record, service),
              registerCliBackend: (backend) => registerCliBackend(record, backend),
              registerTextTransforms: (transforms) => registerTextTransforms(record, transforms),
              registerReload: (registration) => registerReload(record, registration),
              registerNodeHostCommand: (command) => registerNodeHostCommand(record, command),
              registerNodeInvokePolicy: (policy) =>
                registerNodeInvokePolicy(record, policy, params.pluginConfig),
              registerSecurityAuditCollector: (collector) =>
                registerSecurityAuditCollector(record, collector),
              registerInteractiveHandler: (registration) => {
                const result = registerPluginInteractiveHandler(record.id, registration, {
                  pluginName: record.name,
                  pluginRoot: record.rootDir,
                });
                if (!result.ok) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message: result.error ?? "interactive handler registration failed",
                  });
                }
              },
              onConversationBindingResolved: (handler) =>
                registerConversationBindingResolvedHandler(record, handler),
              registerCommand: (command) => registerCommand(record, command),
              registerContextEngine: (id, factory) => {
                const normalizedId = normalizeOptionalString(id) ?? "";
                if (!normalizedId) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: "context engine registration missing id",
                  });
                  return;
                }
                if (typeof factory !== "function") {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `context engine "${normalizedId}" registration missing factory`,
                  });
                  return;
                }
                if (normalizedId === defaultSlotIdForKey("contextEngine")) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `context engine id reserved by core: ${normalizedId}`,
                  });
                  return;
                }
                const result = registerContextEngineForOwner(
                  normalizedId,
                  factory,
                  `plugin:${record.id}`,
                  {
                    allowSameOwnerRefresh: true,
                  },
                );
                if (!result.ok) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `context engine already registered: ${normalizedId} (${result.existingOwner})`,
                  });
                  return;
                }
                if (!record.contextEngineIds?.includes(normalizedId)) {
                  record.contextEngineIds = [...(record.contextEngineIds ?? []), normalizedId];
                }
              },
              registerCompactionProvider: (
                provider: Parameters<OpenClawPluginApi["registerCompactionProvider"]>[0],
              ) => {
                const id = normalizeOptionalString(
                  (
                    provider as Partial<
                      Parameters<OpenClawPluginApi["registerCompactionProvider"]>[0]
                    > | null
                  )?.id,
                );
                if (!id) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: "compaction provider registration missing id",
                  });
                  return;
                }
                if (typeof provider?.summarize !== "function") {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `compaction provider "${id}" registration missing summarize`,
                  });
                  return;
                }
                const existing = getRegisteredCompactionProvider(id);
                if (existing) {
                  const ownerDetail = existing.ownerPluginId
                    ? ` (owner: ${existing.ownerPluginId})`
                    : "";
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `compaction provider already registered: ${id}${ownerDetail}`,
                  });
                  return;
                }
                registerCompactionProvider(provider, { ownerPluginId: record.id });
              },
              registerCodexAppServerExtensionFactory: (factory) => {
                registerCodexAppServerExtensionFactory(record, factory);
              },
              registerAgentToolResultMiddleware: (handler, options) => {
                registerAgentToolResultMiddleware(record, handler, options);
              },
              registerSessionExtension: (extension) => registerSessionExtension(record, extension),
              enqueueNextTurnInjection: (injection) => {
                if (params.hookPolicy?.allowPromptInjection === false) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message: `next-turn injection blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
                  });
                  return Promise.resolve({
                    enqueued: false,
                    id: "",
                    sessionKey: injection.sessionKey,
                  });
                }
                return enqueuePluginNextTurnInjection({
                  cfg: registryParams.runtime.config.current() as OpenClawConfig,
                  pluginId: record.id,
                  pluginName: record.name,
                  injection,
                });
              },
              registerTrustedToolPolicy: (policy) => registerTrustedToolPolicy(record, policy),
              registerToolMetadata: (metadata) => registerToolMetadata(record, metadata),
              registerControlUiDescriptor: (descriptor) =>
                registerControlUiDescriptor(record, descriptor),
              registerRuntimeLifecycle: (lifecycle) => registerRuntimeLifecycle(record, lifecycle),
              registerAgentEventSubscription: (subscription) =>
                registerAgentEventSubscription(record, subscription),
              emitAgentEvent: (event) => {
                if (registryParams.activateGlobalSideEffects === false) {
                  return { emitted: false, reason: "global side effects disabled" };
                }
                if (!shouldCommitWorkflowSideEffect()) {
                  return { emitted: false, reason: "plugin is not loaded" };
                }
                return emitPluginAgentEvent({
                  pluginId: record.id,
                  pluginName: record.name,
                  origin: record.origin,
                  event,
                });
              },
              setRunContext: (patch) =>
                registryParams.activateGlobalSideEffects !== false &&
                shouldCommitWorkflowSideEffect()
                  ? setPluginRunContext({ pluginId: record.id, patch })
                  : false,
              getRunContext: (get) => getPluginRunContext({ pluginId: record.id, get }),
              clearRunContext: (params) => {
                if (
                  registryParams.activateGlobalSideEffects === false ||
                  !shouldCommitWorkflowSideEffect()
                ) {
                  return;
                }
                clearPluginRunContext({
                  pluginId: record.id,
                  runId: params.runId,
                  namespace: params.namespace,
                });
              },
              registerSessionSchedulerJob: (job) => registerSessionSchedulerJob(record, job),
              registerSessionAction: (action) => registerSessionAction(record, action),
              sendSessionAttachment: async (attachment) => {
                if (registryParams.activateGlobalSideEffects === false) {
                  return { ok: false, error: "global side effects disabled" };
                }
                try {
                  if (!isLoadedRecordInActiveRegistry()) {
                    return { ok: false, error: "plugin is not loaded" };
                  }
                  const runtimeConfig =
                    (registryParams.runtime.config?.current?.() as OpenClawConfig | undefined) ??
                    params.config;
                  return await sendPluginSessionAttachment({
                    ...attachment,
                    config: runtimeConfig,
                    origin: record.origin,
                  });
                } catch (error) {
                  return {
                    ok: false,
                    error: `attachment delivery setup failed: ${formatErrorMessage(error)}`,
                  };
                }
              },
              scheduleSessionTurn: async (schedule) => {
                if (registryParams.activateGlobalSideEffects === false) {
                  return undefined;
                }
                await Promise.resolve();
                return schedulePluginSessionTurn({
                  pluginId: record.id,
                  pluginName: record.name,
                  origin: record.origin,
                  schedule,
                  cron: getHostCronService(),
                  shouldCommit: isLoadedRecordInActiveRegistry,
                  ownerRegistry: registry,
                });
              },
              unscheduleSessionTurnsByTag: async (request) => {
                if (registryParams.activateGlobalSideEffects === false) {
                  return { removed: 0, failed: 0 };
                }
                await Promise.resolve();
                if (!isLoadedRecordInActiveRegistry()) {
                  return { removed: 0, failed: 0 };
                }
                return unschedulePluginSessionTurnsByTag({
                  pluginId: record.id,
                  origin: record.origin,
                  cron: getHostCronService(),
                  request,
                });
              },
              registerMemoryCapability: (capability) => {
                if (!hasKind(record.kind, "memory")) {
                  throwRegistrationError("only memory plugins can register a memory capability");
                }
                if (
                  Array.isArray(record.kind) &&
                  record.kind.length > 1 &&
                  !record.memorySlotSelected
                ) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message:
                      "dual-kind plugin not selected for memory slot; skipping memory capability registration",
                  });
                  return;
                }
                registerMemoryCapability(record.id, capability);
              },
              registerMemoryPromptSection: (builder) => {
                if (!hasKind(record.kind, "memory")) {
                  throwRegistrationError(
                    "only memory plugins can register a memory prompt section",
                  );
                }
                if (
                  Array.isArray(record.kind) &&
                  record.kind.length > 1 &&
                  !record.memorySlotSelected
                ) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message:
                      "dual-kind plugin not selected for memory slot; skipping memory prompt section registration",
                  });
                  return;
                }
                registerMemoryPromptSectionForPlugin(record.id, builder);
              },
              registerMemoryPromptSupplement: (builder) => {
                if (typeof builder !== "function") {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: "memory prompt supplement registration missing builder",
                  });
                  return;
                }
                registerMemoryPromptSupplement(record.id, builder);
              },
              registerMemoryCorpusSupplement: (supplement) => {
                registerMemoryCorpusSupplement(record.id, supplement);
              },
              registerMemoryFlushPlan: (resolver) => {
                if (!hasKind(record.kind, "memory")) {
                  throwRegistrationError("only memory plugins can register a memory flush plan");
                }
                if (
                  Array.isArray(record.kind) &&
                  record.kind.length > 1 &&
                  !record.memorySlotSelected
                ) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message:
                      "dual-kind plugin not selected for memory slot; skipping memory flush plan registration",
                  });
                  return;
                }
                registerMemoryFlushPlanResolverForPlugin(record.id, resolver);
              },
              registerMemoryRuntime: (runtime) => {
                if (!hasKind(record.kind, "memory")) {
                  throwRegistrationError("only memory plugins can register a memory runtime");
                }
                if (
                  Array.isArray(record.kind) &&
                  record.kind.length > 1 &&
                  !record.memorySlotSelected
                ) {
                  pushDiagnostic({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message:
                      "dual-kind plugin not selected for memory slot; skipping memory runtime registration",
                  });
                  return;
                }
                registerMemoryRuntimeForPlugin(record.id, runtime);
              },
              registerMemoryEmbeddingProvider: (adapter) => {
                if (hasKind(record.kind, "memory")) {
                  if (
                    Array.isArray(record.kind) &&
                    record.kind.length > 1 &&
                    !record.memorySlotSelected
                  ) {
                    pushDiagnostic({
                      level: "warn",
                      pluginId: record.id,
                      source: record.source,
                      message:
                        "dual-kind plugin not selected for memory slot; skipping memory embedding provider registration",
                    });
                    return;
                  }
                } else if (
                  !(record.contracts?.memoryEmbeddingProviders ?? []).includes(adapter.id)
                ) {
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: ${adapter.id}`,
                  });
                  return;
                }
                const existing = getRegisteredMemoryEmbeddingProvider(adapter.id);
                if (existing) {
                  const ownerDetail = existing.ownerPluginId
                    ? ` (owner: ${existing.ownerPluginId})`
                    : "";
                  pushDiagnostic({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: `memory embedding provider already registered: ${adapter.id}${ownerDetail}`,
                  });
                  return;
                }
                registerMemoryEmbeddingProvider(adapter, {
                  ownerPluginId: record.id,
                });
                registry.memoryEmbeddingProviders.push({
                  pluginId: record.id,
                  pluginName: record.name,
                  provider: adapter,
                  source: record.source,
                  rootDir: record.rootDir,
                });
              },
              on: (hookName, handler, opts) =>
                registerTypedHook(record, hookName, handler, opts, params.hookPolicy),
            }
          : {}),
        ...(registrationCapabilities.setupRuntimeHandlers
          ? {
              registerHttpRoute: (routeParams) => registerHttpRoute(record, routeParams),
              registerGatewayMethod: (method, handler, opts) =>
                registerGatewayMethod(record, method, handler, opts),
            }
          : {}),
        // Allow setup-only/setup-runtime paths to surface parse-time CLI metadata
        // without opting into the wider full-registration surface.
        registerCli: (registrar, opts) => registerCli(record, registrar, opts),
        registerChannel: (registration) => registerChannel(record, registration, registrationMode),
      },
    });
  };

  const rollbackPluginGlobalSideEffects = (pluginId: string) => {
    deactivatePluginSideEffectGuards(pluginId);
    if (registryParams.activateGlobalSideEffects === false) {
      return;
    }

    clearPluginCommandsForPlugin(pluginId);
    clearPluginInteractiveHandlersForPlugin(pluginId);
    clearContextEnginesForOwner(`plugin:${pluginId}`);

    const hookRollbackEntries = pluginHookRollback.get(pluginId) ?? [];
    for (const entry of hookRollbackEntries.toReversed()) {
      const activeRegistrations = activePluginHookRegistrations.get(entry.name) ?? [];
      for (const registration of activeRegistrations) {
        unregisterInternalHook(registration.event, registration.handler);
      }

      if (entry.previousRegistrations.length === 0) {
        activePluginHookRegistrations.delete(entry.name);
        continue;
      }

      for (const registration of entry.previousRegistrations) {
        registerInternalHook(registration.event, registration.handler);
      }
      activePluginHookRegistrations.set(entry.name, [...entry.previousRegistrations]);
    }
    pluginHookRollback.delete(pluginId);
  };

  return {
    registry,
    createApi,
    rollbackPluginGlobalSideEffects,
    pushDiagnostic,
    registerTool,
    registerChannel,
    registerHostedMediaResolver,
    registerProvider,
    registerModelCatalogProvider,
    registerAgentHarness,
    registerCliBackend,
    registerTextTransforms,
    registerEmbeddingProvider: registerEmbeddingProviderForPlugin,
    registerSpeechProvider,
    registerRealtimeTranscriptionProvider,
    registerRealtimeVoiceProvider,
    registerMediaUnderstandingProvider,
    registerTranscriptSourceProvider,
    registerImageGenerationProvider,
    registerVideoGenerationProvider,
    registerMusicGenerationProvider,
    registerWebSearchProvider,
    registerMigrationProvider,
    registerGatewayMethod,
    registerCli,
    registerReload,
    registerNodeHostCommand,
    registerSecurityAuditCollector,
    registerService,
    registerCommand,
    registerSessionExtension,
    registerTrustedToolPolicy,
    registerToolMetadata,
    registerControlUiDescriptor,
    registerRuntimeLifecycle,
    registerAgentEventSubscription,
    registerSessionSchedulerJob,
    registerSessionAction,
    registerHook,
    registerTypedHook,
  };
}
