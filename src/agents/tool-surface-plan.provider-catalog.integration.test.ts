import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { acquireBundledCapabilityRuntimeRegistry } from "../plugins/bundled-capability-runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { requireRegisteredProvider } from "../test-utils/plugin-registration.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "./harness/tool-surface-bridge.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";

let providers: ProviderPlugin[];
let release: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const captured = await acquireBundledCapabilityRuntimeRegistry({
    pluginIds: ["minimax"],
    preferBuiltPluginArtifacts: false,
    config: { plugins: { allow: ["minimax"], entries: { minimax: { enabled: true } } } },
    env: {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: fileURLToPath(new URL("../../extensions", import.meta.url)),
    },
  });
  release = captured.release;
  providers = captured.registry.providers.map((entry) => entry.provider);
});
afterAll(() => release?.());

async function resolveModel(providerId: string, route: "static" | "dynamic", modelId: string) {
  const provider = requireRegisteredProvider(providers, providerId);
  expect(provider.id).toBe(providerId);
  if (route === "dynamic") {
    return expectDefined(
      provider.resolveDynamicModel?.({
        provider: providerId,
        modelId,
        modelRegistry: {
          getAll: () => [],
          getAvailable: () => [],
          find: () => undefined,
          hasConfiguredAuth: () => false,
        },
      }),
      "dynamic model",
    );
  }
  const result = expectDefined(
    await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    }),
    "static catalog result",
  );
  const config =
    "provider" in result
      ? result.provider
      : expectDefined(result.providers[providerId], "static provider");
  return expectDefined(
    config.models.find((model) => model.id === modelId),
    "static model",
  );
}

function assembleSurface(model: Awaited<ReturnType<typeof resolveModel>>) {
  const runtime = createAgentHarnessToolSurfaceRuntimeCore({
    config: { tools: { codeMode: "auto", toolSearch: false } },
    model,
    modelToolsEnabled: true,
    executeTool: async () => ({ content: [], details: {} }),
  });
  try {
    const { tools, catalog } = runtime.compactTools([createStubTool("query_records")]);
    return { names: tools.map((tool) => tool.name), catalogToolCount: catalog.catalogToolCount };
  } finally {
    runtime.cleanup();
  }
}

it.each([
  ["minimax", "static"],
  ["minimax-portal", "static"],
  ["minimax", "dynamic"],
  ["minimax-portal", "dynamic"],
] as const)("engages M3 Code Mode through %s %s resolution", async (providerId, route) => {
  const model = await resolveModel(providerId, route, "MiniMax-M3");
  expect(assembleSurface(model)).toEqual({ names: ["exec", "wait"], catalogToolCount: 1 });
  expect(model.compat?.codeMode).toBe("preferred");
});

it.each(["minimax", "minimax-portal"])(
  "keeps %s M2.7 tools direct under auto",
  async (providerId) => {
    for (const route of ["static", "dynamic"] as const) {
      const model = await resolveModel(providerId, route, "MiniMax-M2.7");
      expect(assembleSurface(model).names, route).toEqual(["query_records"]);
    }
  },
);
