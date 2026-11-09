import type { SystemAgentOverview } from "./overview.js";

export function createSystemAgentOverviewFixture(
  overrides: Partial<SystemAgentOverview> = {},
): SystemAgentOverview {
  return {
    config: { path: "/tmp/openclaw.json", exists: false, valid: false, issues: [], hash: null },
    agents: [],
    defaultAgentId: "main",
    tools: {
      codex: { command: "codex", found: false },
      claude: { command: "claude", found: false },
      gemini: { command: "gemini", found: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: false },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
    ...overrides,
  };
}
