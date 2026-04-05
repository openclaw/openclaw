import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";

type TestPluginApiInput = Omit<
  Partial<OpenClawPluginApi>,
  "id" | "name" | "source" | "config" | "runtime"
> &
  Pick<OpenClawPluginApi, "id" | "name" | "source" | "config" | "runtime">;

export function createTestPluginApi(api: TestPluginApiInput): OpenClawPluginApi {
  return {
    registrationMode: "full",
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool() {},
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerConfigMigration() {},
    registerAutoEnableProbe() {},
    registerProvider() {},
    registerSpeechProvider() {},
    registerRealtimeTranscriptionProvider() {},
    registerRealtimeVoiceProvider() {},
    registerMediaUnderstandingProvider() {},
    registerImageGenerationProvider() {},
    registerVideoGenerationProvider() {},
    registerWebFetchProvider() {},
    registerWebSearchProvider() {},
    registerInteractiveHandler() {},
    onConversationBindingResolved() {},
    registerCommand() {},
    registerContextEngine() {},
    registerMemoryPromptSection() {},
    registerMemoryFlushPlan() {},
    registerMemoryRuntime() {},
    registerMemoryEmbeddingProvider() {},
    resolvePath(input: string) {
      return input;
    },
    on() {},
    ...api,
  };
}
