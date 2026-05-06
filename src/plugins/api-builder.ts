/**
 * api-builder.ts — Plugin API assembly
 *
 * Constructs the `OpenClawPluginApi` object that plugins receive in their
 * `init()` function. Follows a "partial implementation with safe defaults"
 * pattern: each API method either delegates to a real handler (provided by
 * the registry) or falls back to a noop that silently accepts valid inputs
 * and does nothing. This lets plugins register only the capabilities they
 * need while keeping the full interface type-safe.
 *
 * The noop fallbacks (all the `noop*` functions below) are critical safety
 * nets — without them, a plugin accessing an unregistered API method would
 * crash at runtime with `undefined is not a function`.
 */

import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi, PluginLogger } from "./types.js";

/**
 * Parameters for building a plugin API instance.
 *
 * @param id - Unique plugin identifier (e.g. "momo-kanban")
 * @param handlers - Optional map of real implementations. Any method not
 *   provided here gets a noop that consumes valid input and returns a safe
 *   "did nothing" value. This is by design — plugins shouldn't crash just
 *   because they call an API method the registry didn't wire up.
 */
export type BuildPluginApiParams = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  rootDir?: string;
  registrationMode: OpenClawPluginApi["registrationMode"];
  config: OpenClawConfig;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  resolvePath: (input: string) => string;
  handlers?: Partial<
    Pick<
      OpenClawPluginApi,
      | "registerTool"
      | "registerHook"
      | "registerHttpRoute"
      | "registerChannel"
      | "registerGatewayMethod"
      | "registerCli"
      | "registerReload"
      | "registerNodeHostCommand"
      | "registerNodeInvokePolicy"
      | "registerSecurityAuditCollector"
      | "registerService"
      | "registerGatewayDiscoveryService"
      | "registerCliBackend"
      | "registerTextTransforms"
      | "registerConfigMigration"
      | "registerMigrationProvider"
      | "registerAutoEnableProbe"
      | "registerProvider"
      | "registerSpeechProvider"
      | "registerRealtimeTranscriptionProvider"
      | "registerRealtimeVoiceProvider"
      | "registerMediaUnderstandingProvider"
      | "registerImageGenerationProvider"
      | "registerVideoGenerationProvider"
      | "registerMusicGenerationProvider"
      | "registerWebFetchProvider"
      | "registerWebSearchProvider"
      | "registerInteractiveHandler"
      | "onConversationBindingResolved"
      | "registerCommand"
      | "registerContextEngine"
      | "registerCompactionProvider"
      | "registerAgentHarness"
      | "registerCodexAppServerExtensionFactory"
      | "registerAgentToolResultMiddleware"
      | "registerSessionExtension"
      | "enqueueNextTurnInjection"
      | "registerTrustedToolPolicy"
      | "registerToolMetadata"
      | "registerControlUiDescriptor"
      | "registerRuntimeLifecycle"
      | "registerAgentEventSubscription"
      | "setRunContext"
      | "getRunContext"
      | "clearRunContext"
      | "registerSessionSchedulerJob"
      | "registerDetachedTaskRuntime"
      | "registerMemoryCapability"
      | "registerMemoryPromptSection"
      | "registerMemoryPromptSupplement"
      | "registerMemoryCorpusSupplement"
      | "registerMemoryFlushPlan"
      | "registerMemoryRuntime"
      | "registerMemoryEmbeddingProvider"
      | "on"
    >
  >;
};

// ============================================================
// Noop default implementations
//
// Every method on OpenClawPluginApi has a corresponding noop. When a
// plugin init() calls a method that wasn't wired by the registry, the
// noop absorbs the call silently instead of throwing TypeError.
//
// Each noop matches its real signature but returns a safe "did nothing"
// sentinel value (e.g., false, undefined, or { enqueued: false }).
// ============================================================

const noopRegisterTool: OpenClawPluginApi["registerTool"] = () => {};
const noopRegisterHook: OpenClawPluginApi["registerHook"] = () => {};
const noopRegisterHttpRoute: OpenClawPluginApi["registerHttpRoute"] = () => {};
const noopRegisterChannel: OpenClawPluginApi["registerChannel"] = () => {};
const noopRegisterGatewayMethod: OpenClawPluginApi["registerGatewayMethod"] = () => {};
const noopRegisterCli: OpenClawPluginApi["registerCli"] = () => {};
const noopRegisterReload: OpenClawPluginApi["registerReload"] = () => {};
const noopRegisterNodeHostCommand: OpenClawPluginApi["registerNodeHostCommand"] = () => {};
const noopRegisterNodeInvokePolicy: OpenClawPluginApi["registerNodeInvokePolicy"] = () => {};
const noopRegisterSecurityAuditCollector: OpenClawPluginApi["registerSecurityAuditCollector"] =
  () => {};
const noopRegisterService: OpenClawPluginApi["registerService"] = () => {};
const noopRegisterGatewayDiscoveryService: OpenClawPluginApi["registerGatewayDiscoveryService"] =
  () => {};
const noopRegisterCliBackend: OpenClawPluginApi["registerCliBackend"] = () => {};
const noopRegisterTextTransforms: OpenClawPluginApi["registerTextTransforms"] = () => {};
const noopRegisterConfigMigration: OpenClawPluginApi["registerConfigMigration"] = () => {};
const noopRegisterMigrationProvider: OpenClawPluginApi["registerMigrationProvider"] = () => {};
const noopRegisterAutoEnableProbe: OpenClawPluginApi["registerAutoEnableProbe"] = () => {};
const noopRegisterProvider: OpenClawPluginApi["registerProvider"] = () => {};
const noopRegisterSpeechProvider: OpenClawPluginApi["registerSpeechProvider"] = () => {};
const noopRegisterRealtimeTranscriptionProvider: OpenClawPluginApi["registerRealtimeTranscriptionProvider"] =
  () => {};
const noopRegisterRealtimeVoiceProvider: OpenClawPluginApi["registerRealtimeVoiceProvider"] =
  () => {};
const noopRegisterMediaUnderstandingProvider: OpenClawPluginApi["registerMediaUnderstandingProvider"] =
  () => {};
const noopRegisterImageGenerationProvider: OpenClawPluginApi["registerImageGenerationProvider"] =
  () => {};
const noopRegisterVideoGenerationProvider: OpenClawPluginApi["registerVideoGenerationProvider"] =
  () => {};
const noopRegisterMusicGenerationProvider: OpenClawPluginApi["registerMusicGenerationProvider"] =
  () => {};
const noopRegisterWebFetchProvider: OpenClawPluginApi["registerWebFetchProvider"] = () => {};
const noopRegisterWebSearchProvider: OpenClawPluginApi["registerWebSearchProvider"] = () => {};
const noopRegisterInteractiveHandler: OpenClawPluginApi["registerInteractiveHandler"] = () => {};
const noopOnConversationBindingResolved: OpenClawPluginApi["onConversationBindingResolved"] =
  () => {};
const noopRegisterCommand: OpenClawPluginApi["registerCommand"] = () => {};
const noopRegisterContextEngine: OpenClawPluginApi["registerContextEngine"] = () => {};
const noopRegisterCompactionProvider: OpenClawPluginApi["registerCompactionProvider"] = () => {};
const noopRegisterAgentHarness: OpenClawPluginApi["registerAgentHarness"] = () => {};
const noopRegisterCodexAppServerExtensionFactory: OpenClawPluginApi["registerCodexAppServerExtensionFactory"] =
  () => {};
const noopRegisterAgentToolResultMiddleware: OpenClawPluginApi["registerAgentToolResultMiddleware"] =
  () => {};
const noopRegisterSessionExtension: OpenClawPluginApi["registerSessionExtension"] = () => {};
/**
 * Noop for enqueueNextTurnInjection — returns a clearly-failed result
 * so callers can detect that injection wasn't actually queued.
 */
const noopEnqueueNextTurnInjection: OpenClawPluginApi["enqueueNextTurnInjection"] = async (
  injection,
) => ({ enqueued: false, id: "", sessionKey: injection.sessionKey });
const noopRegisterTrustedToolPolicy: OpenClawPluginApi["registerTrustedToolPolicy"] = () => {};
const noopRegisterToolMetadata: OpenClawPluginApi["registerToolMetadata"] = () => {};
const noopRegisterControlUiDescriptor: OpenClawPluginApi["registerControlUiDescriptor"] = () => {};
const noopRegisterRuntimeLifecycle: OpenClawPluginApi["registerRuntimeLifecycle"] = () => {};
const noopRegisterAgentEventSubscription: OpenClawPluginApi["registerAgentEventSubscription"] =
  () => {};
const noopSetRunContext: OpenClawPluginApi["setRunContext"] = () => false;
const noopGetRunContext: OpenClawPluginApi["getRunContext"] = () => undefined;
const noopClearRunContext: OpenClawPluginApi["clearRunContext"] = () => {};
const noopRegisterSessionSchedulerJob: OpenClawPluginApi["registerSessionSchedulerJob"] = () =>
  undefined;
const noopRegisterDetachedTaskRuntime: OpenClawPluginApi["registerDetachedTaskRuntime"] = () => {};
const noopRegisterMemoryCapability: OpenClawPluginApi["registerMemoryCapability"] = () => {};
const noopRegisterMemoryPromptSection: OpenClawPluginApi["registerMemoryPromptSection"] = () => {};
const noopRegisterMemoryPromptSupplement: OpenClawPluginApi["registerMemoryPromptSupplement"] =
  () => {};
const noopRegisterMemoryCorpusSupplement: OpenClawPluginApi["registerMemoryCorpusSupplement"] =
  () => {};
const noopRegisterMemoryFlushPlan: OpenClawPluginApi["registerMemoryFlushPlan"] = () => {};
const noopRegisterMemoryRuntime: OpenClawPluginApi["registerMemoryRuntime"] = () => {};
const noopRegisterMemoryEmbeddingProvider: OpenClawPluginApi["registerMemoryEmbeddingProvider"] =
  () => {};
const noopOn: OpenClawPluginApi["on"] = () => {};

/**
 * Assemble a fully-typed OpenClawPluginApi instance.
 *
 * Merges the provided real handlers (from the registry) with noop defaults.
 * The result is a safe, fully-functional API object that a plugin can call
 * without null-checking every method.
 *
 * @param params - Handlers + metadata. See BuildPluginApiParams.
 * @returns A complete OpenClawPluginApi — real handlers where provided,
 *   noop fallbacks everywhere else.
 */
export function buildPluginApi(params: BuildPluginApiParams): OpenClawPluginApi {
  const handlers = params.handlers ?? {};
  return {
    id: params.id,
    name: params.name,
    version: params.version,
    description: params.description,
    source: params.source,
    rootDir: params.rootDir,
    registrationMode: params.registrationMode,
    config: params.config,
    pluginConfig: params.pluginConfig,
    runtime: params.runtime,
    logger: params.logger,
    registerTool: handlers.registerTool ?? noopRegisterTool,
    registerHook: handlers.registerHook ?? noopRegisterHook,
    registerHttpRoute: handlers.registerHttpRoute ?? noopRegisterHttpRoute,
    registerChannel: handlers.registerChannel ?? noopRegisterChannel,
    registerGatewayMethod: handlers.registerGatewayMethod ?? noopRegisterGatewayMethod,
    registerCli: handlers.registerCli ?? noopRegisterCli,
    registerReload: handlers.registerReload ?? noopRegisterReload,
    registerNodeHostCommand: handlers.registerNodeHostCommand ?? noopRegisterNodeHostCommand,
    registerNodeInvokePolicy: handlers.registerNodeInvokePolicy ?? noopRegisterNodeInvokePolicy,
    registerSecurityAuditCollector:
      handlers.registerSecurityAuditCollector ?? noopRegisterSecurityAuditCollector,
    registerService: handlers.registerService ?? noopRegisterService,
    registerGatewayDiscoveryService:
      handlers.registerGatewayDiscoveryService ?? noopRegisterGatewayDiscoveryService,
    registerCliBackend: handlers.registerCliBackend ?? noopRegisterCliBackend,
    registerTextTransforms: handlers.registerTextTransforms ?? noopRegisterTextTransforms,
    registerConfigMigration: handlers.registerConfigMigration ?? noopRegisterConfigMigration,
    registerMigrationProvider: handlers.registerMigrationProvider ?? noopRegisterMigrationProvider,
    registerAutoEnableProbe: handlers.registerAutoEnableProbe ?? noopRegisterAutoEnableProbe,
    registerProvider: handlers.registerProvider ?? noopRegisterProvider,
    registerSpeechProvider: handlers.registerSpeechProvider ?? noopRegisterSpeechProvider,
    registerRealtimeTranscriptionProvider:
      handlers.registerRealtimeTranscriptionProvider ?? noopRegisterRealtimeTranscriptionProvider,
    registerRealtimeVoiceProvider:
      handlers.registerRealtimeVoiceProvider ?? noopRegisterRealtimeVoiceProvider,
    registerMediaUnderstandingProvider:
      handlers.registerMediaUnderstandingProvider ?? noopRegisterMediaUnderstandingProvider,
    registerImageGenerationProvider:
      handlers.registerImageGenerationProvider ?? noopRegisterImageGenerationProvider,
    registerVideoGenerationProvider:
      handlers.registerVideoGenerationProvider ?? noopRegisterVideoGenerationProvider,
    registerMusicGenerationProvider:
      handlers.registerMusicGenerationProvider ?? noopRegisterMusicGenerationProvider,
    registerWebFetchProvider: handlers.registerWebFetchProvider ?? noopRegisterWebFetchProvider,
    registerWebSearchProvider: handlers.registerWebSearchProvider ?? noopRegisterWebSearchProvider,
    registerInteractiveHandler:
      handlers.registerInteractiveHandler ?? noopRegisterInteractiveHandler,
    onConversationBindingResolved:
      handlers.onConversationBindingResolved ?? noopOnConversationBindingResolved,
    registerCommand: handlers.registerCommand ?? noopRegisterCommand,
    registerContextEngine: handlers.registerContextEngine ?? noopRegisterContextEngine,
    registerCompactionProvider:
      handlers.registerCompactionProvider ?? noopRegisterCompactionProvider,
    registerAgentHarness: handlers.registerAgentHarness ?? noopRegisterAgentHarness,
    registerCodexAppServerExtensionFactory:
      handlers.registerCodexAppServerExtensionFactory ?? noopRegisterCodexAppServerExtensionFactory,
    registerAgentToolResultMiddleware:
      handlers.registerAgentToolResultMiddleware ?? noopRegisterAgentToolResultMiddleware,
    registerSessionExtension: handlers.registerSessionExtension ?? noopRegisterSessionExtension,
    enqueueNextTurnInjection: handlers.enqueueNextTurnInjection ?? noopEnqueueNextTurnInjection,
    registerTrustedToolPolicy: handlers.registerTrustedToolPolicy ?? noopRegisterTrustedToolPolicy,
    registerToolMetadata: handlers.registerToolMetadata ?? noopRegisterToolMetadata,
    registerControlUiDescriptor:
      handlers.registerControlUiDescriptor ?? noopRegisterControlUiDescriptor,
    registerRuntimeLifecycle: handlers.registerRuntimeLifecycle ?? noopRegisterRuntimeLifecycle,
    registerAgentEventSubscription:
      handlers.registerAgentEventSubscription ?? noopRegisterAgentEventSubscription,
    setRunContext: handlers.setRunContext ?? noopSetRunContext,
    getRunContext: handlers.getRunContext ?? noopGetRunContext,
    clearRunContext: handlers.clearRunContext ?? noopClearRunContext,
    registerSessionSchedulerJob:
      handlers.registerSessionSchedulerJob ?? noopRegisterSessionSchedulerJob,
    registerDetachedTaskRuntime:
      handlers.registerDetachedTaskRuntime ?? noopRegisterDetachedTaskRuntime,
    registerMemoryCapability: handlers.registerMemoryCapability ?? noopRegisterMemoryCapability,
    registerMemoryPromptSection:
      handlers.registerMemoryPromptSection ?? noopRegisterMemoryPromptSection,
    registerMemoryPromptSupplement:
      handlers.registerMemoryPromptSupplement ?? noopRegisterMemoryPromptSupplement,
    registerMemoryCorpusSupplement:
      handlers.registerMemoryCorpusSupplement ?? noopRegisterMemoryCorpusSupplement,
    registerMemoryFlushPlan: handlers.registerMemoryFlushPlan ?? noopRegisterMemoryFlushPlan,
    registerMemoryRuntime: handlers.registerMemoryRuntime ?? noopRegisterMemoryRuntime,
    registerMemoryEmbeddingProvider:
      handlers.registerMemoryEmbeddingProvider ?? noopRegisterMemoryEmbeddingProvider,
    resolvePath: params.resolvePath,
    on: handlers.on ?? noopOn,
  };
}
