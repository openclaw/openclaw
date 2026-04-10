type FacadeModule = typeof import("@openclaw/ollama/runtime-api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "ollama",
    artifactBasename: "runtime-api.js",
  });
}

export type OllamaEmbeddingClient = import("@openclaw/ollama/runtime-api.js").OllamaEmbeddingClient;
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
export const buildAssistantMessage: FacadeModule["buildAssistantMessage"] = ((...args) =>
  loadFacadeModule().buildAssistantMessage(...args)) as FacadeModule["buildAssistantMessage"];
export const buildOllamaChatRequest: FacadeModule["buildOllamaChatRequest"] = ((...args) =>
  loadFacadeModule().buildOllamaChatRequest(...args)) as FacadeModule["buildOllamaChatRequest"];
export const convertToOllamaMessages: FacadeModule["convertToOllamaMessages"] = ((...args) =>
  loadFacadeModule().convertToOllamaMessages(...args)) as FacadeModule["convertToOllamaMessages"];
export const createConfiguredOllamaCompatNumCtxWrapper: FacadeModule["createConfiguredOllamaCompatNumCtxWrapper"] =
  ((...args) =>
    loadFacadeModule().createConfiguredOllamaCompatNumCtxWrapper(
      ...args,
    )) as FacadeModule["createConfiguredOllamaCompatNumCtxWrapper"];
export const createConfiguredOllamaCompatStreamWrapper: FacadeModule["createConfiguredOllamaCompatStreamWrapper"] =
  ((...args) =>
    loadFacadeModule().createConfiguredOllamaCompatStreamWrapper(
      ...args,
    )) as FacadeModule["createConfiguredOllamaCompatStreamWrapper"];
export const createConfiguredOllamaStreamFn: FacadeModule["createConfiguredOllamaStreamFn"] = ((
  ...args
) =>
  loadFacadeModule().createConfiguredOllamaStreamFn(
    ...args,
  )) as FacadeModule["createConfiguredOllamaStreamFn"];
export const createOllamaStreamFn: FacadeModule["createOllamaStreamFn"] = ((...args) =>
  loadFacadeModule().createOllamaStreamFn(...args)) as FacadeModule["createOllamaStreamFn"];

export const createOllamaEmbeddingProvider: FacadeModule["createOllamaEmbeddingProvider"] = ((
  ...args
) =>
  loadFacadeModule().createOllamaEmbeddingProvider(
    ...args,
  )) as FacadeModule["createOllamaEmbeddingProvider"];
export const isOllamaCompatProvider: FacadeModule["isOllamaCompatProvider"] = ((...args) =>
  loadFacadeModule().isOllamaCompatProvider(...args)) as FacadeModule["isOllamaCompatProvider"];
export const resolveOllamaCompatNumCtxEnabled: FacadeModule["resolveOllamaCompatNumCtxEnabled"] = ((
  ...args
) =>
  loadFacadeModule().resolveOllamaCompatNumCtxEnabled(
    ...args,
  )) as FacadeModule["resolveOllamaCompatNumCtxEnabled"];
export const shouldInjectOllamaCompatNumCtx: FacadeModule["shouldInjectOllamaCompatNumCtx"] = ((
  ...args
) =>
  loadFacadeModule().shouldInjectOllamaCompatNumCtx(
    ...args,
  )) as FacadeModule["shouldInjectOllamaCompatNumCtx"];
export const parseNdjsonStream: FacadeModule["parseNdjsonStream"] = ((...args) =>
  loadFacadeModule().parseNdjsonStream(...args)) as FacadeModule["parseNdjsonStream"];
export const resolveOllamaBaseUrlForRun: FacadeModule["resolveOllamaBaseUrlForRun"] = ((...args) =>
  loadFacadeModule().resolveOllamaBaseUrlForRun(
    ...args,
  )) as FacadeModule["resolveOllamaBaseUrlForRun"];
export const wrapOllamaCompatNumCtx: FacadeModule["wrapOllamaCompatNumCtx"] = ((...args) =>
  loadFacadeModule().wrapOllamaCompatNumCtx(...args)) as FacadeModule["wrapOllamaCompatNumCtx"];
