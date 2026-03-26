import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_SECRET_PROVIDER_ALIAS,
  normalizeSecretInputString,
  type SecretInput,
  type SecretRef,
} from "../config/types.secrets.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { SecretInputMode } from "./onboard-types.js";

type MemoryProvider = "openai" | "gemini" | "voyage" | "mistral" | "ollama" | "local";

const PROVIDER_DEFAULT_MODEL: Record<MemoryProvider, string> = {
  openai: "text-embedding-3-small",
  gemini: "gemini-embedding-001",
  voyage: "voyage-4-large",
  mistral: "mistral-embed",
  ollama: "nomic-embed-text",
  local: "",
};

const PROVIDER_ENV_VAR: Partial<Record<MemoryProvider, string>> = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  voyage: "VOYAGE_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

export async function setupMemorySearch(
  config: OpenClawConfig,
  _runtime: RuntimeEnv,
  prompter: WizardPrompter,
  opts?: { secretInputMode?: SecretInputMode },
): Promise<OpenClawConfig> {
  await prompter.note(
    [
      "Memory search enables semantic recall over MEMORY.md and daily notes.",
      "You can skip now and enable later with openclaw configure.",
      "Docs: https://docs.openclaw.ai/concepts/memory",
    ].join("\n"),
    "Memory search",
  );

  const enable = await prompter.confirm({
    message: "Enable memory search now?",
    initialValue: false,
  });

  if (!enable) {
    await prompter.note(
      "Skipping memory search for now. Memory tools will run in degraded mode until configured.",
      "Memory search",
    );
    return applyMemorySearch(config, {
      enabled: false,
    });
  }

  while (true) {
    const provider = await prompter.select<MemoryProvider | "__skip__">({
      message: "Memory search provider",
      options: [
        { value: "openai", label: "OpenAI", hint: "Remote embeddings via OpenAI API key" },
        { value: "gemini", label: "Gemini", hint: "Remote embeddings via Gemini API key" },
        { value: "voyage", label: "Voyage", hint: "Remote embeddings via Voyage API key" },
        { value: "mistral", label: "Mistral", hint: "Remote embeddings via Mistral API key" },
        { value: "ollama", label: "Ollama", hint: "Local/self-hosted embeddings endpoint" },
        { value: "local", label: "Local GGUF", hint: "Local file model path (optional fallback)" },
        {
          value: "__skip__",
          label: "Skip for now",
          hint: "Disable memory search and continue onboarding",
        },
      ],
      initialValue: "openai",
    });

    if (provider === "__skip__") {
      await prompter.note(
        "Skipping memory search for now. Memory tools will run in degraded mode until configured.",
        "Memory search",
      );
      return applyMemorySearch(config, {
        enabled: false,
      });
    }

    const current = config.agents?.defaults?.memorySearch;
    const modelInput = await prompter.text({
      message: `Embedding model for ${provider}`,
      initialValue: current?.model?.trim() || PROVIDER_DEFAULT_MODEL[provider],
      placeholder: PROVIDER_DEFAULT_MODEL[provider] || "optional",
    });
    const model = modelInput.trim() || PROVIDER_DEFAULT_MODEL[provider];

    let remoteApiKey: SecretInput | undefined;
    let remoteBaseUrl: string | undefined;
    let localModelPath: string | undefined;

    if (provider === "openai" || provider === "gemini" || provider === "voyage" || provider === "mistral") {
      const envVar = PROVIDER_ENV_VAR[provider]!;
      const existingKey = normalizeSecretInputString(current?.remote?.apiKey);
      const apiKeyInput = await prompter.text({
        message: `${provider.toUpperCase()} API key (leave blank to use ${envVar})`,
        initialValue: existingKey ?? "",
        placeholder: envVar,
      });
      remoteApiKey = resolveApiKeyInput({
        provider,
        rawInput: apiKeyInput.trim(),
        existing: current?.remote?.apiKey,
        secretInputMode: opts?.secretInputMode,
      });
    } else if (provider === "ollama") {
      const baseUrlInput = await prompter.text({
        message: "Ollama base URL",
        initialValue: current?.remote?.baseUrl?.trim() || "http://127.0.0.1:11434",
        placeholder: "http://127.0.0.1:11434",
      });
      remoteBaseUrl = baseUrlInput.trim() || undefined;
    } else {
      const modelPathInput = await prompter.text({
        message: "Local model path (optional; leave blank for default local fallback)",
        initialValue: current?.local?.modelPath?.trim() || "",
        placeholder: "~/.openclaw/models/embedding.gguf",
      });
      localModelPath = modelPathInput.trim() || undefined;
    }

    const nextConfig = applyMemorySearch(config, {
      enabled: true,
      provider,
      model,
      remoteApiKey,
      remoteBaseUrl,
      localModelPath,
    });

    const validation = validateMemorySearch(nextConfig);
    if (validation.ok) {
      return nextConfig;
    }

    await prompter.note(
      [
        validation.message,
        "",
        "Fix the required values and try again, or skip memory search for now.",
      ].join("\n"),
      "Memory search",
    );

    const action = await prompter.select<"retry" | "skip">({
      message: "Memory search validation failed",
      options: [
        { value: "retry", label: "Retry configuration" },
        { value: "skip", label: "Skip for now" },
      ],
      initialValue: "retry",
    });
    if (action === "skip") {
      return applyMemorySearch(config, {
        enabled: false,
      });
    }
  }
}

function applyMemorySearch(
  config: OpenClawConfig,
  params: {
    enabled: boolean;
    provider?: MemoryProvider;
    model?: string;
    remoteApiKey?: SecretInput;
    remoteBaseUrl?: string;
    localModelPath?: string;
  },
): OpenClawConfig {
  const current = config.agents?.defaults?.memorySearch;
  const next = {
    ...current,
    enabled: params.enabled,
    ...(params.provider ? { provider: params.provider } : {}),
    ...(params.model ? { model: params.model } : {}),
    remote: {
      ...current?.remote,
      ...(params.remoteApiKey ? { apiKey: params.remoteApiKey } : {}),
      ...(params.remoteBaseUrl !== undefined ? { baseUrl: params.remoteBaseUrl } : {}),
    },
    local: {
      ...current?.local,
      ...(params.localModelPath !== undefined ? { modelPath: params.localModelPath } : {}),
    },
  };

  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        memorySearch: next,
      },
    },
  };
}

function resolveApiKeyInput(params: {
  provider: MemoryProvider;
  rawInput: string;
  existing?: SecretInput;
  secretInputMode?: SecretInputMode;
}): SecretInput | undefined {
  if (params.rawInput) {
    return params.rawInput;
  }
  if (params.existing) {
    return params.existing;
  }
  if (params.secretInputMode !== "ref") {
    return undefined;
  }
  const envVar = PROVIDER_ENV_VAR[params.provider];
  if (!envVar) {
    return undefined;
  }
  const ref: SecretRef = {
    source: "env",
    provider: DEFAULT_SECRET_PROVIDER_ALIAS,
    id: envVar,
  };
  return ref;
}

function validateMemorySearch(
  cfg: OpenClawConfig,
): { ok: true } | { ok: false; message: string } {
  try {
    resolveMemorySearchConfig(cfg, resolveDefaultAgentId(cfg));
    return { ok: true };
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message.trim()
        : String(error);
    return { ok: false, message };
  }
}
