import type { OpenClawConfig } from "../config/config.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { OpenClawPluginApi, PluginLogger } from "./types.js";

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
      | "registerService"
      | "registerCliBackend"
      | "registerProvider"
      | "registerSpeechProvider"
      | "registerMediaUnderstandingProvider"
      | "registerImageGenerationProvider"
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

const noopRegisterTool: OpenClawPluginApi["registerTool"] = () => {};
const noopRegisterHook: OpenClawPluginApi["registerHook"] = () => {};
const noopRegisterHttpRoute: OpenClawPluginApi["registerHttpRoute"] = () => {};
const noopRegisterChannel: OpenClawPluginApi["registerChannel"] = () => {};
const noopRegisterGatewayMethod: OpenClawPluginApi["registerGatewayMethod"] = () => {};
const noopRegisterCli: OpenClawPluginApi["registerCli"] = () => {};
const noopRegisterService: OpenClawPluginApi["registerService"] = () => {};
const noopRegisterCliBackend: OpenClawPluginApi["registerCliBackend"] = () => {};
const noopRegisterProvider: OpenClawPluginApi["registerProvider"] = () => {};
const noopRegisterSpeechProvider: OpenClawPluginApi["registerSpeechProvider"] = () => {};
const noopRegisterMediaUnderstandingProvider: OpenClawPluginApi["registerMediaUnderstandingProvider"] =
  () => {};
const noopRegisterImageGenerationProvider: OpenClawPluginApi["registerImageGenerationProvider"] =
  () => {};
const noopRegisterWebSearchProvider: OpenClawPluginApi["registerWebSearchProvider"] = () => {};
const noopRegisterInteractiveHandler: OpenClawPluginApi["registerInteractiveHandler"] = () => {};
const noopOnConversationBindingResolved: OpenClawPluginApi["onConversationBindingResolved"] =
  () => {};
const noopRegisterCommand: OpenClawPluginApi["registerCommand"] = () => {};
const noopRegisterContextEngine: OpenClawPluginApi["registerContextEngine"] = () => {};
const noopRegisterMemoryPromptSection: OpenClawPluginApi["registerMemoryPromptSection"] = () => {};
const noopRegisterMemoryFlushPlan: OpenClawPluginApi["registerMemoryFlushPlan"] = () => {};
const noopRegisterMemoryRuntime: OpenClawPluginApi["registerMemoryRuntime"] = () => {};
const noopRegisterMemoryEmbeddingProvider: OpenClawPluginApi["registerMemoryEmbeddingProvider"] =
  () => {};
const noopOn: OpenClawPluginApi["on"] = () => {};

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
    registerService: handlers.registerService ?? noopRegisterService,
    registerCliBackend: handlers.registerCliBackend ?? noopRegisterCliBackend,
    registerProvider: handlers.registerProvider ?? noopRegisterProvider,
    registerSpeechProvider: handlers.registerSpeechProvider ?? noopRegisterSpeechProvider,
    registerMediaUnderstandingProvider:
      handlers.registerMediaUnderstandingProvider ?? noopRegisterMediaUnderstandingProvider,
    registerImageGenerationProvider:
      handlers.registerImageGenerationProvider ?? noopRegisterImageGenerationProvider,
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
