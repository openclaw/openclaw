// Plugin test API helpers construct SDK-shaped host APIs for plugin unit tests.
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  attachPluginApiFacades,
  type OpenClawPluginApiWithoutFacades,
} from "../plugins/api-facades.js";
import { createPluginServiceScheduler } from "../plugins/service-scheduler.js";
import type { PluginServiceSchedulerV1 } from "../plugins/service-scheduler.types.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { OpenClawPluginApi } from "./plugin-runtime.js";

/** Real scheduling ownership with a test clock; callers join it during fixture cleanup. */
export function createTestPluginServiceScheduler(
  scheduler: GatewayScheduler = createTestGatewayScheduler("fake-timers"),
): PluginServiceSchedulerV1 {
  return createPluginServiceScheduler(scheduler).scheduler;
}

/** Partial plugin API overrides accepted by the SDK test helper. */
export type TestPluginApiInput = Partial<OpenClawPluginApi>;

/** Create a minimal plugin API object for plugin-sdk contract and unit tests. */
export function createTestPluginApi(api: TestPluginApiInput = {}): OpenClawPluginApi {
  const { agent, lifecycle, runContext, session, ...flatApi } = api;
  const mergedApi = {
    id: "test-plugin",
    name: "test-plugin",
    source: "test",
    registrationMode: "full",
    config: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool() {},
    registerHook() {},
    registerHttpRoute() {},
    registerHostedMediaResolver() {},
    registerWidgetPresenter() {},
    registerMcpServerConnectionResolver() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerGatewayAccessPolicy() {},
    registerSessionCatalog() {},
    registerCli() {},
    registerNodeCliFeature() {},
    registerCliBackend() {},
    registerTextTransforms() {},
    registerService() {},
    registerGatewayDiscoveryService() {},
    registerReload() {},
    registerNodeHostCommand() {},
    registerNodeInvokePolicy() {},
    registerSecurityAuditCollector() {},
    registerConfigMigration() {},
    registerMigrationProvider() {},
    registerAutoEnableProbe() {},
    registerProvider() {},
    registerModelCatalogProvider() {},
    registerEmbeddingProvider() {},
    registerSpeechProvider() {},
    registerRealtimeTranscriptionProvider() {},
    registerRealtimeVoiceProvider() {},
    registerMediaUnderstandingProvider() {},
    registerTranscriptSourceProvider() {},
    registerImageGenerationProvider() {},
    registerMusicGenerationProvider() {},
    registerVideoGenerationProvider() {},
    registerWebFetchProvider() {},
    registerWebSearchProvider() {},
    registerWorkerProvider() {},
    registerStorageProvider() {},
    registerInteractiveHandler() {},
    onConversationBindingResolved() {},
    registerCommand() {},
    registerContextEngine() {},
    registerCompactionProvider() {},
    registerDecisionProvider() {},
    registerAgentHarness() {},
    registerCodexAppServerExtensionFactory() {},
    registerAgentToolResultMiddleware() {},
    registerSessionExtension() {},
    enqueueNextTurnInjection: async (injection) => ({
      enqueued: false,
      id: "",
      sessionKey: injection.sessionKey,
    }),
    registerTrustedToolPolicy() {},
    registerToolMetadata() {},
    registerControlUiDescriptor() {},
    registerBoardWidgetContentKind() {},
    registerRuntimeLifecycle() {},
    registerAgentEventSubscription() {},
    emitAgentEvent: () => ({ emitted: false as const, reason: "test api" }),
    setRunContext: () => false,
    getRunContext: () => undefined,
    clearRunContext() {},
    registerSessionSchedulerJob: () => undefined,
    registerSessionAction() {},
    sendSessionAttachment: async () => ({ ok: false, error: "test plugin api" }),
    scheduleSessionTurn: async () => undefined,
    unscheduleSessionTurnsByTag: async () => ({ removed: 0, failed: 0 }),
    registerMemoryCapability() {},
    registerMemoryPromptSupplement() {},
    registerMemoryPromptPreparation() {},
    registerMemoryCorpusSupplement() {},
    resolvePath(input: string) {
      return input;
    },
    on() {},
    ...flatApi,
  } satisfies OpenClawPluginApiWithoutFacades;
  // Facades derive nested `agent`, `lifecycle`, `runContext`, and `session`
  // views from the flat API; explicit overrides below let tests replace only
  // the nested surface under test without rebuilding every no-op method.
  const withFacades = attachPluginApiFacades(mergedApi);
  return {
    ...withFacades,
    ...(agent ? { agent } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(runContext ? { runContext } : {}),
    ...(session ? { session } : {}),
  };
}

export {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
