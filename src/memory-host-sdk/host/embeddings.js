import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { DEFAULT_LOCAL_MODEL } from "./embedding-defaults.js";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import { importNodeLlamaCpp, } from "./node-llama.js";
export { DEFAULT_LOCAL_MODEL } from "./embedding-defaults.js";
export async function createLocalEmbeddingProvider(options) {
    const modelPath = normalizeOptionalString(options.local?.modelPath) || DEFAULT_LOCAL_MODEL;
    const modelCacheDir = normalizeOptionalString(options.local?.modelCacheDir);
    const contextSize = options.local?.contextSize ?? 4096;
    // Lazy-load node-llama-cpp to keep startup light unless local is enabled.
    const { getLlama, resolveModelFile, LlamaLogLevel } = await importNodeLlamaCpp();
    let llama = null;
    let embeddingModel = null;
    let embeddingContext = null;
    let initPromise = null;
    const ensureContext = async () => {
        if (embeddingContext) {
            return embeddingContext;
        }
        if (initPromise) {
            return initPromise;
        }
        initPromise = (async () => {
            try {
                if (!llama) {
                    llama = await getLlama({ logLevel: LlamaLogLevel.error });
                }
                if (!embeddingModel) {
                    const resolved = await resolveModelFile(modelPath, modelCacheDir || undefined);
                    embeddingModel = await llama.loadModel({ modelPath: resolved });
                }
                if (!embeddingContext) {
                    embeddingContext = await embeddingModel.createEmbeddingContext({ contextSize });
                }
                return embeddingContext;
            }
            catch (err) {
                initPromise = null;
                throw err;
            }
        })();
        return initPromise;
    };
    return {
        id: "local",
        model: modelPath,
        embedQuery: async (text) => {
            const ctx = await ensureContext();
            const embedding = await ctx.getEmbeddingFor(text);
            return sanitizeAndNormalizeEmbedding(Array.from(embedding.vector));
        },
        embedBatch: async (texts) => {
            const ctx = await ensureContext();
            const embeddings = await Promise.all(texts.map(async (text) => {
                const embedding = await ctx.getEmbeddingFor(text);
                return sanitizeAndNormalizeEmbedding(Array.from(embedding.vector));
            }));
            return embeddings;
        },
    };
}
