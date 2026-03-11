declare module "node-llama-cpp" {
  export enum LlamaLogLevel {
    error = 0,
  }

  export type LlamaEmbedding = { vector: Float32Array | number[] };

  export type LlamaEmbeddingContext = {
    getEmbeddingFor: (text: string) => Promise<LlamaEmbedding>;
    dispose: () => Promise<void>;
  };

  export type LlamaModel = {
    createEmbeddingContext: () => Promise<LlamaEmbeddingContext>;
    dispose: () => Promise<void>;
  };

  export type Llama = {
    loadModel: (params: { modelPath: string }) => Promise<LlamaModel>;
    dispose: () => Promise<void>;
  };

  export function getLlama(params: { logLevel: LlamaLogLevel }): Promise<Llama>;
  export function resolveModelFile(modelPath: string, cacheDir?: string): Promise<string>;
}
