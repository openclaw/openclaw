import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveModelsCommandReply } from "./commands-models.js";

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
    { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  ]),
}));

describe("resolveModelsCommandReply (zulip)", () => {
  const cfg = {
    agents: {
      defaults: {
        model: "openai/gpt-4.1",
      },
    },
  } as OpenClawConfig;

  it("returns provider buttons for /models on Zulip", async () => {
    const reply = await resolveModelsCommandReply({
      cfg,
      commandBodyNormalized: "/models",
      surface: "zulip",
    });

    expect(reply?.text).toBe("Select a provider:");
    expect(reply?.channelData?.zulip).toMatchObject({
      heading: "Model Providers",
      buttons: expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({ text: "anthropic (1)", callback_data: "mdl_list_anthropic_1" }),
          expect.objectContaining({ text: "openai (2)", callback_data: "mdl_list_openai_1" }),
        ]),
      ]),
    });
  });

  it("returns model buttons for /models <provider> on Zulip", async () => {
    const reply = await resolveModelsCommandReply({
      cfg,
      commandBodyNormalized: "/models openai",
      surface: "zulip",
      currentModel: "openai/gpt-4.1-mini",
    });

    expect(reply?.text).toContain("Models (openai");
    const zulipData = reply?.channelData?.zulip as
      | { heading?: string; buttons?: Array<Array<{ text?: string; callback_data?: string }>> }
      | undefined;
    expect(zulipData).toMatchObject({
      heading: "openai models",
    });
    const buttons = zulipData?.buttons;
    expect(buttons).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("gpt-4.1-mini ✓") }),
        ]),
        expect.arrayContaining([
          expect.objectContaining({ text: "<< Back", callback_data: "mdl_back" }),
        ]),
      ]),
    );
  });
});
