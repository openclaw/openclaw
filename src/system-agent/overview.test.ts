// OpenClaw overview tests cover summary output for rescue diagnostics.
import { describe, expect, it } from "vitest";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import {
  formatSystemAgentOverview,
  formatSystemAgentOnboardingWelcome,
  formatSystemAgentStartupMessage,
  loadSystemAgentOverview,
  type SystemAgentOverview,
} from "./overview.js";

function createConfigSnapshot(runtimeConfig: OpenClawConfig): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: runtimeConfig,
    sourceConfig: runtimeConfig,
    resolved: runtimeConfig,
    valid: true,
    runtimeConfig,
    config: runtimeConfig,
    hash: "test-hash",
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

function createOverview(defaultModel?: string): SystemAgentOverview {
  return {
    config: {
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      issues: [],
      hash: null,
    },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
    agents: [{ id: "main", isDefault: true, ...(defaultModel ? { model: defaultModel } : {}) }],
    defaultAgentId: "main",
    ...(defaultModel ? { defaultModel } : {}),
    tools: {
      codex: { command: "codex", found: false },
      claude: { command: "claude", found: false },
      gemini: { command: "gemini", found: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: {
      url: "ws://127.0.0.1:18789",
      source: "local loopback",
      reachable: false,
    },
  };
}

describe("loadSystemAgentOverview", () => {
  it("summarizes config, agents, model, tools, and gateway", async () => {
    const runtimeConfig: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: {
          model: { primary: "openai/gpt-5.2" },
          systemAgent: { agentId: "main" },
        },
        list: [{ id: "main" }, { id: "work", name: "Work" }],
      },
      gateway: { port: 19001 },
    };
    const snapshot = createConfigSnapshot(runtimeConfig);
    const overview = await loadSystemAgentOverview({
      env: { OPENCLAW_TEST_FAST: "1" },
      deps: {
        readConfigFileSnapshot: async () => snapshot,
        resolveConfigPath: () => "/tmp/openclaw.json",
        resolveGatewayPort: (cfg) => cfg?.gateway?.port ?? 8765,
        buildGatewayConnectionDetails: (input) => ({
          url: `ws://127.0.0.1:${input.config.gateway?.port ?? 8765}`,
          urlSource: "local loopback",
        }),
        probeLocalCommand: async (command) => ({
          command,
          found: command === "codex",
          version: command === "codex" ? "codex 1.0.0" : undefined,
        }),
        probeGatewayUrl: async (url) => ({ reachable: false, url, error: "offline" }),
      },
    });

    expect(overview.config.exists).toBe(true);
    expect(overview.config.valid).toBe(true);
    expect(overview.defaultAgentId).toBe("main");
    expect(overview.defaultModel).toBe("openai/gpt-5.2");
    expect(overview.agents.map((agent) => agent.id)).toEqual(["main", "work"]);
    expect(overview.tools.codex.found).toBe(true);
    expect(overview.tools.claude.found).toBe(false);
    expect(overview.tools.gemini.found).toBe(false);
    expect(overview.gateway.url).toBe("ws://127.0.0.1:19001");
    expect(overview.gateway.reachable).toBe(false);
    expect(overview.references.docsPath).toMatch(/docs$/);
    expect(overview.references.sourceUrl).toBe("https://github.com/openclaw/openclaw");
    expect(formatSystemAgentOverview(overview)).toContain(
      'Next: run "gateway status" or "restart gateway"',
    );
    const startup = formatSystemAgentStartupMessage(overview);
    expect(startup).toContain("Hi, I'm OpenClaw — caretaker");
    expect(startup).toContain("Model: openai/gpt-5.2");
    expect(startup).toContain("Gateway: not reachable");
    expect(startup).not.toContain("`gateway status`");
    expect(startup).not.toContain("Codex:");
    expect(startup).not.toContain("Claude Code:");
    expect(startup).not.toContain("API keys:");
  });

  it.each([false, true])(
    "reports primary readiness for a sole configured utility model with separation %s",
    async (separated) => {
      const runtimeConfig: OpenClawConfig = {
        ...(separated ? { meta: { migrations: { utilityModelSeparation: true as const } } } : {}),
        agents: {
          defaults: {
            utilityModel: "helper@local:utility",
            models: { "local-utility/small": { alias: "helper" } },
          },
          entries: {
            main: { default: true },
            ops: { utilityModel: "helper@local:ops" },
          },
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
      const overview = await loadSystemAgentOverview({
        env: { OPENCLAW_TEST_FAST: "1" },
        deps: {
          readConfigFileSnapshot: async () => createConfigSnapshot(runtimeConfig),
          buildGatewayConnectionDetails: () => ({
            url: "ws://127.0.0.1:18789",
            urlSource: "local loopback",
          }),
          probeLocalCommand: async (command) => ({ command, found: false }),
          probeGatewayUrl: async (url) => ({ reachable: true, url }),
        },
      });

      expect(overview.defaultModel).toBe(separated ? undefined : "local-utility/small");
      expect(overview.setupModel).toBe(separated ? "helper@local:utility" : undefined);
      expect(overview.utilityModel).toBe("helper@local:utility");
      expect(overview.agents.map(({ id, model }) => ({ id, model }))).toEqual([
        { id: "main", model: separated ? undefined : "local-utility/small" },
        { id: "ops", model: separated ? undefined : "local-utility/small" },
      ]);
      const welcome = formatSystemAgentOnboardingWelcome(overview);
      if (separated) {
        expect(welcome).toContain("Choose a primary model");
        expect(welcome).not.toContain("Say `talk to agent`");
      } else {
        expect(welcome).toContain("Verified model: local-utility/small");
        expect(welcome).toContain("Say `talk to agent`");
        expect(formatSystemAgentOverview(overview)).toContain('run "talk to agent"');
      }
      expect(runtimeConfig).toEqual(original);
    },
  );

  it("fails closed in startup copy when inference is unavailable", () => {
    const overview = createOverview();

    const startup = formatSystemAgentStartupMessage(overview);
    expect(formatSystemAgentOverview(overview)).toContain(
      'Next: run "openclaw onboard" to establish inference',
    );
    expect(startup).toContain("Inference is unavailable");
    expect(startup).toContain("Run `openclaw onboard`");
    expect(startup.match(/`[^`]+`/g)).toEqual(["`openclaw onboard`"]);
    expect(startup).not.toContain("local Claude Code/Codex/Gemini login");
    expect(startup).not.toContain("typed commands as last resort");
  });

  it("describes utility setup without claiming ordinary agent readiness", () => {
    const overview = {
      ...createOverview(),
      setupModel: "fixture/small",
      utilityModel: "fixture/small",
    };
    expect(formatSystemAgentStartupMessage(overview)).toContain("Setup model: fixture/small");
    expect(formatSystemAgentStartupMessage(overview)).not.toContain("Inference is unavailable");
    const welcome = formatSystemAgentOnboardingWelcome(overview);
    expect(welcome).toContain("Verified setup model: fixture/small");
    expect(welcome).toContain("Choose a primary model");
    expect(welcome).not.toContain("Say `talk to agent`");
    expect(formatSystemAgentOverview(overview)).toContain("Default model: not configured");
  });

  it("describes post-inference onboarding as the start of remaining setup", () => {
    const overview = createOverview("openai/gpt-5.2");

    const welcome = formatSystemAgentOnboardingWelcome(overview);
    expect(welcome).toContain("## Inference is ready.");
    expect(welcome).toContain("Verified model: openai/gpt-5.2");
    expect(welcome).toContain("finish your workspace, Gateway");
    expect(welcome).not.toContain("Your agent is ready");
  });
});
