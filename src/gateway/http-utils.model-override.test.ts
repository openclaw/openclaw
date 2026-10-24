import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { createGatewayRequest } from "./hooks-test-helpers.js";

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

type Defaults = NonNullable<OpenClawConfig["agents"]>["defaults"];
const configure = (defaults: Defaults, provider?: ModelProviderConfig) =>
  loadConfigMock.mockReturnValue({
    agents: { ownership: "explicit", entries: { main: {} }, defaults },
    models: provider && { providers: { "custom/team": provider } },
  } satisfies OpenClawConfig);

const override = (model: string) =>
  resolveOpenAiCompatModelOverride({
    req: createGatewayRequest({ path: "/", headers: { "x-openclaw-model": model } }),
    agentId: "main",
    model: "openclaw",
  });

beforeEach(() => {
  loadConfigMock.mockReset();
  configure({ model: { primary: "openai/gpt-5.4" }, models: { "openai/gpt-5.4": {} } });
  loadGatewayModelCatalogMock
    .mockReset()
    .mockResolvedValue([{ id: "gpt-5.4", name: "GPT 5.4", provider: "openai" }]);
});

it("keeps provider-wildcard grants separate from a colliding default provider", async () => {
  configure(
    { model: { primary: "Reader" }, modelPolicy: { allow: ["custom/*"] } },
    {
      api: "openai-completions",
      baseUrl: "https://fixture.invalid/v1",
      models: [
        {
          id: "Reader",
          name: "Reader",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          maxTokens: 4096,
        },
      ],
    },
  );
  loadGatewayModelCatalogMock.mockResolvedValue([
    { provider: "custom", id: "team/Reader", name: "Allowed model" },
    { provider: "custom/team", id: "Reader", name: "Other provider default" },
  ]);

  await expect(override("Reader")).resolves.toEqual({
    errorMessage: "Model 'custom/team/Reader' is not allowed for agent 'main'.",
  });
  await expect(override("custom/team/Reader")).resolves.toEqual({
    modelOverride: "custom/team/Reader",
  });
});

it("rejects CLI model overrides outside the configured allowlist", async () => {
  await expect(override("claude-cli/opus")).resolves.toEqual({
    errorMessage: "Model 'claude-cli/opus' is not allowed for agent 'main'.",
  });
});
