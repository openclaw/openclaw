import type { BackendId } from "./types.js";

export type RuntimeArtifact = {
  version: string;
  urlTemplate: string;
  sha256?: Record<string, string>;
};

export type ModelArtifact = {
  id: string;
  displayName: string;
  backend: BackendId;
  /** For Ollama: the tag to pull (e.g. "gemma3:1b"). */
  ollamaTag?: string;
  /** For llama.cpp / gemma.cpp: direct download URL. */
  url?: string;
  /** Expected sha256 of the downloaded model file. */
  sha256?: string;
  /** Approximate download size in bytes. */
  sizeBytes?: number;
};

// -----------------------------------------------------------------------
// Runtime binaries
// -----------------------------------------------------------------------

export const OLLAMA_RUNTIME: RuntimeArtifact = {
  version: "0.6.2",
  urlTemplate:
    "https://github.com/ollama/ollama/releases/download/v{version}/ollama-linux-{arch}.tgz",
};

export const LLAMACPP_RUNTIME: RuntimeArtifact = {
  version: "b5460",
  urlTemplate:
    "https://github.com/ggerganov/llama.cpp/releases/download/{version}/llama-{version}-bin-ubuntu-x64.zip",
};

export const GEMMACPP_REPO = "https://github.com/google/gemma.cpp.git";
export const GEMMACPP_TAG = "v0.1.0";

// -----------------------------------------------------------------------
// Default models (smallest known-working for each backend)
// -----------------------------------------------------------------------

export const DEFAULT_MODELS: Record<BackendId, ModelArtifact> = {
  ollama: {
    id: "gemma3:1b",
    displayName: "Gemma 3 1B (Ollama)",
    backend: "ollama",
    ollamaTag: "gemma3:1b",
    sizeBytes: 815_000_000,
  },
  "llama-cpp": {
    id: "tinyllama-1.1b-chat-v1.0.Q2_K",
    displayName: "TinyLlama 1.1B Chat Q2_K (GGUF)",
    backend: "llama-cpp",
    url: "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q2_K.gguf",
    sizeBytes: 482_000_000,
  },
  "gemma-cpp": {
    id: "gemma-2-2b-it",
    displayName: "Gemma 2 2B IT (gemma.cpp)",
    backend: "gemma-cpp",
    // gemma.cpp uses its own weight format; weights are downloaded via HuggingFace.
    // The exact URL depends on HF auth. Model download is handled by the manager.
    sizeBytes: 5_000_000_000,
  },
};

export function resolveOllamaBinaryUrl(): string {
  const arch = process.arch === "x64" ? "amd64" : "arm64";
  return OLLAMA_RUNTIME.urlTemplate
    .replace("{version}", OLLAMA_RUNTIME.version)
    .replace("{arch}", arch);
}

export function resolveLlamaCppUrl(): string {
  return LLAMACPP_RUNTIME.urlTemplate.replace(/{version}/g, LLAMACPP_RUNTIME.version);
}
