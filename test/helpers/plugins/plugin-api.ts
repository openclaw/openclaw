import type { MullusiPluginApi } from "mullusi/plugin-sdk/plugin-runtime";

type TestPluginApiInput = Omit<
  Partial<MullusiPluginApi>,
  "id" | "name" | "source" | "config" | "runtime"
> &
  Pick<MullusiPluginApi, "id" | "name" | "source" | "config" | "runtime">;

export function createTestPluginApi(api: TestPluginApiInput): MullusiPluginApi {
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
    registerCliBackend() {},
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
