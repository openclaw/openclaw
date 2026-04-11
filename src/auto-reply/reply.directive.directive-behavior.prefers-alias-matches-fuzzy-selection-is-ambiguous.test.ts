import "./reply.directive.directive-behavior.e2e-mocks.js";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  assertModelSelection,
  installDirectiveBehaviorE2EHooks,
  replyText,
  sessionStorePath,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { runEmbeddedPiAgentMock } from "./reply.directive.directive-behavior.e2e-mocks.js";
import { getReplyFromConfig } from "./reply.js";
import { withFullRuntimeReplyConfig } from "./reply/get-reply-fast-path.js";

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
});
