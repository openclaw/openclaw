import "./reply.directive.directive-behavior.e2e-mocks.js";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  assertModelSelection,
  installDirectiveBehaviorE2EHooks,
  runEmbeddedPiAgent,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { getReplyFromConfig } from "./reply.js";

function makeModelDefinition(id: string, name: string) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
}

function makeMoonshotConfig(home: string, storePath: string) {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-5" },
        workspace: path.join(home, "openclaw"),
        models: {
          "anthropic/claude-opus-4-5": {},
          "moonshot/kimi-k2-0905-preview": {},
        },
      },
    },
    models: {
      mode: "merge",
      providers: {
        moonshot: {
          baseUrl: "https://api.moonshot.ai/v1",
          apiKey: "sk-test",
          api: "openai-completions",
          models: [makeModelDefinition("kimi-k2-0905-preview", "Kimi K2")],
        },
      },
    },
    session: { store: storePath },
  } as unknown as OpenClawConfig;
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
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  }

  it("supports fuzzy model matches on /model directive", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      const res = await runMoonshotModelDirective({
        home,
        storePath,
        body: "/model kimi",
      });

      expectMoonshotSelectionFromResponse({ response: res, storePath });
    });
  });
  it("resolves provider-less exact model ids via fuzzy matching when unambiguous", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      const res = await runMoonshotModelDirective({
        home,
        storePath,
        body: "/model kimi-k2-0905-preview",
      });

      expectMoonshotSelectionFromResponse({ response: res, storePath });
    });
  });
  it("supports fuzzy matches within a provider on /model provider/model", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      const res = await runMoonshotModelDirective({
        home,
        storePath,
        body: "/model moonshot/kimi",
      });

      expectMoonshotSelectionFromResponse({ response: res, storePath });
    });
  });
  it("picks the best fuzzy match when multiple models match", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      await getReplyFromConfig(
        { Body: "/model minimax", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "minimax/MiniMax-M2.1" },
              workspace: path.join(home, "openclaw"),
              models: {
                "minimax/MiniMax-M2.1": {},
                "minimax/MiniMax-M2.1-lightning": {},
                "lmstudio/minimax-m2.1-gs32": {},
              },
            },
          },
          models: {
            mode: "merge",
            providers: {
              minimax: {
                baseUrl: "https://api.minimax.io/anthropic",
                apiKey: "sk-test",
                api: "anthropic-messages",
                models: [makeModelDefinition("MiniMax-M2.1", "MiniMax M2.1")],
              },
              lmstudio: {
                baseUrl: "http://127.0.0.1:1234/v1",
                apiKey: "lmstudio",
                api: "openai-responses",
                models: [makeModelDefinition("minimax-m2.1-gs32", "MiniMax M2.1 GS32")],
              },
            },
          },
          session: { store: storePath },
        } as unknown as OpenClawConfig,
      );

      assertModelSelection(storePath);
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
  it("picks the best fuzzy match within a provider", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");

      await getReplyFromConfig(
        { Body: "/model minimax/m2.1", From: "+1222", To: "+1222", CommandAuthorized: true },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "minimax/MiniMax-M2.1" },
              workspace: path.join(home, "openclaw"),
              models: {
                "minimax/MiniMax-M2.1": {},
                "minimax/MiniMax-M2.1-lightning": {},
              },
            },
          },
          models: {
            mode: "merge",
            providers: {
              minimax: {
                baseUrl: "https://api.minimax.io/anthropic",
                apiKey: "sk-test",
                api: "anthropic-messages",
                models: [
                  makeModelDefinition("MiniMax-M2.1", "MiniMax M2.1"),
                  makeModelDefinition("MiniMax-M2.1-lightning", "MiniMax M2.1 Lightning"),
                ],
              },
            },
          },
          session: { store: storePath },
        } as unknown as OpenClawConfig,
      );

      assertModelSelection(storePath);
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});
