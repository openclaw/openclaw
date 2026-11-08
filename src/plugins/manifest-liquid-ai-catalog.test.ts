import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadPluginManifest } from "./manifest.js";

it("discovers Liquid Decision routes from metadata without inventing chat limits", () => {
  const loaded = loadPluginManifest(
    fileURLToPath(new URL("../../extensions/liquid-ai", import.meta.url)),
  );
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const provider = loaded.manifest.modelCatalog?.providers?.["liquid-ai"];
  expect(provider?.baseUrl).toBe("https://api.liquid.ai/decisions/v1");
  expect(provider?.models?.map((model) => model.id)).toEqual(["d1", "d1-ultra"]);
  for (const model of provider?.models ?? []) {
    expect(model.inference).toMatchObject({
      chat: false,
      decision: { protocol: "liquid-ai-systemone", input: ["text", "image"] },
    });
    expect(model).not.toHaveProperty("api");
    expect(model).not.toHaveProperty("contextWindow");
    expect(model).not.toHaveProperty("maxTokens");
    expect(model).not.toHaveProperty("cost");
  }
  expect(loaded.manifest.providerAuthChoices).toContainEqual(
    expect.objectContaining({ credentialOnly: true }),
  );
});
