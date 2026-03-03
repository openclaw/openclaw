import { normalizeProviderId } from "../../agents/model-selection.js";
import { anthropicProvider } from "./anthropic/index.js";
import { deepgramProvider } from "./deepgram/index.js";
import { googleProvider } from "./google/index.js";
import { groqProvider } from "./groq/index.js";
import { minimaxProvider } from "./minimax/index.js";
import { mistralProvider } from "./mistral/index.js";
import { moonshotProvider } from "./moonshot/index.js";
import { openaiProvider } from "./openai/index.js";
import { zaiProvider } from "./zai/index.js";
const PROVIDERS = [
    groqProvider,
    openaiProvider,
    googleProvider,
    anthropicProvider,
    minimaxProvider,
    moonshotProvider,
    mistralProvider,
    zaiProvider,
    deepgramProvider,
];
export function normalizeMediaProviderId(id) {
    const normalized = normalizeProviderId(id);
    if (normalized === "gemini") {
        return "google";
    }
    return normalized;
}
export function buildMediaUnderstandingRegistry(overrides) {
    const registry = new Map();
    for (const provider of PROVIDERS) {
        registry.set(normalizeMediaProviderId(provider.id), provider);
    }
    if (overrides) {
        for (const [key, provider] of Object.entries(overrides)) {
            const normalizedKey = normalizeMediaProviderId(key);
            const existing = registry.get(normalizedKey);
            const merged = existing
                ? {
                    ...existing,
                    ...provider,
                    capabilities: provider.capabilities ?? existing.capabilities,
                }
                : provider;
            registry.set(normalizedKey, merged);
        }
    }
    return registry;
}
export function getMediaUnderstandingProvider(id, registry) {
    return registry.get(normalizeMediaProviderId(id));
}
