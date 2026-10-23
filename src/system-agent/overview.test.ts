import { expect, it } from "vitest";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSnapshot } from "../config/mutate.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  formatSystemAgentOverview as formatOverview,
  formatSystemAgentOnboardingWelcome,
  formatSystemAgentStartupMessage,
  loadSystemAgentOverview,
} from "./overview.js";
import { withSystemAgentOverviewSources } from "./overview.test-support.js";

function createConfigSnapshot(config: OpenClawConfig) {
  return { ...createSnapshot({ sourceConfig: config, hash: "test-hash" }), raw: "{}" };
}

it("summarizes config, agents, model, tools, and gateway", async () => {
  const runtimeConfig: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: { model: { primary: "openai/gpt-5.2" }, systemAgent: { agentId: "main" } },
      entries: { main: {}, work: { name: "Work" } },
    },
    gateway: { port: 19001 },
  };
  const overview = await withEnvAsync(
    {
      OPENCLAW_CONFIG_PATH: "/tmp/ambient-config.json",
      OPENCLAW_GATEWAY_URL: "wss://ambient.example.invalid",
      OPENCLAW_GATEWAY_PORT: "19876",
      OPENCLAW_PROFILE: "ambient-profile",
      OPENAI_API_KEY: "fixture-present",
      ANTHROPIC_API_KEY: "fixture-present",
    },
    async () => {
      const result = await withSystemAgentOverviewSources(
        createConfigSnapshot(runtimeConfig),
        () => loadSystemAgentOverview(),
        {
          probeLocalCommand: async (command) => ({
            command,
            found: command === "codex",
            version: command === "codex" ? "codex 1.0.0" : undefined,
          }),
          probeGatewayUrl: async (url) => ({ reachable: false, url, error: "offline" }),
        },
      );
      expect(process.env.OPENCLAW_GATEWAY_URL).toBe("wss://ambient.example.invalid");
      expect(process.env.OPENCLAW_CONFIG_PATH).toBe("/tmp/ambient-config.json");
      return result;
    },
  );

  expect(overview).toMatchObject({
    config: { path: "/tmp/openclaw.json", exists: true, valid: true },
    defaultAgentId: "main",
    defaultModel: "openai/gpt-5.2",
    tools: { codex: { found: true }, claude: { found: false }, gemini: { found: false } },
    gateway: { url: "ws://127.0.0.1:19001", reachable: false },
  });
  expect(overview.agents.map((agent) => agent.id)).toEqual(["main", "work"]);
  expect(overview.tools.apiKeys).toEqual({ openai: false, anthropic: false });
  expect(overview.references.docsPath).toMatch(/docs$/);
  expect(overview.references.sourceUrl).toBe("https://github.com/openclaw/openclaw");
  expect(formatOverview(overview)).toContain('Next: run "gateway status" or "restart gateway"');
  const startup = formatSystemAgentStartupMessage(overview);
  expect(startup).toContain("Hi, I'm OpenClaw — caretaker");
  expect(startup).toContain("Model: openai/gpt-5.2");
  expect(startup).toContain("Gateway: not reachable");
  expect(startup).not.toContain("`gateway status`");
  expect(startup).not.toContain("Codex:");
  expect(startup).not.toContain("Claude Code:");
  expect(startup).not.toContain("API keys:");
  const welcome = formatSystemAgentOnboardingWelcome(overview);
  expect(welcome).toContain("## Inference is ready.");
  expect(welcome).toContain("Verified model: openai/gpt-5.2");
  expect(welcome).toContain("finish your workspace, Gateway");
  expect(welcome).not.toContain("Your agent is ready");
});

it.each([false, true])(
  "reports primary readiness for a sole configured utility model with separation %s",
  async (separated) => {
    const runtimeConfig: OpenClawConfig = {
      ...(separated ? { meta: { migrations: { utilityModelSeparation: true as const } } } : {}),
      agents: {
        defaults: {
          systemAgent: { agentId: "main" },
          utilityModel: "helper@local:utility",
          models: { "local-utility/small": { alias: "helper" } },
        },
        entries: { main: {}, ops: { utilityModel: "helper@local:ops" } },
      },
      models: {
        providers: {
          "local-utility": {
            baseUrl: "http://127.0.0.1:9/v1",
            models: [
              makeProviderModelFixture({
                id: "small",
                provider: "local-utility",
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:9/v1",
              }),
            ],
          },
        },
      },
    };
    const original = structuredClone(runtimeConfig);
    const overview = await withSystemAgentOverviewSources(
      createConfigSnapshot(runtimeConfig),
      () => loadSystemAgentOverview(),
      { probeGatewayUrl: async (url) => ({ reachable: true, url }) },
    );

    expect([overview.defaultModel, overview.setupModel, overview.utilityModel]).toEqual([
      separated ? undefined : "local-utility/small",
      separated ? "helper@local:utility" : undefined,
      "helper@local:utility",
    ]);
    expect(overview.agents.map(({ id, model }) => ({ id, model }))).toEqual([
      { id: "main", model: separated ? undefined : "local-utility/small" },
      { id: "ops", model: separated ? undefined : "local-utility/small" },
    ]);
    const welcome = formatSystemAgentOnboardingWelcome(overview);
    if (separated) {
      expect(welcome).toContain("Choose a primary model");
      expect(welcome).toContain("Verified setup model: helper@local:utility");
      const startup = formatSystemAgentStartupMessage(overview);
      expect(startup).toContain("Setup model: helper@local:utility");
      expect(startup).not.toContain("Inference is unavailable");
      expect(formatOverview(overview)).toContain("Default model: not configured");
      expect(welcome).not.toContain("Say `talk to agent`");
    } else {
      expect(welcome).toContain("Verified model: local-utility/small");
      expect(welcome).toContain("Say `talk to agent`");
      expect(formatOverview(overview)).toContain('run "talk to agent"');
    }
    expect(runtimeConfig).toEqual(original);
  },
);

it("fails closed in startup copy when inference is unavailable", () => {
  const overview = {
    config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
    agents: [{ id: "main", isDefault: true }],
    defaultAgentId: "main",
    tools: {
      codex: { command: "codex", found: false },
      claude: { command: "claude", found: false },
      gemini: { command: "gemini", found: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:18789", source: "local loopback", reachable: false },
  };

  const startup = formatSystemAgentStartupMessage(overview);
  expect(formatOverview(overview)).toContain('Next: run "openclaw onboard" to establish inference');
  expect(startup).toContain("Inference is unavailable");
  expect(startup).toContain("Run `openclaw onboard`");
  expect(startup.match(/`[^`]+`/g)).toEqual(["`openclaw onboard`"]);
  expect(startup).not.toContain("local Claude Code/Codex/Gemini login");
  expect(startup).not.toContain("typed commands as last resort");
});
