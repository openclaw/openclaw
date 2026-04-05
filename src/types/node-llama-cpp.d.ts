declare module "node-llama-cpp" {
  export enum LlamaLogLevel {
    error = 0,
  }

  export type LlamaEmbedding = { vector: Float32Array | number[] };

  export type LlamaEmbeddingContext = {
    getEmbeddingFor: (text: string) => Promise<LlamaEmbedding>;
  };

  export type LlamaModel = {
    createEmbeddingContext: () => Promise<LlamaEmbeddingContext>;
  };

  export type LlamaVramState = {
    total: number;
    used: number;
    free: number;
    unifiedSize: number;
  };

  export type Llama = {
    gpu: string | false;
    buildType: string;
    loadModel: (params: { modelPath: string }) => Promise<LlamaModel>;
    getVramState: () => Promise<LlamaVramState>;
    dispose: () => Promise<void>;
  };

  export function getLlama(params: {
    logLevel: LlamaLogLevel;
    gpu?: "auto" | "vulkan" | "cuda" | "metal" | false;
    progressLogs?: boolean;
  }): Promise<Llama>;
  export function resolveModelFile(modelPath: string, cacheDir?: string): Promise<string>;
}
