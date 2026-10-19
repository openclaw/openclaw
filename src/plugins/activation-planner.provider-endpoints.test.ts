/** Tests configured provider endpoint ownership in activation planning. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistryForPluginRegistry: vi.fn(),
}));

vi.mock("./plugin-registry-contributions.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: (...args: unknown[]) =>
    mocks.loadPluginManifestRegistryForPluginRegistry(...args),
}));

let resolveManifestActivationPluginIds: typeof import("./activation-planner.js").resolveManifestActivationPluginIds;
let resolveManifestActivationPlan: typeof import("./activation-planner.js").resolveManifestActivationPlan;

const dashscopeBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";

function endpointRegistry(params: { id: string; origin: "bundled" | "workspace" }) {
  return {
    plugins: [
      {
        id: params.id,
        origin: params.origin,
        providers: ["qwen"],
        providerEndpoints: [
          {
            endpointClass: "modelstudio-native",
            baseUrls: [dashscopeBaseUrl],
          },
        ],
      },
    ],
    diagnostics: [],
  };
}

const config = {
  models: {
    providers: {
      "custom-dashscope": {
        baseUrl: dashscopeBaseUrl,
        models: [],
      },
    },
  },
};

describe("activation planner configured provider endpoints", () => {
  beforeAll(async () => {
    ({ resolveManifestActivationPlan, resolveManifestActivationPluginIds } =
      await import("./activation-planner.js"));
  });

  beforeEach(() => {
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue(
      endpointRegistry({ id: "qwen", origin: "bundled" }),
    );
  });

  it("plans endpoint owners for custom provider ids from configured base URLs", () => {
    const trigger = { kind: "provider" as const, provider: "custom-dashscope" };
    expect(resolveManifestActivationPluginIds({ config, trigger })).toEqual(["qwen"]);
    expect(resolveManifestActivationPlan({ config, trigger }).entries).toEqual([
      {
        pluginId: "qwen",
        origin: "bundled",
        reasons: ["manifest-provider-endpoint-owner"],
      },
    ]);
  });

  it("applies disable, deny, and allowlist policy to endpoint owners", () => {
    const trigger = { kind: "provider" as const, provider: "custom-dashscope" };
    expect(
      resolveManifestActivationPluginIds({
        config: { models: config.models, plugins: { entries: { qwen: { enabled: false } } } },
        trigger,
      }),
    ).toEqual([]);
    expect(
      resolveManifestActivationPluginIds({
        config: { models: config.models, plugins: { deny: ["qwen"] } },
        trigger,
      }),
    ).toEqual([]);
    expect(
      resolveManifestActivationPluginIds({
        config: { models: config.models, plugins: { allow: ["other"] } },
        trigger,
      }),
    ).toEqual([]);
  });

  it("requires explicit trust for workspace endpoint owners", () => {
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue(
      endpointRegistry({ id: "workspace-qwen", origin: "workspace" }),
    );
    expect(
      resolveManifestActivationPluginIds({
        config,
        trigger: { kind: "provider", provider: "custom-dashscope" },
        requireExplicitManifestOwnerTrust: true,
      }),
    ).toEqual([]);
  });
});
