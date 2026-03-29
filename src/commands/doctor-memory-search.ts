import fsSync from "node:fs";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  getBuiltinMemoryEmbeddingProviderDoctorMetadata,
  listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata,
} from "../plugin-sdk/memory-core-engine-runtime.js";
import { DEFAULT_LOCAL_MODEL } from "../plugin-sdk/memory-core-host-engine-embeddings.js";
import { hasConfiguredMemorySecretInput } from "../plugin-sdk/memory-core-host-secret.js";
import { resolveActiveMemoryBackendConfig } from "../plugins/memory-runtime.js";
import { note } from "../terminal/note.js";
import { resolveUserPath } from "../utils.js";

function resolveSuggestedRemoteMemoryProvider(): string | undefined {
  return listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata().find(
    (provider) => provider.transport === "remote",
  )?.providerId;
}

/**
 * Check whether memory search has a usable embedding provider.
 * Runs as part of `openclaw doctor` - config-only, no network calls.
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

  // QMD backend handles embeddings internally (e.g. embeddinggemma) - no
  // separate embedding provider is needed. Skip the provider check entirely.
  const backendConfig = resolveActiveMemoryBackendConfig({ cfg, agentId });
  if (!backendConfig) {
    note("No active memory plugin is registered for the current config.", "Memory search");
    return;
  }
  if (backendConfig.backend === "qmd") {
    return;
  }

  // If a specific provider is configured (not "auto"), check only that one.
  if (resolved.provider !== "auto") {
    if (resolved.provider === "local") {
      const suggestedRemoteProvider = resolveSuggestedRemoteMemoryProvider();
      if (hasLocalEmbeddings(resolved.local, true)) {
        // Model path looks valid (explicit file, hf: URL, or default model).
        // If a gateway probe is available and reports not-ready, warn anyway -
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
          suggestedRemoteProvider
            ? `- Switch to a remote provider: ${formatCliCommand(`openclaw config set agents.defaults.memorySearch.provider ${suggestedRemoteProvider}`)}`
            : `- Switch to a remote embedding provider in config`,
          "",
          `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
        ].join("\n"),
        "Memory search",
      );
      return;
    }
    // Remote provider - check for API key. Local/default Ollama typically
    // does not need an API key, but remote/custom-baseUrl Ollama deployments
    // may. Only suppress the warning for the clearly local/no-auth case.
    if (hasRemoteApiKey || (await hasApiKeyForProvider(resolved.provider, cfg, agentDir))) {
      return;
    }
    if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
      if (resolved.provider === "ollama") {
        const providerBaseUrl = cfg.models?.providers?.ollama?.baseUrl?.trim();
        const ollamaBaseUrl = resolved.remote?.baseUrl?.trim() || providerBaseUrl;
        const ollamaLooksLocal =
          !ollamaBaseUrl || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(ollamaBaseUrl);
        const hasProviderApiKey = hasConfiguredMemorySecretInput(cfg.models?.providers?.ollama?.apiKey);
        const hasAnyOllamaApiKey =
          hasRemoteApiKey || hasProviderApiKey || (await hasApiKeyForProvider("ollama", cfg, agentDir));
        if (!hasAnyOllamaApiKey && ollamaLooksLocal) {
          return;
        }
      }
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
    const envVar = resolvePrimaryMemoryProviderEnvVar(resolved.provider);
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
  const autoSelectProviders = listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata().filter(
    (provider) => provider.transport === "remote",
  );
  for (const provider of autoSelectProviders) {
    if (hasRemoteApiKey || (await hasApiKeyForProvider(provider.authProviderId, cfg, agentDir))) {
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
      "Memory search is enabled, but no embedding provider is ready.",
      "Semantic recall needs at least one embedding provider.",
      gatewayProbeWarning ? gatewayProbeWarning : null,
      "",
      "Fix (pick one):",
      `- Set ${formatMemoryProviderEnvVarList(autoSelectProviders)} in your environment`,
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
 * explicitly configured a local file path - matching `canAutoSelectLocal()`
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
  // potentially available - the user configured it intentionally.
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
  provider: string,
  cfg: OpenClawConfig,
  agentDir: string,
): Promise<boolean> {
  const metadata = getBuiltinMemoryEmbeddingProviderDoctorMetadata(provider);
  try {
    await resolveApiKeyForProvider({
      provider: metadata?.authProviderId ?? provider,
      cfg,
      agentDir,
    });
    return true;
  } catch {
    return false;
  }
}

function resolvePrimaryMemoryProviderEnvVar(provider: string): string {
  const metadata = getBuiltinMemoryEmbeddingProviderDoctorMetadata(provider);
  return metadata?.envVars[0] ?? `${provider.toUpperCase()}_API_KEY`;
}

function formatMemoryProviderEnvVarList(providers: Array<{ envVars: string[] }>): string {
  return [...new Set(providers.flatMap((provider) => provider.envVars).filter(Boolean))].join(", ");
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
