import type { AgentDefaultsConfig } from "./types.agent-defaults.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";

const MEMORY_DOCS_URL = "https://docs.openclaw.ai/concepts/memory";
const CANONICAL_MEMORY_PATH = "agents.defaults.memorySearch";

interface ValidationErrorParams {
  provider: string;
  configPath: string;
  missing: string[];
  docsUrl?: string;
  message: string;
}

function createValidationError(params: ValidationErrorParams): {
  provider: string;
  configPath: string;
  missing: string[];
  docsUrl: string;
  message: string;
} {
  return {
    provider: params.provider,
    configPath: params.configPath,
    missing: params.missing,
    docsUrl: params.docsUrl ?? MEMORY_DOCS_URL,
    message: params.message,
  };
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

function toIssue(error: ReturnType<typeof createValidationError>): ConfigValidationIssue {
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

function validateSingleMemorySearch(
  memorySearch: AgentDefaultsConfig["memorySearch"],
  configPath: string,
): ConfigValidationIssue[] {
  const provider = memorySearch?.provider;
  if (!provider) {
    return [];
  }

  if (provider === "ollama") {
    const baseUrl = memorySearch?.remote?.baseUrl;
    // Reject if baseUrl is explicitly set to an empty or whitespace string
    // Allow undefined - runtime will use default http://127.0.0.1:11434 or inherit from defaults
    if (typeof baseUrl === "string" && baseUrl.trim().length === 0) {
      return [
        toIssue(
          createValidationError({
            provider,
            configPath,
            missing: ["non-empty baseUrl"],
            message: "Ollama baseUrl must be a non-empty string.",
          }),
        ),
      ];
    }
  }

  return [];
}

export function validateMemorySearchProviderConfig(cfg: OpenClawConfig): ConfigValidationIssue[] {
  if (!isMemorySearchValidationEnabled(cfg)) {
    return [];
  }

  const issues: ConfigValidationIssue[] = [];

  // Validate defaults
  const defaultsMemorySearch = cfg.agents?.defaults?.memorySearch;
  if (defaultsMemorySearch) {
    issues.push(...validateSingleMemorySearch(defaultsMemorySearch, CANONICAL_MEMORY_PATH));
  }

  // Validate per-agent overrides
  const agentList = cfg.agents?.list;
  if (agentList && Array.isArray(agentList)) {
    for (let i = 0; i < agentList.length; i++) {
      const agent = agentList[i];
      if (agent?.memorySearch) {
        const agentPath = `agents.list[${i}].memorySearch`;
        issues.push(...validateSingleMemorySearch(agent.memorySearch, agentPath));
      }
    }
  }

  return issues;
}
