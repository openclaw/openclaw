import type { MullusiConfig } from "../config/config.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { MullusiPluginApi, PluginLogger } from "./types.js";

export type BuildPluginApiParams = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  rootDir?: string;
  registrationMode: MullusiPluginApi["registrationMode"];
  config: MullusiConfig;
  pluginConfig?: Record<string, unknown>;
  runtime: PluginRuntime;
  logger: PluginLogger;
  resolvePath: (input: string) => string;
  handlers?: Partial<
    Pick<
      MullusiPluginApi,
      | "registerTool"
      | "registerHook"
      | "registerHttpRoute"
      | "registerChannel"
      | "registerGatewayMethod"
      | "registerCli"
      | "registerService"
      | "registerCliBackend"
      | "registerProvider"
      | "registerSpeechProvider"
      | "registerRealtimeTranscriptionProvider"
      | "registerRealtimeVoiceProvider"
      | "registerMediaUnderstandingProvider"
      | "registerImageGenerationProvider"
      | "registerVideoGenerationProvider"
      | "registerWebFetchProvider"
      | "registerWebSearchProvider"
      | "registerInteractiveHandler"
      | "onConversationBindingResolved"
      | "registerCommand"
      | "registerContextEngine"
      | "registerMemoryPromptSection"
      | "registerMemoryFlushPlan"
      | "registerMemoryRuntime"
      | "registerMemoryEmbeddingProvider"
      | "on"
    >
  >;
};

const noopRegisterTool: MullusiPluginApi["registerTool"] = () => {};
const noopRegisterHook: MullusiPluginApi["registerHook"] = () => {};
const noopRegisterHttpRoute: MullusiPluginApi["registerHttpRoute"] = () => {};
const noopRegisterChannel: MullusiPluginApi["registerChannel"] = () => {};
const noopRegisterGatewayMethod: MullusiPluginApi["registerGatewayMethod"] = () => {};
const noopRegisterCli: MullusiPluginApi["registerCli"] = () => {};
const noopRegisterService: MullusiPluginApi["registerService"] = () => {};
const noopRegisterCliBackend: MullusiPluginApi["registerCliBackend"] = () => {};
const noopRegisterProvider: MullusiPluginApi["registerProvider"] = () => {};
const noopRegisterSpeechProvider: MullusiPluginApi["registerSpeechProvider"] = () => {};
const noopRegisterRealtimeTranscriptionProvider: MullusiPluginApi["registerRealtimeTranscriptionProvider"] =
  () => {};
const noopRegisterRealtimeVoiceProvider: MullusiPluginApi["registerRealtimeVoiceProvider"] =
  () => {};
const noopRegisterMediaUnderstandingProvider: MullusiPluginApi["registerMediaUnderstandingProvider"] =
  () => {};
const noopRegisterImageGenerationProvider: MullusiPluginApi["registerImageGenerationProvider"] =
  () => {};
const noopRegisterVideoGenerationProvider: MullusiPluginApi["registerVideoGenerationProvider"] =
  () => {};
const noopRegisterWebFetchProvider: MullusiPluginApi["registerWebFetchProvider"] = () => {};
const noopRegisterWebSearchProvider: MullusiPluginApi["registerWebSearchProvider"] = () => {};
const noopRegisterInteractiveHandler: MullusiPluginApi["registerInteractiveHandler"] = () => {};
const noopOnConversationBindingResolved: MullusiPluginApi["onConversationBindingResolved"] =
  () => {};
const noopRegisterCommand: MullusiPluginApi["registerCommand"] = () => {};
const noopRegisterContextEngine: MullusiPluginApi["registerContextEngine"] = () => {};
const noopRegisterMemoryPromptSection: MullusiPluginApi["registerMemoryPromptSection"] = () => {};
const noopRegisterMemoryFlushPlan: MullusiPluginApi["registerMemoryFlushPlan"] = () => {};
const noopRegisterMemoryRuntime: MullusiPluginApi["registerMemoryRuntime"] = () => {};
const noopRegisterMemoryEmbeddingProvider: MullusiPluginApi["registerMemoryEmbeddingProvider"] =
  () => {};
const noopOn: MullusiPluginApi["on"] = () => {};

export function buildPluginApi(params: BuildPluginApiParams): MullusiPluginApi {
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
    registerService: handlers.registerService ?? noopRegisterService,
    registerCliBackend: handlers.registerCliBackend ?? noopRegisterCliBackend,
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
    registerWebFetchProvider: handlers.registerWebFetchProvider ?? noopRegisterWebFetchProvider,
    registerWebSearchProvider: handlers.registerWebSearchProvider ?? noopRegisterWebSearchProvider,
    registerInteractiveHandler:
      handlers.registerInteractiveHandler ?? noopRegisterInteractiveHandler,
    onConversationBindingResolved:
      handlers.onConversationBindingResolved ?? noopOnConversationBindingResolved,
    registerCommand: handlers.registerCommand ?? noopRegisterCommand,
    registerContextEngine: handlers.registerContextEngine ?? noopRegisterContextEngine,
    registerMemoryPromptSection:
      handlers.registerMemoryPromptSection ?? noopRegisterMemoryPromptSection,
    registerMemoryFlushPlan: handlers.registerMemoryFlushPlan ?? noopRegisterMemoryFlushPlan,
    registerMemoryRuntime: handlers.registerMemoryRuntime ?? noopRegisterMemoryRuntime,
    registerMemoryEmbeddingProvider:
      handlers.registerMemoryEmbeddingProvider ?? noopRegisterMemoryEmbeddingProvider,
    resolvePath: params.resolvePath,
    on: handlers.on ?? noopOn,
  };
}
