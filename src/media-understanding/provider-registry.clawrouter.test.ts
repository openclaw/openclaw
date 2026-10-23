import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { resolveEffectiveMediaEntryCapabilities } from "./entry-capabilities.js";
import { buildMediaUnderstandingCapabilityRegistry } from "./provider-capability-registry.js";
import { buildMediaUnderstandingRegistry } from "./provider-registry.js";

function config(image: boolean): OpenClawConfig {
  return {
    plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
    tools: { media: { models: [{ provider: "clawrouter", model: "fixture" }] } },
    models: {
      providers: {
        clawrouter: {
          baseUrl: "https://fixture.invalid",
          apiKey: "fixture",
          models: [
            {
              id: "fixture",
              name: "fixture",
              reasoning: false,
              input: image ? ["text", "image"] : ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        },
      },
    },
  };
}

function expectCapabilities(cfg: OpenClawConfig, image: boolean) {
  const provider = buildMediaUnderstandingRegistry(undefined, cfg).get("clawrouter");
  expect(provider?.capabilities).toEqual(image ? ["audio", "image"] : ["audio"]);
  expect(
    resolveEffectiveMediaEntryCapabilities({
      entry: { provider: "clawrouter", model: "fixture" },
      providerRegistry: buildMediaUnderstandingCapabilityRegistry(cfg),
    }),
  ).toEqual(image ? ["image"] : []);
  return provider;
}

it("projects all image-none-image configs without resetting the registered loader", async () => {
  await withTempHome(async () => {
    const first = expectCapabilities(config(true), true);
    const second = expectCapabilities(config(false), false);
    const third = expectCapabilities(config(true), true);
    expect(first).not.toBe(second);
    expect(first).not.toBe(third);
    expect(first?.capabilities).toEqual(["audio", "image"]);
    expect(second?.capabilities).toEqual(["audio"]);
  });
});

it("keeps interleaved retained loader scopes bound to each request config", async () => {
  await withTempHome(async () => {
    const image = config(true),
      text = config(false);
    const imageRegistry = loadPluginRegistryHandle({
      config: image,
      onlyPluginIds: ["clawrouter"],
    });
    const textRegistry = loadPluginRegistryHandle({ config: text, onlyPluginIds: ["clawrouter"] });
    await Promise.all([
      withPluginRuntimeRegistryScope(imageRegistry, async () => {
        const retained = expectCapabilities(image, true);
        await Promise.resolve();
        expectCapabilities(image, true);
        expect(retained?.capabilities).toEqual(["audio", "image"]);
      }),
      withPluginRuntimeRegistryScope(textRegistry, async () => {
        const retained = expectCapabilities(text, false);
        await Promise.resolve();
        expectCapabilities(text, false);
        expect(retained?.capabilities).toEqual(["audio"]);
      }),
    ]);
  });
});
