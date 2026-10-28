import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeStringEntries,
  uniqueValues,
} from "@openclaw/normalization-core/string-normalization";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { registerContextEngineInRegistry } from "../context-engine/registry.js";
import { DecisionProviderHost } from "../decisions/provider-host.js";
import type { InternalHookHandler } from "../hooks/internal-hook-types.js";
import type { HookEntry } from "../hooks/types.js";
import { withTimeout } from "../infra/fs-safe.js";
import type { AgentToolResultMiddleware } from "./agent-tool-result-middleware-types.js";
import {
  agentToolResultMiddlewareRegistrationCoversTool,
  appendAgentToolResultMiddlewareScope,
  normalizeAgentToolResultMiddlewareRuntimeIds,
  normalizeAgentToolResultMiddlewareRuntimes,
} from "./agent-tool-result-middleware.js";
import {
  resolveConversationAccessAllowed,
  resolvePromptInjectionAllowed,
} from "./hook-policy-decisions.js";
import { PLUGIN_HOOK_METADATA } from "./hook-types.js";
import { registerPluginInteractiveHandlerInRegistry } from "./interactive-registry.js";
import { recordPluginLoadDiagnostic } from "./load-diagnostics.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createHostRegistrars } from "./registry-registrars-host.js";
import { createNetworkRegistrars } from "./registry-registrars-network.js";
import { createOperationRegistrars } from "./registry-registrars-operations.js";
import { createProviderRegistrars } from "./registry-registrars-providers.js";
import {
  resolveTypedHookTimeoutMs,
  type PluginRegistryState,
  type PluginTypedHookPolicy,
} from "./registry-state.js";
import type {
  PluginAgentToolResultMiddlewareRegistration,
  PluginRecord,
} from "./registry-types.js";
import { defaultSlotIdForKey, hasKind } from "./slots.js";
import { normalizePluginToolContractNames, normalizePluginToolNames } from "./tool-contracts.js";
import { normalizePluginToolMatcher } from "./tool-hook-matcher.js";
import { inspectOpenDictionaryToolSchemas } from "./tool-schema-diagnostics.js";
import {
  isPluginHookAgentTrigger,
  isPluginHookName,
  isPluginHookReplyDispatchKind,
  isPromptInjectionHookName,
} from "./types.js";
import type {
  OpenClawPluginApi,
  PluginRegistrationMode,
  OpenClawPluginHookOptions,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  OpenClawPluginToolOptions,
  PluginHookHandlerMap,
  PluginHookName,
  PluginHookRegistrationOptions,
} from "./types.js";

function normalizeHookEligibility<T>(value: unknown, isEligible: (item: unknown) => item is T) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = Array.from(value);
  if (entries.length === 0 || !entries.every(isEligible)) {
    return undefined;
  }
  return uniqueValues(entries);
}

function canRegisterInstalledTrustedHook(record: PluginRecord): boolean {
  return record.origin === "bundled" || (record.enabled && record.explicitlyEnabled === true);
}

/** Compose domain registrars over one explicit mutable registry state. */
export function createPluginRegistrars(state: PluginRegistryState) {
  const { registry, reportRegistrationError, reportRegistrationWarning } = state;
  const providers = createProviderRegistrars(state);

  const registerDecisionProvider = (
    record: PluginRecord,
    provider: Parameters<OpenClawPluginApi["registerDecisionProvider"]>[0],
  ) => {
    const id = normalizeOptionalString(provider?.id);
    if (
      !id ||
      id !== provider.id ||
      id.includes("/") ||
      (provider.contractVersion !== 1 && provider.contractVersion !== 2) ||
      typeof provider.evaluate !== "function" ||
      (provider.contractVersion === 1 &&
        provider.isReady !== undefined &&
        typeof provider.isReady !== "function")
    ) {
      reportRegistrationError(record, "invalid versioned decision provider contract");
      return;
    }
    if (!record.contracts?.decisionProviders?.includes(id)) {
      reportRegistrationError(
        record,
        "decision provider must declare contracts.decisionProviders ownership",
      );
      return;
    }
    if (registry.decisionProviders.some((entry) => entry.host.provider.id === id)) {
      reportRegistrationError(record, `decision provider already registered: ${id}`);
      return;
    }
    let canonical = registry.providers.find((entry) => entry.provider.id === id);
    if (provider.contractVersion === 2) {
      if (canonical && canonical.pluginId !== record.id) {
        reportRegistrationError(
          record,
          `decision provider identity is owned by another plugin: ${id}`,
        );
        return;
      }
      if (canonical && provider.provider) {
        reportRegistrationError(
          record,
          `provider already registered; omit the duplicate definition: ${id}`,
        );
        return;
      }
      if (!canonical) {
        if (!provider.provider) {
          reportRegistrationError(
            record,
            `version 2 decisions require a shared provider definition: ${id}`,
          );
          return;
        }
        providers.registerProvider(record, { ...provider.provider, id });
        canonical = registry.providers.find(
          (entry) => entry.provider.id === id && entry.pluginId === record.id,
        );
        if (!canonical) {
          return;
        }
      }
    }
    const host = new DecisionProviderHost(provider, record, canonical);
    registry.decisionProviders.push({ pluginId: record.id, host });
    record.services.push(`decisions:${id}`);
    getPluginInstance(record)?.lifecycle.onDispose(() => host.stop());
    // The service is a physical-settlement owner. Reload also closes admission
    // before earlier sidecar and memory drains can wait on decision work.
    registry.services.push({
      pluginId: record.id,
      id: `decisions:${id}`,
      origin: record.origin,
      source: record.source,
      service: { id: `decisions:${id}`, start() {}, stop: () => host.stop() },
    });
  };

  const registerInteractiveHandler = (
    record: PluginRecord,
    registration: Parameters<OpenClawPluginApi["registerInteractiveHandler"]>[0],
  ) => {
    const result = registerPluginInteractiveHandlerInRegistry(registry, record.id, registration, {
      pluginName: record.name,
      pluginRoot: record.rootDir,
    });
    if (!result.ok) {
      reportRegistrationWarning(record, result.error ?? "interactive handler registration failed");
    }
  };

  const registerContextEngine = (
    record: PluginRecord,
    id: Parameters<OpenClawPluginApi["registerContextEngine"]>[0],
    factory: Parameters<OpenClawPluginApi["registerContextEngine"]>[1],
    registrationMode: PluginRegistrationMode,
  ) => {
    const normalizedId = normalizeOptionalString(id) ?? "";
    if (!normalizedId) {
      reportRegistrationError(record, "context engine registration missing id");
      return;
    }
    if (typeof factory !== "function") {
      reportRegistrationError(
        record,
        `context engine "${normalizedId}" registration missing factory`,
      );
      return;
    }
    if (normalizedId === defaultSlotIdForKey("contextEngine")) {
      reportRegistrationError(record, `context engine id reserved by core: ${normalizedId}`);
      return;
    }
    if (
      record.declaredContextEngineIds &&
      !record.declaredContextEngineIds.includes(normalizedId)
    ) {
      reportRegistrationError(
        record,
        `context engine "${normalizedId}" is not declared in manifest contextEngineIds`,
      );
      return;
    }
    getPluginInstance(record)?.admitFactory(factory);
    const result = registerContextEngineInRegistry(
      registry,
      normalizedId,
      factory,
      `plugin:${record.id}`,
      {
        allowSameOwnerRefresh: true,
        lifecycle: registrationMode === "full" ? "runtime" : "readOnlyDiscovery",
      },
    );
    if (!result.ok) {
      reportRegistrationError(
        record,
        result.existingOwner === null
          ? `context engine has no approved selected owner: ${normalizedId}`
          : `context engine already registered: ${normalizedId} (${result.existingOwner})`,
      );
      return;
    }
    if (!record.contextEngineIds?.includes(normalizedId)) {
      record.contextEngineIds = [...(record.contextEngineIds ?? []), normalizedId];
    }
  };

  const registerCompactionProvider = (
    record: PluginRecord,
    provider: Parameters<OpenClawPluginApi["registerCompactionProvider"]>[0],
  ) => {
    const id = normalizeOptionalString(provider?.id);
    if (!id) {
      reportRegistrationError(record, "compaction provider registration missing id");
      return;
    }
    if (typeof provider?.summarize !== "function") {
      reportRegistrationError(record, `compaction provider "${id}" registration missing summarize`);
      return;
    }
    const existing = registry.compactionProviders.find((entry) => entry.provider.id === id);
    if (existing) {
      const ownerDetail = existing.ownerPluginId ? ` (owner: ${existing.ownerPluginId})` : "";
      reportRegistrationError(
        record,
        `compaction provider already registered: ${id}${ownerDetail}`,
      );
      return;
    }
    registry.compactionProviders.push({ provider, ownerPluginId: record.id });
  };

  const registerMemoryCapability = (
    record: PluginRecord,
    capability: Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0],
  ) => {
    if (!hasKind(record.kind, "memory")) {
      throw new Error("only memory plugins can register a memory capability");
    }
    if (Array.isArray(record.kind) && record.kind.length > 1 && !record.memorySlotSelected) {
      reportRegistrationWarning(
        record,
        "dual-kind plugin not selected for memory slot; skipping memory capability registration",
      );
      return;
    }
    // Dreaming keeps an unselected sidecar active for consolidation. Strip its
    // slot-owner fields so resolution cannot lend its runtime or recall grant.
    const memorySlotSelected = record.memorySlotSelected === true;
    const dropsSlotOwnerFacts =
      !memorySlotSelected &&
      (capability.runtime !== undefined ||
        capability.providerRuntime !== undefined ||
        capability.recallToolNames !== undefined ||
        capability.deterministicRecallToolName !== undefined ||
        capability.supportsPrivateTranscriptRecall !== undefined ||
        capability.learnToolNames !== undefined ||
        capability.learnGuidanceBuilder !== undefined);
    if (dropsSlotOwnerFacts) {
      reportRegistrationWarning(
        record,
        "memory plugin not selected for the memory slot; skipping its indexing runtime, recall and learn registration (consolidation lifecycle preserved)",
      );
    }
    const {
      runtime: _droppedRuntime,
      providerRuntime: _droppedProviderRuntime,
      recallToolNames: _droppedRecallToolNames,
      deterministicRecallToolName: _droppedRecallToolName,
      supportsPrivateTranscriptRecall: _droppedPrivateRecall,
      learnToolNames: _droppedLearnToolNames,
      learnGuidanceBuilder: _droppedLearnGuidanceBuilder,
      ...consolidationCapability
    } = capability;
    if (memorySlotSelected && capability.runtime) {
      // oxlint-disable-next-line typescript/unbound-method -- Record factory identity; executable views bind the original receiver.
      getPluginInstance(record)?.admitFactory(capability.runtime.getMemorySearchManager);
    }
    registry.memoryCapabilities.push({
      pluginId: record.id,
      capability: memorySlotSelected ? capability : consolidationCapability,
      memorySlotSelected,
    });
  };

  const registerMemoryPromptSupplement = (
    record: PluginRecord,
    builder: Parameters<OpenClawPluginApi["registerMemoryPromptSupplement"]>[0],
  ) => {
    if (typeof builder !== "function") {
      reportRegistrationError(record, "memory prompt supplement registration missing builder");
      return;
    }
    registry.memoryPromptSupplements = registry.memoryPromptSupplements.filter(
      (entry) => entry.pluginId !== record.id,
    );
    registry.memoryPromptSupplements.push({ pluginId: record.id, builder });
  };

  const registerMemoryPromptPreparation = (
    record: PluginRecord,
    prepare: Parameters<OpenClawPluginApi["registerMemoryPromptPreparation"]>[0],
  ) => {
    if (typeof prepare !== "function") {
      reportRegistrationError(
        record,
        "memory prompt preparation registration missing prepare function",
      );
      return;
    }
    registry.memoryPromptPreparations = registry.memoryPromptPreparations.filter(
      (entry) => entry.pluginId !== record.id,
    );
    registry.memoryPromptPreparations.push({ pluginId: record.id, prepare });
  };

  const registerMemoryCorpusSupplement = (
    record: PluginRecord,
    supplement: Parameters<OpenClawPluginApi["registerMemoryCorpusSupplement"]>[0],
  ) => {
    registry.memoryCorpusSupplements = registry.memoryCorpusSupplements.filter(
      (entry) => entry.pluginId !== record.id,
    );
    registry.memoryCorpusSupplements.push({ pluginId: record.id, supplement });
  };

  const { createRegistration, registryParams, pluginsWithChannelRegistrationConflict } = state;
  const declaredToolNames = new WeakMap<PluginRecord, ReadonlySet<string>>();

  const registerAgentToolResultMiddleware = (
    record: PluginRecord,
    handler: Parameters<OpenClawPluginApi["registerAgentToolResultMiddleware"]>[0],
    options: Parameters<OpenClawPluginApi["registerAgentToolResultMiddleware"]>[1],
    policy?: PluginTypedHookPolicy,
  ) => {
    if (typeof handler !== "function") {
      reportRegistrationError(record, "agent tool result middleware must be a function");
      return;
    }
    const declared = normalizeAgentToolResultMiddlewareRuntimeIds(
      record.contracts?.agentToolResultMiddleware,
    );
    const runtimes = normalizeAgentToolResultMiddlewareRuntimes(options, declared);
    const matcher = normalizePluginToolMatcher(options?.matcher);
    if (runtimes.length === 0) {
      reportRegistrationError(
        record,
        "agent tool result middleware must target at least one supported runtime",
      );
      return;
    }
    const missing = runtimes.filter((runtime) => !declared.includes(runtime));
    if (missing.length > 0) {
      reportRegistrationError(
        record,
        `plugin must declare contracts.agentToolResultMiddleware for: ${missing.join(", ")}`,
      );
      return;
    }
    if (!canRegisterInstalledTrustedHook(record)) {
      reportRegistrationError(
        record,
        "plugin must be explicitly enabled to register agent tool result middleware",
      );
      return;
    }
    const existing = registry.agentToolResultMiddlewares.find(
      (entry) => entry.pluginId === record.id && entry.rawHandler === handler,
    );
    if (existing) {
      appendAgentToolResultMiddlewareScope(existing, { runtimes, matcher });
      return;
    }
    const timeoutMs = resolveTypedHookTimeoutMs({ hookName: "after_tool_call", policy });
    const safeHandler: AgentToolResultMiddleware = async (event, ctx) => {
      if (
        !agentToolResultMiddlewareRegistrationCoversTool(registration, ctx.runtime, event.toolName)
      ) {
        return;
      }
      try {
        // fs-safe bounds only this await; it cannot cancel plugin work, so late side effects remain possible.
        return await withTimeout(
          Promise.resolve(handler(event, ctx)),
          timeoutMs ?? 0,
          `agent tool result middleware for ${record.id}`,
        );
      } catch (error) {
        registryParams.logger.warn(
          `[plugins] agent tool result middleware failed for ${record.id}`,
        );
        throw error;
      }
    };
    const registration: PluginAgentToolResultMiddlewareRegistration = {
      ...createRegistration(record, {
        handler: safeHandler,
        runtimes,
        scopes: [{ runtimes, ...(matcher ? { matcher } : {}) }],
      }),
      rawHandler: handler,
    };
    registry.agentToolResultMiddlewares.push(registration);
  };

  const registerTool = (
    record: PluginRecord,
    tool: AnyAgentTool | OpenClawPluginToolFactory | OpenClawPluginToolFactory<2>,
    opts?: OpenClawPluginToolOptions,
  ) => {
    if (pluginsWithChannelRegistrationConflict.has(record.id)) {
      return;
    }
    let declaredNames = declaredToolNames.get(record);
    if (!declaredNames) {
      declaredNames = new Set(normalizePluginToolContractNames(record.contracts));
      declaredToolNames.set(record, declaredNames);
    }
    if (declaredNames.size === 0) {
      reportRegistrationError(
        record,
        "plugin must declare contracts.tools before registering agent tools",
      );
      return;
    }
    const names = [...(opts?.names ?? []), ...(opts?.name ? [opts.name] : [])];
    const optional = opts?.optional === true;
    const versioned = typeof tool !== "function" && "contextVersion" in tool;
    if (versioned && (tool.contextVersion !== 2 || typeof tool.create !== "function")) {
      reportRegistrationError(record, "unsupported plugin tool context version");
      return;
    }
    const factory: OpenClawPluginToolFactory =
      typeof tool === "function"
        ? tool
        : versioned
          ? (ctx) => {
              if (!ctx.assertInvocationCurrent) {
                throw new Error("Version 2 tool factories require host invocation authority");
              }
              return tool.create({
                ...ctx,
                get senderIsOwner() {
                  return ctx.senderIsOwner;
                },
                assertInvocationCurrent: ctx.assertInvocationCurrent,
              });
            }
          : (_ctx: OpenClawPluginToolContext) => tool;
    if (typeof tool !== "function" && !versioned) {
      names.push(tool.name);
    }
    const normalized = normalizePluginToolNames(names);
    if (opts?.gatewayHandoffMethods && (!versioned || normalized.length !== 1)) {
      reportRegistrationError(record, "gateway handoff requires exactly one version-2 tool name");
      return;
    }
    const undeclared = normalized.filter((name) => !declaredNames.has(name));
    if (undeclared.length > 0) {
      reportRegistrationError(
        record,
        `plugin must declare contracts.tools for: ${undeclared.join(", ")}`,
      );
      return;
    }
    if (normalized.length > 0) {
      record.toolNames.push(...normalized);
    }
    const warnedTools = new Set<string>();
    const diagnose = (tools: AnyAgentTool[]) => {
      for (const diagnostic of inspectOpenDictionaryToolSchemas(tools, warnedTools)) {
        warnedTools.add(diagnostic.toolName);
        const paths = diagnostic.violations.slice(0, 12);
        const remaining = diagnostic.violations.length - paths.length;
        const summary = paths.join(", ") + (remaining > 0 ? `, +${remaining} more` : "");
        const warning: PluginDiagnostic = {
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `tool "${diagnostic.toolName}": open object without declared properties, patternProperties, or additionalProperties will be closed on strict-compat providers (${summary}). Use explicit additionalProperties: true or openRecord(description) for dictionaries.`,
        };
        state.pushDiagnostic(warning);
        recordPluginLoadDiagnostic(warning);
      }
    };
    if (typeof tool !== "function" && !versioned) {
      // Static schemas are inspected eagerly, best-effort; their accessors stay intact
      // so unreadable schemas still reach per-tool runtime quarantine.
      diagnose([tool]);
    }
    const inspectedFactory: OpenClawPluginToolFactory = (ctx) => {
      const result = factory(ctx);
      if (result) {
        diagnose(Array.isArray(result) ? result : [result]);
      }
      return result;
    };
    getPluginInstance(record)?.admitFactory(inspectedFactory, "tool");
    registry.tools.push({
      ...createRegistration(record, {
        factory: inspectedFactory,
        ...(versioned ? { contextVersion: 2 as const } : {}),
        names: normalized,
        ...(opts?.gatewayHandoffMethods
          ? { gatewayHandoffMethods: Object.freeze([...opts.gatewayHandoffMethods]) }
          : {}),
        optional,
        workspaceAccess:
          opts?.workspaceAccess ?? (typeof tool !== "function" && !versioned ? "execute" : true),
        origin: record.origin,
      }),
      // Host-owned membership must not re-enter the callable wrapper's graph walk.
      declaredNames,
    });
  };

  const registerHook = (
    record: PluginRecord,
    events: string | string[],
    handler: InternalHookHandler,
    opts: OpenClawPluginHookOptions | undefined,
    config: OpenClawPluginApi["config"],
    pluginConfig: unknown,
  ) => {
    const normalizedEvents = normalizeStringEntries(Array.isArray(events) ? events : [events]);
    // Typed lifecycle names (before_tool_call, message_received, ...) are dispatched only by
    // the typed hook runner; registerHook uses the legacy internal-hook path so they never
    // fire. Warn so authors move to `api.on(...)` instead of trusting a false "loaded".
    for (const event of normalizedEvents) {
      if (isPluginHookName(event)) {
        reportRegistrationWarning(
          record,
          `hook event "${event}" is dispatched by the typed hook runner only; ` +
            `api.registerHook registrations for it are not invoked. ` +
            `Use api.on("${event}", ...) instead.`,
        );
      }
    }
    const entry = opts?.entry ?? null;
    const hookName = entry?.hook.name ?? opts?.name?.trim();
    if (!hookName) {
      throw new Error("hook registration missing name");
    }
    const existingHook = registry.hooks.find(
      (entryLocal) => entryLocal.entry.hook.name === hookName,
    );
    if (existingHook) {
      reportRegistrationError(
        record,
        `hook already registered: ${hookName} (${existingHook.pluginId})`,
      );
      return;
    }
    const description = entry?.hook.description ?? opts?.description ?? "";
    const hookEntry: HookEntry = {
      ...(entry ?? { frontmatter: {}, invocation: { enabled: true } }),
      hook: {
        ...(entry?.hook ?? {
          filePath: record.source,
          baseDir: path.dirname(record.source),
          handlerPath: record.source,
        }),
        name: hookName,
        description,
        source: "openclaw-plugin",
        pluginId: record.id,
      },
      metadata: { ...entry?.metadata, events: normalizedEvents },
    };
    record.hookNames.push(hookName);
    registry.hooks.push({
      pluginId: record.id,
      entry: hookEntry,
      events: normalizedEvents,
      source: record.source,
    });
    const hookSystemEnabled = config?.hooks?.internal?.enabled !== false;
    if (!hookSystemEnabled || opts?.register === false) {
      return;
    }
    for (const event of normalizedEvents) {
      const wrappedHandler: typeof handler = async (evt) => {
        const context = evt.context;
        const hadPluginConfig = Object.hasOwn(context, "pluginConfig");
        const previousPluginConfig = context.pluginConfig;
        // Internal hooks share one context; restore per-plugin config after each handler.
        context.pluginConfig = pluginConfig;
        try {
          return await handler({ ...evt, context });
        } finally {
          if (hadPluginConfig) {
            context.pluginConfig = previousPluginConfig;
          } else {
            delete context.pluginConfig;
          }
        }
      };
      registry.legacyInternalHooks.push({
        pluginId: record.id,
        name: hookName,
        event,
        handler: wrappedHandler,
      });
    }
  };

  const registerTypedHook = <K extends PluginHookName>(
    record: PluginRecord,
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: PluginHookRegistrationOptions<K>,
    policy?: PluginTypedHookPolicy,
  ) => {
    if (!isPluginHookName(hookName)) {
      reportRegistrationWarning(record, `unknown typed hook "${String(hookName)}" ignored`);
      return;
    }
    if (!resolvePromptInjectionAllowed(policy) && isPromptInjectionHookName(hookName)) {
      reportRegistrationWarning(
        record,
        `typed hook "${hookName}" blocked by plugins.entries.${record.id}.hooks.allowPromptInjection=false`,
      );
      return;
    }
    const conversationAccessAllowed = resolveConversationAccessAllowed(record.origin, policy);
    if (PLUGIN_HOOK_METADATA[hookName].conversationAccess && !conversationAccessAllowed) {
      if (record.origin !== "bundled") {
        reportRegistrationWarning(
          record,
          `typed hook "${hookName}" blocked because non-bundled plugins must set ` +
            `plugins.entries.${record.id}.hooks.allowConversationAccess=true`,
        );
        return;
      }
      reportRegistrationWarning(
        record,
        `typed hook "${hookName}" blocked by plugins.entries.${record.id}.hooks.allowConversationAccess=false`,
      );
      return;
    }
    const timeoutMs = resolveTypedHookTimeoutMs({ hookName, opts, policy });
    const eligibleTriggers =
      hookName === "before_agent_reply"
        ? normalizeHookEligibility(opts?.eligibleTriggers, isPluginHookAgentTrigger)
        : undefined;
    const eligibleDispatchKinds =
      hookName === "reply_dispatch"
        ? normalizeHookEligibility(opts?.eligibleDispatchKinds, isPluginHookReplyDispatchKind)
        : undefined;
    const matcher =
      hookName === "before_tool_call" || hookName === "after_tool_call"
        ? normalizePluginToolMatcher(opts?.matcher)
        : undefined;
    if (opts?.matcher && hookName !== "before_tool_call" && hookName !== "after_tool_call") {
      reportRegistrationWarning(record, `typed hook "${hookName}" ignores tool matcher`);
    }
    record.hookCount += 1;
    registry.typedHooks.push({
      pluginId: record.id,
      ...(opts?.registrationId ? { registrationId: opts.registrationId } : {}),
      hookName,
      handler,
      ...(matcher ? { matcher } : {}),
      priority: opts?.priority,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(eligibleTriggers ? { eligibleTriggers } : {}),
      ...(eligibleDispatchKinds ? { eligibleDispatchKinds } : {}),
      ...(hookName === "before_prompt_build" && opts?.requiresToolAuthority === true
        ? { requiresToolAuthority: true }
        : {}),
      ...(hookName === "session_end" && conversationAccessAllowed
        ? { conversationAccessAllowed: true }
        : {}),
      source: record.source,
    });
  };

  return {
    registerDecisionProvider,
    registerInteractiveHandler,
    registerContextEngine,
    registerCompactionProvider,
    registerAgentToolResultMiddleware,
    registerTool,
    registerHook,
    registerTypedHook,
    ...createNetworkRegistrars(state),
    ...providers,
    ...createOperationRegistrars(state),
    ...createHostRegistrars(state),
    registerMemoryCapability,
    registerMemoryPromptSupplement,
    registerMemoryPromptPreparation,
    registerMemoryCorpusSupplement,
    registerModelCatalogProvider: state.registerModelCatalogProvider,
  };
}

export type PluginRegistrars = ReturnType<typeof createPluginRegistrars>;
