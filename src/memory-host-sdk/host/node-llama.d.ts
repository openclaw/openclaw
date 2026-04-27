export type LlamaEmbedding = {
    vector: Float32Array | number[];
};
export type LlamaEmbeddingContext = {
    getEmbeddingFor: (text: string) => Promise<LlamaEmbedding>;
};
export type LlamaModel = {
    createEmbeddingContext: (options?: {
        contextSize?: number | "auto";
    }) => Promise<LlamaEmbeddingContext>;
};
export type Llama = {
    loadModel: (params: {
        modelPath: string;
    }) => Promise<LlamaModel>;
};
export type NodeLlamaCppModule = {
    LlamaLogLevel: {
        error: number;
    };
    getLlama: (params: {
        logLevel: number;
    }) => Promise<Llama>;
    resolveModelFile: (modelPath: string, cacheDir?: string) => Promise<string>;
};
export declare function importNodeLlamaCpp(): Promise<NodeLlamaCppModule>;
