import type { OpenClawConfig } from "../config/config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { note } from "../terminal/note.js";

/**
 * Check if memory search is likely to be non-functional due to missing embeddings provider.
 * Returns diagnostic messages if issues are detected.
 */
export function noteMemorySearchHealth(cfg: OpenClawConfig): void {
  const memoryConfig = cfg.agents?.defaults?.memorySearch;

  // Memory search explicitly disabled - that's OK, no warning needed
  if (memoryConfig?.enabled === false) {
    return;
  }

  // Memory search is enabled (or default enabled) - check if embeddings provider is available
  const provider = memoryConfig?.provider ?? "auto";
  const warnings: string[] = [];

  // Check if any API keys are configured
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const hasVoyage = Boolean(process.env.VOYAGE_API_KEY);

  // Check local model configuration
  const localModelPath = memoryConfig?.local?.modelPath?.trim();
  const hasLocalModel = localModelPath && localModelPath.length > 0;

  if (provider === "auto") {
    // Auto mode needs at least one provider available
    if (!hasOpenAI && !hasGemini && !hasVoyage && !hasLocalModel) {
      warnings.push(
        "⚠️  Memory search is enabled but no embeddings provider is configured.",
        "",
        "Memory search requires semantic embeddings to work. Without a provider,",
        "the memory_search tool will fail and your agent cannot recall information",
        "from MEMORY.md or memory/*.md files.",
        "",
        "Fix options (choose one):",
        "",
        "1. Use OpenAI (recommended for most users):",
        `   export OPENAI_API_KEY="sk-..."`,
        `   Or run: ${formatCliCommand("openclaw configure")}`,
        "",
        "2. Use Google Gemini (free tier available):",
        `   export GEMINI_API_KEY="..."`,
        `   Or run: ${formatCliCommand("openclaw onboard --auth-choice gemini-api-key")}`,
        "",
        "3. Use Voyage AI:",
        `   export VOYAGE_API_KEY="..."`,
        "",
        "4. Use local embeddings (requires node-llama-cpp):",
        `   ${formatCliCommand('openclaw config set agents.defaults.memorySearch.provider "local"')}`,
        `   ${formatCliCommand('openclaw config set agents.defaults.memorySearch.local.modelPath "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"')}`,
        "",
        "5. Disable memory search if not needed:",
        `   ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
        "",
        `Check current status: ${formatCliCommand("openclaw memory status --deep")}`,
      );
    }
  } else if (provider === "openai") {
    if (!hasOpenAI) {
      warnings.push(
        `⚠️  Memory search provider is set to "openai" but OPENAI_API_KEY is not configured.`,
        "",
        `Set your API key: export OPENAI_API_KEY="sk-..."`,
        `Or switch to auto: ${formatCliCommand('openclaw config set agents.defaults.memorySearch.provider "auto"')}`,
        `Or disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
      );
    }
  } else if (provider === "gemini") {
    if (!hasGemini) {
      warnings.push(
        `⚠️  Memory search provider is set to "gemini" but GEMINI_API_KEY is not configured.`,
        "",
        `Set your API key: export GEMINI_API_KEY="..."`,
        `Or switch to auto: ${formatCliCommand('openclaw config set agents.defaults.memorySearch.provider "auto"')}`,
        `Or disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
      );
    }
  } else if (provider === "voyage") {
    if (!hasVoyage) {
      warnings.push(
        `⚠️  Memory search provider is set to "voyage" but VOYAGE_API_KEY is not configured.`,
        "",
        `Set your API key: export VOYAGE_API_KEY="..."`,
        `Or switch to auto: ${formatCliCommand('openclaw config set agents.defaults.memorySearch.provider "auto"')}`,
        `Or disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
      );
    }
  } else if (provider === "local") {
    if (!hasLocalModel) {
      warnings.push(
        `⚠️  Memory search provider is set to "local" but no model path is configured.`,
        "",
        `Set a model path: ${formatCliCommand('openclaw config set agents.defaults.memorySearch.local.modelPath "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"')}`,
        `Or switch to auto: ${formatCliCommand('openclaw config set agents.defaults.memorySearch.provider "auto"')}`,
        `Or disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
        "",
        "Note: Local embeddings require node-llama-cpp to be installed.",
      );
    }
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Memory Search");
  }
}
