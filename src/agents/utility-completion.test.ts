import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { hasAvailableAuthForProvider } from "./model-auth.js";
import { prepareUtilityCompletionForAgent } from "./utility-completion.js";

vi.mock("./model-auth.js", () => ({ hasAvailableAuthForProvider: vi.fn() }));

const manifestPlugins = [
  {
    id: "anthropic",
    modelCatalog: {
      providers: {
        anthropic: {
          defaultUtilityModel: "claude-haiku-4-5",
          models: [{ id: "claude-haiku-4-5" }, { id: "claude-opus-5" }, { id: "claude-sonnet-5" }],
        },
      },
    },
  },
] as unknown as PluginMetadataSnapshot["plugins"];

const cliPrimary: OpenClawConfig = {
  agents: {
    defaults: {
      model: "anthropic/claude-opus-5",
      models: { "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } } },
    },
  },
};

beforeEach(() => {
  vi.mocked(hasAvailableAuthForProvider).mockReset().mockResolvedValue(false);
});

describe("prepareUtilityCompletionForAgent", () => {
  it.each([
    { hasAuth: false, modelRef: undefined },
    { hasAuth: true, modelRef: undefined },
    { hasAuth: false, modelRef: "anthropic/claude-haiku-4-5" },
    { hasAuth: true, modelRef: "anthropic/claude-haiku-4-5" },
  ])(
    "prepares the automatic route (auth=$hasAuth, observer ref=$modelRef)",
    async ({ hasAuth, modelRef }) => {
      vi.mocked(hasAvailableAuthForProvider).mockResolvedValue(hasAuth);
      const prepared = await prepareUtilityCompletionForAgent({
        cfg: cliPrimary,
        agentId: "main",
        useUtilityModel: true,
        manifestPlugins,
        modelRef,
      });

      expect(prepared).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5" });
      expect(prepared.agentHarnessRuntimeOverride).toBe("claude-cli");
      expect(hasAvailableAuthForProvider).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "an explicit same-provider selection",
      cfg: cliPrimary,
      modelRef: "anthropic/claude-sonnet-5",
    },
    {
      label: "an explicit utility model",
      cfg: {
        agents: {
          defaults: { ...cliPrimary.agents?.defaults, utilityModel: "anthropic/claude-haiku-4-5" },
        },
      },
      modelRef: undefined,
    },
    {
      label: "a primary with no runtime pin",
      cfg: { agents: { defaults: { model: "anthropic/claude-opus-5" } } },
      modelRef: undefined,
    },
  ])("keeps $label on its own route without probing auth", async ({ cfg, modelRef }) => {
    const prepared = await prepareUtilityCompletionForAgent({
      cfg,
      agentId: "main",
      useUtilityModel: true,
      manifestPlugins,
      modelRef,
    });

    expect(prepared).not.toHaveProperty("agentHarnessRuntimeOverride");
    expect(hasAvailableAuthForProvider).not.toHaveBeenCalled();
  });
});
