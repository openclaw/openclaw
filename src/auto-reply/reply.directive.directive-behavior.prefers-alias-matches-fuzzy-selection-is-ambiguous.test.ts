import "./reply.directive.directive-behavior.e2e-mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { drainSystemEvents } from "../infra/system-events.js";
import {
  assertModelSelection,
  installDirectiveBehaviorE2EHooks,
  MAIN_SESSION_KEY,
  makeWhatsAppDirectiveConfig,
  replyText,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { runEmbeddedPiAgentMock } from "./reply.directive.directive-behavior.e2e-mocks.js";
import { withFullRuntimeReplyConfig } from "./reply/get-reply-fast-path.js";
import { getReplyFromConfig } from "./reply.js";

function makeModelDefinition(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function makeModelSwitchConfig(home: string) {
  return makeWhatsAppDirectiveConfig(home, {
    model: { primary: "openai/gpt-4.1-mini" },
    models: {
      "openai/gpt-4.1-mini": {},
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  });
}

function makeMoonshotConfig(home: string, storePath: string) {
  return withFullRuntimeReplyConfig({
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        workspace: path.join(home, "openclaw"),
        models: {
          "anthropic/claude-opus-4-6": {},
          "moonshot/kimi-k2-0905-preview": {},
        },
      },
    },
    models: {
      mode: "merge",
      providers: {
        moonshot: {
          baseUrl: "https://api.moonshot.ai/v1",
          apiKey: "sk-test", // pragma: allowlist secret
          api: "openai-completions",
          models: [makeModelDefinition("kimi-k2-0905-preview", "Kimi K2")],
        },
      },
    },
    session: { store: storePath },
  } as unknown as OpenClawConfig);
}

describe("directive behavior", () => {
  installDirectiveBehaviorE2EHooks();

  async function runMoonshotModelDirective(params: {
    home: string;
    storePath: string;
    body: string;
  }) {
    return await getReplyFromConfig(
      { Body: params.body, From: "+1222", To: "+1222", CommandAuthorized: true },
      {},
      makeMoonshotConfig(params.home, params.storePath),
    );
  }

  function expectMoonshotSelectionFromResponse(params: {
    response: Awaited<ReturnType<typeof getReplyFromConfig>>;
    storePath: string;
  }) {
    const text = Array.isArray(params.response) ? params.response[0]?.text : params.response?.text;
    expect(text).toContain("Model set to moonshot/kimi-k2-0905-preview.");
    assertModelSelection(params.storePath, {
      provider: "moonshot",
      model: "kimi-k2-0905-preview",
    });
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  }

  it("supports unambiguous fuzzy model matches across /model forms", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      for (const body of ["/model kimi", "/model kimi-k2-0905-preview", "/model moonshot/kimi"]) {
        const res = await runMoonshotModelDirective({
          home,
          storePath,
          body,
        });
        expectMoonshotSelectionFromResponse({ response: res, storePath });
      }
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
  it("picks the best fuzzy match for global and provider-scoped minimax queries", async () => {
    await withTempHome(async (home) => {
      for (const testCase of [
        {
          body: "/model minimax",
          storePath: path.join(home, "sessions-global-fuzzy.json"),
          expectedSelection: {},
          config: {
            agents: {
              defaults: {
                model: { primary: "minimax/MiniMax-M2.7" },
                workspace: path.join(home, "openclaw"),
                models: {
                  "minimax/MiniMax-M2.7": {},
                  "minimax/MiniMax-M2.7-highspeed": {},
                  "lmstudio/minimax-m2.5-gs32": {},
                },
              },
            },
            models: {
              mode: "merge",
              providers: {
                minimax: {
                  baseUrl: "https://api.minimax.io/anthropic",
                  apiKey: "sk-test", // pragma: allowlist secret
                  api: "anthropic-messages",
                  models: [
                    makeModelDefinition("MiniMax-M2.7", "MiniMax M2.7"),
                    makeModelDefinition("MiniMax-M2.7-highspeed", "MiniMax M2.7 Highspeed"),
                  ],
                },
                lmstudio: {
                  baseUrl: "http://127.0.0.1:1234/v1",
                  apiKey: "lmstudio", // pragma: allowlist secret
                  api: "openai-responses",
                  models: [makeModelDefinition("minimax-m2.5-gs32", "MiniMax M2.5 GS32")],
                },
              },
            },
          },
        },
        {
          body: "/model minimax/highspeed",
          storePath: path.join(home, "sessions-provider-fuzzy.json"),
          expectedSelection: {
            provider: "minimax",
            model: "MiniMax-M2.7-highspeed",
          },
          config: {
            agents: {
              defaults: {
                model: { primary: "minimax/MiniMax-M2.7" },
                workspace: path.join(home, "openclaw"),
                models: {
                  "minimax/MiniMax-M2.7": {},
                  "minimax/MiniMax-M2.7-highspeed": {},
                },
              },
            },
            models: {
              mode: "merge",
              providers: {
                minimax: {
                  baseUrl: "https://api.minimax.io/anthropic",
                  apiKey: "sk-test", // pragma: allowlist secret
                  api: "anthropic-messages",
                  models: [
                    makeModelDefinition("MiniMax-M2.7", "MiniMax M2.7"),
                    makeModelDefinition("MiniMax-M2.7-highspeed", "MiniMax M2.7 Highspeed"),
                  ],
                },
              },
            },
          },
        },
      ]) {
        await getReplyFromConfig(
          { Body: testCase.body, From: "+1222", To: "+1222", CommandAuthorized: true },
          {},
          withFullRuntimeReplyConfig({
            ...testCase.config,
            session: { store: testCase.storePath },
          } as unknown as OpenClawConfig),
        );
        assertModelSelection(testCase.storePath, testCase.expectedSelection);
      }
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
  it("prefers alias matches when fuzzy selection is ambiguous", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);

      const res = await getReplyFromConfig(
        { Body: "/model ki", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        withFullRuntimeReplyConfig({
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-6" },
              workspace: path.join(home, "openclaw"),
              models: {
                "anthropic/claude-opus-4-6": {},
                "moonshot/kimi-k2-0905-preview": { alias: "Kimi" },
                "lmstudio/kimi-k2-0905-preview": {},
              },
            },
          },
          models: {
            mode: "merge",
            providers: {
              moonshot: {
                baseUrl: "https://api.moonshot.ai/v1",
                apiKey: "sk-test", // pragma: allowlist secret
                api: "openai-completions",
                models: [makeModelDefinition("kimi-k2-0905-preview", "Kimi K2")],
              },
              lmstudio: {
                baseUrl: "http://127.0.0.1:1234/v1",
                apiKey: "lmstudio", // pragma: allowlist secret
                api: "openai-responses",
                models: [makeModelDefinition("kimi-k2-0905-preview", "Kimi K2 (Local)")],
              },
            },
          },
          session: { store: storePath },
        } as OpenClawConfig),
      );

      const text = replyText(res);
      expect(text).toContain("Model set to Kimi (moonshot/kimi-k2-0905-preview).");
      assertModelSelection(storePath, {
        provider: "moonshot",
        model: "kimi-k2-0905-preview",
      });
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
  it("stores auth profile overrides on /model directive", async () => {
    await withTempHome(async (home) => {
      const storePath = sessionStorePath(home);
      const authDir = path.join(home, ".openclaw", "agents", "main", "agent");
      await fs.mkdir(authDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(authDir, "auth-profiles.json"),
        JSON.stringify(
          {
            version: 1,
            profiles: {
              "anthropic:work": {
                type: "api_key",
                provider: "anthropic",
                key: "sk-test-1234567890",
              },
            },
          },
          null,
          2,
        ),
      );

      const res = await getReplyFromConfig(
        { Body: "/model Opus@anthropic:work", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        makeModelSwitchConfig(home),
      );

      const text = replyText(res);
      expect(text).toContain("Auth profile set to anthropic:work");
      const store = loadSessionStore(storePath);
      const entry = store["agent:main:main"];
      expect(entry.authProfileOverride).toBe("anthropic:work");
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
  it("queues system events for model, elevated, and reasoning directives", async () => {
    await withTempHome(async (home) => {
      drainSystemEvents(MAIN_SESSION_KEY);
      await getReplyFromConfig(
        { Body: "/model Opus", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        makeModelSwitchConfig(home),
      );

      let events = drainSystemEvents(MAIN_SESSION_KEY);
      expect(events).toContain("Model switched to Opus (anthropic/claude-opus-4-6).");

      drainSystemEvents(MAIN_SESSION_KEY);

      await getReplyFromConfig(
        {
          Body: "/elevated on",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          CommandAuthorized: true,
        },
        {},
        makeWhatsAppDirectiveConfig(
          home,
          { model: { primary: "openai/gpt-4.1-mini" } },
          { tools: { elevated: { allowFrom: { whatsapp: ["*"] } } } },
        ),
      );

      events = drainSystemEvents(MAIN_SESSION_KEY);
      expect(events.some((e) => e.includes("Elevated ASK"))).toBe(true);

      drainSystemEvents(MAIN_SESSION_KEY);

      await getReplyFromConfig(
        {
          Body: "/reasoning stream",
          From: "+1222",
          To: "+1222",
          Provider: "whatsapp",
          CommandAuthorized: true,
        },
        {},
        makeWhatsAppDirectiveConfig(home, { model: { primary: "openai/gpt-4.1-mini" } }),
      );

      events = drainSystemEvents(MAIN_SESSION_KEY);
      expect(events.some((e) => e.includes("Reasoning STREAM"))).toBe(true);
      expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    });
  });
});
