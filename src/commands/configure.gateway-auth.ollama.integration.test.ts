import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { promptAuthConfig } from "./configure.gateway-auth.js";
import { makePrompter, makeRuntime } from "./setup/__tests__/test-utils.js";

describe("promptAuthConfig Ollama setup", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("HOME", mkdtempSync(join(tmpdir(), "openclaw-ollama-config-")));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const href = typeof url === "string" ? url : "url" in url ? url.url : String(url);
        if (href.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [{ name: "kimi-k2.5:cloud" }, { name: "gpt-oss:20b-cloud" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch: ${href}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", originalFetch);
  });

  it("shows the model picker after cloud-only setup when Ollama models were already configured", async () => {
    const select = vi.fn(async (params) => {
      if (params.message === "Model/auth provider") {
        return "ollama";
      }
      if (params.message === "Ollama mode") {
        return "cloud-only";
      }
      if (params.message === "How do you want to provide this API key?") {
        return "plaintext";
      }
      throw new Error(`unexpected select: ${params.message}`);
    }) as WizardPrompter["select"];
    const text = vi.fn(async (params) => {
      if (params.message === "Ollama API key") {
        return "test-ollama-key";
      }
      throw new Error(`unexpected text: ${params.message}`);
    });
    const multiselect = vi.fn(async (params) =>
      params.options.map((option: { value: string }) => option.value),
    );
    const progress = vi.fn(() => ({ update: vi.fn(), stop: vi.fn() }));
    const prompter = makePrompter({ select, text, multiselect, progress });
    const config = {
      models: {
        providers: {
          ollama: {
            api: "ollama",
            baseUrl: "https://ollama.com",
            models: [
              {
                id: "kimi-k2.5:cloud",
                name: "Kimi K2.5",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const result = await promptAuthConfig(config, makeRuntime(), prompter);

    expect(multiselect).toHaveBeenCalled();
    expect(
      multiselect.mock.calls[0]?.[0]?.options.map((option: { value: string }) => option.value),
    ).toContain("ollama/kimi-k2.5:cloud");
    expect(result.agents?.defaults?.models).toHaveProperty("ollama/kimi-k2.5:cloud");
  });
});
