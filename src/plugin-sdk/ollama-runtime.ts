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
