declare module "node-llama-cpp" {
  export enum LlamaLogLevel {
    error = 0,
  }

  export type LlamaEmbedding = { vector: Float32Array | number[] };

  export type LlamaEmbeddingContext = {
    getEmbeddingFor: (text: string) => Promise<LlamaEmbedding>;
  };

  export type LlamaGpuType = "metal" | "cuda" | "vulkan";

  export type LlamaEmbeddingContextOptions = {
    contextSize?: number;
    flashAttention?: boolean;
  };

  export type LlamaModel = {
    createEmbeddingContext: (
      params?: LlamaEmbeddingContextOptions,
    ) => Promise<LlamaEmbeddingContext>;
  };

  export type Llama = {
    loadModel: (params: {
      modelPath: string;
      gpuLayers?: "auto" | "max" | number;
    }) => Promise<LlamaModel>;
  };

  export function getLlama(params: {
    logLevel: LlamaLogLevel;
    gpu?: LlamaGpuType | "auto" | false;
  }): Promise<Llama>;
  export function resolveModelFile(modelPath: string, cacheDir?: string): Promise<string>;
}
