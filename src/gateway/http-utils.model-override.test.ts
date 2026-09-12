/**
 * Tests HTTP model override parsing from gateway request headers and URLs.
 */
import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const loadConfigMock = vi.fn();
const loadGatewayModelCatalogMock = vi.fn();

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
}));

vi.mock("./server-model-catalog.js", () => ({
  loadGatewayModelCatalog: (...args: unknown[]) => loadGatewayModelCatalogMock(...args),
}));

import { resolveOpenAiCompatModelOverride } from "./http-utils.js";

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("resolveOpenAiCompatModelOverride", () => {
  beforeEach(() => {
    loadConfigMock.mockReset().mockReturnValue({
      agents: {
        ownership: "explicit",
        list: [{ id: "main" }, { id: "beta" }],
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "openai/gpt-5.4": {},
          },
        },
      },
    } satisfies OpenClawConfig);
    loadGatewayModelCatalogMock
      .mockReset()
      .mockResolvedValue([{ id: "gpt-5.4", name: "GPT 5.4", provider: "openai" }]);
  });

  it("permits the configured primary without widening a colliding provider wildcard", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        ownership: "explicit",
        list: [{ id: "main" }],
        defaults: { model: { primary: "Reader" }, modelPolicy: { allow: ["custom/*"] } },
      },
      models: {
        providers: {
          "custom/team": {
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
            models: ["Reader", "Other"].map((id) => ({
              id,
              name: id,
              reasoning: false,
              input: ["text" as const],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 4096,
            })),
          },
        },
      },
    } satisfies OpenClawConfig);
    loadGatewayModelCatalogMock.mockResolvedValue([
      { provider: "custom", id: "team/Reader", name: "Allowed model" },
      { provider: "custom/team", id: "Reader", name: "Other provider default" },
      { provider: "custom/team", id: "Other", name: "Other provider model" },
    ]);

    await expect(
      resolveOpenAiCompatModelOverride({
        req: createReq({ "x-openclaw-model": "Reader" }),
        agentId: "main",
        model: "openclaw",
      }),
    ).resolves.toEqual({ modelOverride: "Reader" });
    await expect(
      resolveOpenAiCompatModelOverride({
        req: createReq({ "x-openclaw-model": "Other" }),
        agentId: "main",
        model: "openclaw",
      }),
    ).resolves.toEqual({
      errorMessage: "Model 'custom/team/Other' is not allowed for agent 'main'.",
    });
    await expect(
      resolveOpenAiCompatModelOverride({
        req: createReq({ "x-openclaw-model": "custom/team/Reader" }),
        agentId: "main",
        model: "openclaw",
      }),
    ).resolves.toEqual({ modelOverride: "custom/team/Reader" });
  });

  it("rejects CLI model overrides outside the configured allowlist", async () => {
    await expect(
      resolveOpenAiCompatModelOverride({
        req: createReq({ "x-openclaw-model": "claude-cli/opus" }),
        agentId: "main",
        model: "openclaw",
      }),
    ).resolves.toEqual({
      errorMessage: "Model 'claude-cli/opus' is not allowed for agent 'main'.",
    });
  });

  it.each(["main", "beta"])("reads the prepared catalog for selected agent %s", async (agentId) => {
    await expect(
      resolveOpenAiCompatModelOverride({
        req: createReq({ "x-openclaw-model": "openai/gpt-5.4" }),
        agentId,
        model: "openclaw",
      }),
    ).resolves.toEqual({ modelOverride: "openai/gpt-5.4" });
    expect(loadGatewayModelCatalogMock).toHaveBeenCalledExactlyOnceWith({ agentId });
  });
});
