// Streams LLM responses through registered providers and normalizes events.
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";

// Register built-ins as a side effect before re-exporting the shared runtime stream API.
registerBuiltInApiProviders();

export { complete, completeSimple, stream, streamSimple } from "@openclaw/ai";
export { getEnvApiKey } from "@openclaw/ai/internal/runtime";
