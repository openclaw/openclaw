import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquireBundledCapabilityRuntimeRegistry } from "../plugins/bundled-capability-runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { requireRegisteredProvider } from "../test-utils/plugin-registration.js";
import { createCodeModeTools } from "./code-mode.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search.js";
import { applyAgentToolSurfaceCatalog, resolveAgentToolSurfacePlan } from "./tool-surface-plan.js";

describe("registered MiniMax Code Mode tool surface", () => {
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
    expect(
      providers.map((provider) => provider.id),
      JSON.stringify({
        plugins: captured.registry.plugins.map(({ id, status, error }) => ({ id, status, error })),
        diagnostics: captured.registry.diagnostics,
      }),
    ).toEqual(expect.arrayContaining(["minimax", "minimax-portal"]));
  });
  afterAll(() => release?.());

  async function resolveModel(providerId: string, route: "static" | "dynamic", modelId: string) {
    const provider = requireRegisteredProvider(providers, providerId);
    if (route === "dynamic") {
      const resolve = expectDefined(provider.resolveDynamicModel, "registered dynamic hook");
      return expectDefined(
        resolve({
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
    const catalog = expectDefined(provider.staticCatalog, "registered static catalog");
    const result = expectDefined(
      await catalog.run({
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
    const config: OpenClawConfig = { tools: { codeMode: "auto", toolSearch: false } };
    const plan = resolveAgentToolSurfacePlan({
      config,
      model,
      toolsEnabled: true,
      forceDirectMessageTool: false,
      isRawModelRun: false,
    });
    const catalogRef = createToolSearchCatalogRef();
    try {
      const controls = plan.codeModeControlsEnabled
        ? createCodeModeTools({
            config,
            catalogRef,
            executeTool: async () => ({ content: [], details: {} }),
          })
        : [];
      const result = applyAgentToolSurfaceCatalog({
        tools: [...controls, createStubTool("query_records")],
        config,
        ...plan,
        catalogRef,
      });
      return {
        names: result.tools.map((tool) => tool.name),
        catalogToolCount: result.catalogToolCount,
      };
    } finally {
      clearToolSearchCatalog({ catalogRef });
    }
  }

  it.each([
    ["minimax", "static"],
    ["minimax-portal", "static"],
    ["minimax", "dynamic"],
    ["minimax-portal", "dynamic"],
  ] as const)("engages M3 Code Mode through %s %s resolution", async (providerId, route) => {
    const model = await resolveModel(providerId, route, "MiniMax-M3");
    expect(assembleSurface(model)).toEqual({
      names: ["exec", "wait"],
      catalogToolCount: 1,
    });
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
});
