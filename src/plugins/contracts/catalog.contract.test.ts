import { describe, expect, it } from "vitest";
import {
  augmentModelCatalogWithProviderPlugins,
  buildProviderMissingAuthMessageWithPlugin,
  resolveProviderBuiltInModelSuppression,
} from "../provider-runtime.js";

describe("provider catalog contract", () => {
  it("keeps codex-only missing-auth hints wired through the provider runtime", () => {
    expect(
      buildProviderMissingAuthMessageWithPlugin({
        provider: "openai",
        env: process.env,
        context: {
          env: process.env,
          provider: "openai",
          listProfileIds: (providerId) => (providerId === "openai-codex" ? ["p1"] : []),
        },
      }),
    ).toContain("openai-codex/gpt-5.4");
  });

  it("keeps built-in model suppression wired through the provider runtime", () => {
    expect(
      resolveProviderBuiltInModelSuppression({
        env: process.env,
        context: {
          env: process.env,
          provider: "azure-openai-responses",
          modelId: "gpt-5.3-codex-spark",
        },
      }),
    ).toMatchObject({
      suppress: true,
      errorMessage: expect.stringContaining("openai-codex/gpt-5.3-codex-spark"),
    });
  });

  it("keeps bundled model augmentation wired through the provider runtime", async () => {
    await expect(
      augmentModelCatalogWithProviderPlugins({
        env: process.env,
        context: {
          env: process.env,
          entries: [
            { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
            { provider: "openai", id: "gpt-5.2-pro", name: "GPT-5.2 Pro" },
            { provider: "openai-codex", id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
          ],
        },
      }),
    ).resolves.toEqual([
      { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
      { provider: "openai", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
      { provider: "openai-codex", id: "gpt-5.4", name: "gpt-5.4" },
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex-spark",
        name: "gpt-5.3-codex-spark",
      },
    ]);
  });
});
