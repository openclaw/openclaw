import fsSync from "node:fs";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { DEFAULT_LOCAL_MODEL } from "../memory/embeddings.js";
import { hasConfiguredMemorySecretInput } from "../memory/secret-input.js";
import { note } from "../terminal/note.js";
import { resolveUserPath } from "../utils.js";

/**
 * Check whether memory search has a usable embedding provider.
 * Runs as part of `openclaw doctor` — config-only, no network calls.
 */
export async function noteMemorySearchHealth(
  cfg: OpenClawConfig,
  opts?: {
    gatewayMemoryProbe?: {
      checked: boolean;
      ready: boolean;
      error?: string;
    };
  },
): Promise<void> {
  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  const resolved = resolveMemorySearchConfig(cfg, agentId);
  const hasRemoteApiKey = hasConfiguredMemorySecretInput(resolved?.remote?.apiKey);

  if (!resolved) {
    note("Memory search is explicitly disabled (enabled: false).", "Memory search");
    return;
  }

  // QMD backend handles embeddings internally (e.g. embeddinggemma) — no
  // separate embedding provider is needed. Skip the provider check entirely.
  const backendConfig = resolveMemoryBackendConfig({ cfg, agentId });
  if (backendConfig.backend === "qmd") {
    return;
  }

  // If a specific provider is configured (not "auto"), check only that one.
  if (resolved.provider !== "auto") {
    if (resolved.provider === "local") {
      if (hasLocalEmbeddings(resolved.local, true)) {
        // Model path looks valid (explicit file, hf: URL, or default model).
        // If a gateway probe is available and reports not-ready, warn anyway —
        // the model download or node-llama-cpp setup may have failed at runtime.
        if (opts?.gatewayMemoryProbe?.checked && !opts.gatewayMemoryProbe.ready) {
          const detail = opts.gatewayMemoryProbe.error?.trim();
          note(
            [
              'Memory search provider is set to "local" and a model path is configured,',
              "but the gateway reports local embeddings are not ready.",
              detail ? `Gateway probe: ${detail}` : null,
              "",
              `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
            ]
              .filter(Boolean)
              .join("\n"),
            "Memory search",
          );
        }
        return;
      }
      note(
        [
          'Memory search provider is set to "local" but no local model file was found.',
          "",
          "Fix (pick one):",
          `- Install node-llama-cpp and set a local model path in config`,
          `- Switch to a remote provider: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.provider openai")}`,
          "",
          `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
        ].join("\n"),
        "Memory search",
      );
      return;
    }
    // Remote provider — check for API key
    if (hasRemoteApiKey || (await hasApiKeyForProvider(resolved.provider, cfg, agentDir))) {
      return;
    }
    if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
      note(
        [
          `Memory search provider is set to "${resolved.provider}" but the API key was not found in the CLI environment.`,
          "The running gateway reports memory embeddings are ready for the default agent.",
          `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
        ].join("\n"),
        "Memory search",
      );
      return;
    }
    const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);
    const envVar = providerEnvVar(resolved.provider);
    note(
      [
        `Memory search provider is set to "${resolved.provider}" but no API key was found.`,
        `Semantic recall will not work without a valid API key.`,
        gatewayProbeWarning ? gatewayProbeWarning : null,
        "",
        "Fix (pick one):",
        `- Set ${envVar} in your environment`,
        `- Configure credentials: ${formatCliCommand("openclaw configure --section model")}`,
        `- To disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
        "",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ].join("\n"),
      "Memory search",
    );
    return;
  }

  // provider === "auto": check all providers in resolution order
  if (hasLocalEmbeddings(resolved.local)) {
    return;
  }
  for (const provider of ["openai", "gemini", "voyage", "mistral"] as const) {
    if (hasRemoteApiKey || (await hasApiKeyForProvider(provider, cfg, agentDir))) {
      return;
    }
  }

  if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
    note(
      [
        'Memory search provider is set to "auto" but the API key was not found in the CLI environment.',
        "The running gateway reports memory embeddings are ready for the default agent.",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ].join("\n"),
      "Memory search",
    );
    return;
  }
  const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);

  note(
    [
      "Memory search is enabled but no embedding provider is configured.",
      "Semantic recall will not work without an embedding provider.",
      gatewayProbeWarning ? gatewayProbeWarning : null,
      "",
      "Fix (pick one):",
      "- Set OPENAI_API_KEY, GEMINI_API_KEY, VOYAGE_API_KEY, or MISTRAL_API_KEY in your environment",
      `- Configure credentials: ${formatCliCommand("openclaw configure --section model")}`,
      `- For local embeddings: configure agents.defaults.memorySearch.provider and local model path`,
      `- To disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
      "",
      `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
    ].join("\n"),
    "Memory search",
  );
}

/**
 * Check whether local embeddings are available.
 *
 * When `useDefaultFallback` is true (explicit `provider: "local"`), an empty
 * modelPath is treated as available because the runtime falls back to
 * DEFAULT_LOCAL_MODEL (an auto-downloaded HuggingFace model).
 *
 * When false (provider: "auto"), we only consider local available if the user
 * explicitly configured a local file path — matching `canAutoSelectLocal()`
 * in the runtime, which skips local for empty/hf: model paths.
 */
function hasLocalEmbeddings(local: { modelPath?: string }, useDefaultFallback = false): boolean {
  const modelPath =
    local.modelPath?.trim() || (useDefaultFallback ? DEFAULT_LOCAL_MODEL : undefined);
  if (!modelPath) {
    return false;
  }
  // Remote/downloadable models (hf: or http:) aren't pre-resolved on disk,
  // so we can't confirm availability without a network call. Treat as
  // potentially available — the user configured it intentionally.
  if (/^(hf:|https?:)/i.test(modelPath)) {
    return true;
  }
  const resolved = resolveUserPath(modelPath);
  try {
    return fsSync.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

async function hasApiKeyForProvider(
  provider: "openai" | "gemini" | "voyage" | "mistral" | "ollama",
  cfg: OpenClawConfig,
  agentDir: string,
): Promise<boolean> {
  // Map embedding provider names to model-auth provider names
  const authProvider = provider === "gemini" ? "google" : provider;
  try {
    const result = await resolveApiKeyForProvider({ provider: authProvider, cfg, agentDir });
    return result != null;
  } catch {
    return false;
  }
}

function providerEnvVar(provider: string): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "voyage":
      return "VOYAGE_API_KEY";
    default:
      return `${provider.toUpperCase()}_API_KEY`;
  }
}

function buildGatewayProbeWarning(
  probe:
    | {
        checked: boolean;
        ready: boolean;
        error?: string;
      }
    | undefined,
): string | null {
  if (!probe?.checked || probe.ready) {
    return null;
  }
  const detail = probe.error?.trim();
  return detail
    ? `Gateway memory probe for default agent is not ready: ${detail}`
    : "Gateway memory probe for default agent is not ready.";
}

/**
 * Structured result of memorySearch configuration diagnostics.
 */
export type MemorySearchDiagnosticResult = {
  valid: boolean;
  provider?: string;
  issues: Array<{
    field: string;
    message: string;
    fix?: string;
  }>;
};

/**
 * Validates memorySearch configuration and returns structured diagnostic output.
 *
 * Checks:
 * - provider is defined (not "auto")
 * - required keys exist:
 *   - openai: apiKey, model
 *   - ollama: host, model
 *
 * @returns Structured diagnostic result with issues and fix suggestions
 */
export async function checkMemorySearch(
  cfg: OpenClawConfig,
): Promise<MemorySearchDiagnosticResult> {
  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  const resolved = resolveMemorySearchConfig(cfg, agentId);

  // Memory search is explicitly disabled
  if (!resolved) {
    return {
      valid: true,
      issues: [],
    };
  }

  // QMD backend handles embeddings internally - skip validation
  const backendConfig = resolveMemoryBackendConfig({ cfg, agentId });
  if (backendConfig.backend === "qmd") {
    return {
      valid: true,
      provider: resolved.provider,
      issues: [],
    };
  }

  const issues: MemorySearchDiagnosticResult["issues"] = [];

  // Check if provider is "auto" - this is a valid runtime mode (auto-selects provider)
  // Skip validation for "auto" as it relies on runtime resolution
  if (resolved.provider === "auto") {
    // "auto" is a valid mode - return valid as the runtime will handle resolution
    return {
      valid: true,
      provider: resolved.provider,
      issues: [],
    };
  }

  // Validate based on provider type
  if (resolved.provider === "openai") {
    // Check for apiKey - check both config and environment variables
    const hasApiKey =
      hasConfiguredMemorySecretInput(resolved.remote?.apiKey) ||
      (await hasApiKeyForProvider("openai", cfg, agentDir));
    if (!hasApiKey) {
      issues.push({
        field: "remote.apiKey",
        message: "openai provider requires apiKey to be configured",
        fix: `Set OPENAI_API_KEY environment variable or configure via: ${formatCliCommand("openclaw configure --section model")}`,
      });
    }

    // Note: model is optional - runtime has provider defaults
  } else if (resolved.provider === "ollama") {
    // Note: baseUrl is optional - runtime uses default http://127.0.0.1:11434 if not set
    // Note: model is optional - runtime has provider defaults
  }
  // For other providers (local, gemini, voyage, mistral), the existing noteMemorySearchHealth
  // function handles the validation

  return {
    valid: issues.length === 0,
    provider: resolved.provider,
    issues,
  };
}

/**
 * Generate example configuration snippet for memorySearch provider.
 */
function generateConfigSnippet(provider: string): string {
  switch (provider) {
    case "openai":
      return `memorySearch:
  provider: openai
  model: text-embedding-3-small
  remote:
    apiKey: \${OPENAI_API_KEY}`;
    case "ollama":
      return `memorySearch:
  provider: ollama
  model: nomic-embed-text
  remote:
    baseUrl: http://localhost:11434`;
    case "gemini":
      return `memorySearch:
  provider: gemini
  model: embedding-001
  remote:
    apiKey: \${GEMINI_API_KEY}`;
    case "voyage":
      return `memorySearch:
  provider: voyage
  model: voyage-law-2
  remote:
    apiKey: \${VOYAGE_API_KEY}`;
    case "mistral":
      return `memorySearch:
  provider: mistral
  model: mistral-embed
  remote:
    apiKey: \${MISTRAL_API_KEY}`;
    case "local":
      return `memorySearch:
  provider: local
  local:
    modelPath: /path/to/model.gguf`;
    default:
      return `memorySearch:
  provider: openai
  model: text-embedding-3-small`;
  }
}

/**
 * Display structured diagnostic output for memorySearch configuration.
 *
 * This function is called by `openclaw doctor` to provide clear, actionable
 * feedback when memorySearch configuration is invalid.
 *
 * Output includes:
 * - Error explanation
 * - Missing fields
 * - Suggested configuration snippet
 * - Documentation link
 */
export async function noteMemorySearchDiagnostics(cfg: OpenClawConfig): Promise<void> {
  const result = await checkMemorySearch(cfg);

  // No issues - memory search is either disabled or properly configured
  if (result.valid) {
    return;
  }

  const lines: string[] = [];

  // Header with provider info
  lines.push(`[FAIL] memorySearch configuration invalid`);
  lines.push(``);
  lines.push(`Provider: ${result.provider}`);
  lines.push(``);

  // List missing fields
  if (result.issues.length > 0) {
    lines.push(`Missing or invalid fields:`);
    for (const issue of result.issues) {
      lines.push(`  - ${issue.field}: ${issue.message}`);
    }
    lines.push(``);
  }

  // Add fix suggestions from structured result
  lines.push(`Suggested fix:`);
  for (const issue of result.issues) {
    if (issue.fix) {
      lines.push(`  ${issue.fix}`);
    }
  }
  lines.push(``);

  // Add example configuration snippet
  lines.push(`Example configuration:`);
  lines.push(`\`\`\`yaml`);
  lines.push(generateConfigSnippet(result.provider ?? "openai"));
  lines.push(`\`\`\``);
  lines.push(``);

  // Add documentation link
  lines.push(`Learn more: https://docs.openclaw.ai/configuration#memory-search`);

  // Output using the note function
  note(lines.join("\n"), "Memory search");
}
