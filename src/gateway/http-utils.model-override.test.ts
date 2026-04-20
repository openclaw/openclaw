import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const loadConfigMock = vi.fn();
const loadGatewayModelCatalogMock = vi.fn();

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

vi.mock("./server-model-catalog.js", () => ({
  loadGatewayModelCatalog: () => loadGatewayModelCatalogMock(),
}));

import { resolveAgentIdFromModel, resolveOpenAiCompatModelOverride } from "./http-utils.js";

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("resolveOpenAiCompatModelOverride", () => {
  beforeEach(() => {
    loadConfigMock.mockReset().mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "openai/gpt-5.4": {},
          },
        },
        list: [{ id: "main" }, { id: "hephaestus" }],
      },
    } satisfies OpenClawConfig);
    loadGatewayModelCatalogMock
      .mockReset()
      .mockResolvedValue([{ id: "gpt-5.4", name: "GPT 5.4", provider: "openai" }]);
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

  it("treats openclaw provider-model forms as model overrides, not agent ids", async () => {
    await expect(
      resolveOpenAiCompatModelOverride({
        req: createReq(),
        agentId: "main",
        model: "openclaw/openai/gpt-5.4",
      }),
    ).resolves.toEqual({
      modelOverride: "openai/gpt-5.4",
    });
  });

  it("still treats openclaw single-segment forms as agent ids when configured", () => {
    expect(resolveAgentIdFromModel("openclaw/hephaestus")).toBe("hephaestus");
  });

  it("rejects invalid openclaw body model forms that are neither agent ids nor provider models", async () => {
    await expect(
      resolveOpenAiCompatModelOverride({
        req: createReq(),
        agentId: "main",
        model: "openclaw/not-a-real-target",
      }),
    ).resolves.toEqual({
      errorMessage:
        "Invalid `model`. Use `openclaw`, `openclaw/<agentId>`, or `openclaw/<provider>/<model>`.",
    });
  });
});
