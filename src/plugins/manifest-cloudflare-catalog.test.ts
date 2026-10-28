import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadPluginManifest } from "./manifest.js";

it("discovers Clef separately from Gateway chat without loading provider runtime", () => {
  const loaded = loadPluginManifest(
    fileURLToPath(new URL("../../extensions/cloudflare-ai-gateway", import.meta.url)),
  );
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const provider = loaded.manifest.modelCatalog?.providers?.["cloudflare-workers-ai"];
  expect(provider?.baseUrl).toBeUndefined();
  expect(provider?.models).toEqual([
    expect.objectContaining({
      id: "@cf/cloudflare/clef",
      inference: expect.objectContaining({
        chat: false,
        decision: expect.objectContaining({
          protocol: "cloudflare-systemone",
          limits: expect.objectContaining({ maxQuestions: 64 }),
        }),
      }),
    }),
  ]);
  expect(provider?.models[0]).not.toHaveProperty("api");
  expect(loaded.manifest.providerAuthChoices).toContainEqual(
    expect.objectContaining({ provider: "cloudflare-workers-ai", credentialOnly: true }),
  );
});
