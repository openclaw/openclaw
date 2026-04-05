type FacadeModule = typeof import("@openclaw/ollama/runtime-api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "ollama",
    artifactBasename: "runtime-api.js",
  });
}

export type OllamaEmbeddingClient = import("@openclaw/ollama/runtime-api.js").OllamaEmbeddingClient;
export const DEFAULT_OLLAMA_EMBEDDING_MODEL: FacadeModule["DEFAULT_OLLAMA_EMBEDDING_MODEL"] =
  loadFacadeModule().DEFAULT_OLLAMA_EMBEDDING_MODEL;

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
export const wrapOllamaCompatNumCtx: FacadeModule["wrapOllamaCompatNumCtx"] = ((...args) =>
  loadFacadeModule().wrapOllamaCompatNumCtx(...args)) as FacadeModule["wrapOllamaCompatNumCtx"];
