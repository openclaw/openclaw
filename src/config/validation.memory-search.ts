import { resolveModelAuthMode } from "../agents/model-auth.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";

const MEMORY_DOCS_URL = "https://docs.openclaw.ai/concepts/memory";
const CANONICAL_MEMORY_PATH = "agents.defaults.memorySearch";

export class ConfigurationError extends Error {
  readonly provider: string;
  readonly configPath: string;
  readonly missing: string[];
  readonly docsUrl: string;

  constructor(params: {
    provider: string;
    configPath: string;
    missing: string[];
    docsUrl?: string;
    message: string;
  }) {
    super(params.message);
    this.name = "ConfigurationError";
    this.provider = params.provider;
    this.configPath = params.configPath;
    this.missing = params.missing;
    this.docsUrl = params.docsUrl ?? MEMORY_DOCS_URL;
  }
}

function isMemorySearchValidationEnabled(cfg: OpenClawConfig): boolean {
  if (cfg.memory?.backend === "qmd") {
    return false;
  }
  const memorySearch = cfg.agents?.defaults?.memorySearch;
  if (!memorySearch || typeof memorySearch !== "object") {
    return false;
  }
  return memorySearch.enabled ?? true;
}

function buildOpenAIExampleConfig(): string {
  return [
    "agents:",
    "  defaults:",
    "    memorySearch:",
    "      provider: openai",
    "      model: text-embedding-3-small",
    "      remote:",
    "        apiKey: ${OPENAI_API_KEY}",
  ].join("\n");
}

function buildOllamaExampleConfig(): string {
  return [
    "agents:",
    "  defaults:",
    "    memorySearch:",
    "      provider: ollama",
    "      model: nomic-embed-text",
    "      remote:",
    "        baseUrl: http://localhost:11434",
  ].join("\n");
}

function toIssue(error: ConfigurationError): ConfigValidationIssue {
  const missing = error.missing.map((entry) => `- ${entry}`).join("\n");
  return {
    path: error.configPath,
    message: [
      "Invalid configuration:",
      "",
      `${error.configPath}.provider=${error.provider}`,
      "",
      "Missing required keys:",
      missing,
      "",
      "Example:",
      error.provider === "ollama" ? buildOllamaExampleConfig() : buildOpenAIExampleConfig(),
      "",
      `Docs: ${error.docsUrl}`,
    ].join("\n"),
  };
}

function hasResolvableOpenAiCredential(cfg: OpenClawConfig): boolean {
  const mode = resolveModelAuthMode("openai", cfg);
  return mode === "api-key" || mode === "mixed";
}

export function validateMemorySearchProviderConfig(cfg: OpenClawConfig): ConfigValidationIssue[] {
  if (!isMemorySearchValidationEnabled(cfg)) {
    return [];
  }

  const memorySearch = cfg.agents?.defaults?.memorySearch;
  const provider = memorySearch?.provider;
  if (!provider) {
    return [];
  }

  if (provider === "openai" && !hasResolvableOpenAiCredential(cfg)) {
    return [
      toIssue(
        new ConfigurationError({
          provider,
          configPath: CANONICAL_MEMORY_PATH,
          missing: ["apiKey (config/auth profile/environment)"],
          message: "Missing OpenAI embedding credential for memory search.",
        }),
      ),
    ];
  }

  if (provider === "ollama") {
    const baseUrl = memorySearch?.remote?.baseUrl;
    if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
      return [
        toIssue(
          new ConfigurationError({
            provider,
            configPath: CANONICAL_MEMORY_PATH,
            missing: ["host (agents.defaults.memorySearch.remote.baseUrl)"],
            message: "Missing Ollama host configuration for memory search.",
          }),
        ),
      ];
    }
  }

  return [];
}
