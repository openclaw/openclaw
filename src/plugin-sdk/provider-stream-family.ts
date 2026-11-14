import type { StreamFn } from "../agents/runtime/index.js";
export {
  buildProviderStreamFamilyHooks,
  getOpenRouterModelCapabilities,
  loadOpenRouterModelCapabilities,
  MOONSHOT_THINKING_STREAM_HOOKS,
} from "./provider-stream.js";
export { getLoadedOpenRouterModelCapabilities } from "../agents/embedded-agent-runner/openrouter-model-capabilities.js";

/** Reuse the native Ollama codec at an explicitly selected router destination. */
export async function createProviderNativeStreamFn(params: {
  api: "ollama";
  baseUrl: string;
  headers?: Record<string, string>;
  transport: { requestUrl: string; bodyMode: "native" | "manifest" };
}): Promise<StreamFn> {
  if (params.api !== "ollama") {
    throw new Error("Unsupported provider-native stream API");
  }
  const baseUrl = params.baseUrl;
  const headers = params.headers ? { ...params.headers } : undefined;
  const transport = { ...params.transport };
  const { loadBundledPluginPublicSurfaceModuleSync } = await import("./facade-runtime.js");
  const surface = loadBundledPluginPublicSurfaceModuleSync<{
    createOllamaStreamFn?: (
      baseUrl: string,
      headers: Record<string, string> | undefined,
      transport: { requestUrl: string; bodyMode: "native" | "manifest" },
    ) => StreamFn;
  }>({ dirName: "ollama", artifactBasename: "runtime-api.js" });
  if (typeof surface.createOllamaStreamFn !== "function") {
    throw new Error("Ollama runtime surface is missing createOllamaStreamFn");
  }
  return surface.createOllamaStreamFn(baseUrl, headers, transport);
}
