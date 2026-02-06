/**
 * Gateway startup validation.
 * Ensures the gateway can serve requests before accepting connections.
 *
 * INVARIANT: Default model must have context window >= MINIMUM_CONTEXT_TOKENS (16000).
 * Failure to enforce this causes "connected but dead" behavior.
 */
import {
  MINIMUM_CONTEXT_TOKENS,
  resolveDefaultModel,
  resolveDefaultProvider,
} from "../agents/defaults.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { ensureMoltbotModelsJson } from "../agents/models-config.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import type { MoltbotConfig } from "../config/config.js";

export type StartupValidationResult = {
  ok: boolean;
  defaultModel?: { provider: string; model: string };
  contextWindow?: number;
  authMode?: string;
  error?: string;
  suggestions?: string[];
};

/**
 * Generate actionable suggestions based on the error message.
 */
function generateSuggestions(error: string, provider: string): string[] {
  const suggestions: string[] = [];

  // Context window too small
  if (error.includes("context window too small") || error.includes("Minimum is")) {
    suggestions.push("Update model catalog with correct context window");
    suggestions.push(
      "Or use a model with larger context: moltbot config set agents.defaults.model.primary ollama/llama3.1:32k",
    );
    suggestions.push("Check Ollama model info: ollama show llama3:chat");
    return suggestions;
  }

  // Ollama-specific suggestions
  if (provider === "ollama") {
    if (error.includes("Unknown model")) {
      suggestions.push("Start Ollama: ollama serve");
      suggestions.push("Pull the model: ollama pull llama3:chat");
      suggestions.push(
        "Or configure a different model: moltbot config set agents.defaults.model.primary anthropic/claude-sonnet-4-5",
      );
    }
  }

  // Anthropic-specific suggestions
  if (provider === "anthropic") {
    if (error.includes("Unknown model") || error.includes("No API key")) {
      suggestions.push("Set API key: export ANTHROPIC_API_KEY=your-key");
      suggestions.push(
        "Or configure Ollama: moltbot config set agents.defaults.model.primary ollama/llama3:chat",
      );
    }
  }

  // OpenAI-specific suggestions
  if (provider === "openai") {
    if (error.includes("Unknown model") || error.includes("No API key")) {
      suggestions.push("Set API key: export OPENAI_API_KEY=your-key");
    }
  }

  // Generic suggestions
  if (suggestions.length === 0) {
    suggestions.push(`Check provider configuration for ${provider}`);
    suggestions.push("Run: moltbot models list --status to see available models");
  }

  return suggestions;
}

/**
 * Validate gateway startup prerequisites.
 * Checks that the configured default model can be resolved.
 *
 * @param cfg - The loaded configuration
 * @param agentDir - The agent directory path
 * @returns Validation result with ok status and error details if failed
 */
export async function validateGatewayStartup(
  cfg: MoltbotConfig,
  agentDir: string,
): Promise<StartupValidationResult> {
  // Skip validation if explicitly disabled (for testing ONLY)
  // HARDENING: Only honor skip in test environment to prevent accidental production use
  if (process.env.CLAWDBOT_SKIP_STARTUP_VALIDATION === "1") {
    const isTestEnv = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
    if (isTestEnv) {
      return { ok: true };
    }
    // In non-test environments, warn loudly but still skip (operator explicitly asked)
    console.warn(
      "⚠️  CLAWDBOT_SKIP_STARTUP_VALIDATION is set outside test environment. " +
        "This bypasses fail-fast validation. NOT FOR PRODUCTION.",
    );
    return { ok: true };
  }

  // 1. Ensure models.json is written (triggers provider discovery)
  try {
    await ensureMoltbotModelsJson(cfg, agentDir);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to initialize model configuration: ${err instanceof Error ? err.message : String(err)}`,
      suggestions: ["Check disk permissions for agent directory", "Run: moltbot doctor"],
    };
  }

  // 2. Resolve the configured default model
  // Use dynamic defaults: prefer Moonshot when MOONSHOT_API_KEY is present
  const effectiveDefaultProvider = resolveDefaultProvider();
  const effectiveDefaultModel = resolveDefaultModel(effectiveDefaultProvider);

  const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
    cfg,
    defaultProvider: effectiveDefaultProvider,
    defaultModel: effectiveDefaultModel,
  });

  // 3. Try to resolve the actual model from the registry
  const { model, error } = resolveModel(defaultProvider, defaultModel, agentDir, cfg);

  if (!model) {
    return {
      ok: false,
      defaultModel: { provider: defaultProvider, model: defaultModel },
      error: error ?? `Unknown model: ${defaultProvider}/${defaultModel}`,
      suggestions: generateSuggestions(error ?? "", defaultProvider),
    };
  }

  // 4. Verify context window meets minimum requirement
  const contextWindow = model.contextWindow ?? 0;
  if (contextWindow < MINIMUM_CONTEXT_TOKENS) {
    const ctxError = `Model context window too small: ${contextWindow} tokens. Minimum is ${MINIMUM_CONTEXT_TOKENS}.`;
    return {
      ok: false,
      defaultModel: { provider: defaultProvider, model: defaultModel },
      contextWindow,
      error: ctxError,
      suggestions: generateSuggestions(ctxError, defaultProvider),
    };
  }

  // 5. Verify auth policy for provider is satisfied
  // ALWAYS call getApiKeyForModel - do not skip based on cfg-only auth mode
  // This ensures we use the same effective provider config as the runner
  try {
    const apiKeyInfo = await getApiKeyForModel({
      model,
      cfg,
      agentDir,
    });
    // Auth is satisfied if:
    // - mode === "none" (local authless provider)
    // - mode === "aws-sdk" (IAM credentials)
    // - apiKey exists
    const authSatisfied =
      apiKeyInfo.mode === "none" || apiKeyInfo.mode === "aws-sdk" || Boolean(apiKeyInfo.apiKey);

    if (!authSatisfied) {
      return {
        ok: false,
        defaultModel: { provider: defaultProvider, model: defaultModel },
        contextWindow,
        authMode: apiKeyInfo.mode,
        error: `No API key resolved for provider "${defaultProvider}" (auth mode: ${apiKeyInfo.mode})`,
        suggestions: generateSuggestions(`No API key for ${defaultProvider}`, defaultProvider),
      };
    }

    // Success - return values from resolved model + apiKeyInfo
    return {
      ok: true,
      defaultModel: { provider: defaultProvider, model: defaultModel },
      contextWindow,
      authMode: apiKeyInfo.mode,
    };
  } catch (err) {
    return {
      ok: false,
      defaultModel: { provider: defaultProvider, model: defaultModel },
      contextWindow,
      error: `Auth validation failed: ${err instanceof Error ? err.message : String(err)}`,
      suggestions: generateSuggestions(String(err), defaultProvider),
    };
  }
}

/**
 * Format validation error for display.
 */
export function formatValidationError(result: StartupValidationResult): string {
  if (result.ok) return "";

  const lines: string[] = [];
  lines.push(`Gateway startup validation failed: ${result.error}`);

  if (result.defaultModel) {
    lines.push(`  Configured model: ${result.defaultModel.provider}/${result.defaultModel.model}`);
  }

  if (result.suggestions && result.suggestions.length > 0) {
    lines.push("");
    lines.push("Suggestions:");
    for (const suggestion of result.suggestions) {
      lines.push(`  - ${suggestion}`);
    }
  }

  return lines.join("\n");
}
