import { afterEach, describe, expect, it } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentRuntimeToolConfig } from "./tool-runtime-config.js";
import { resolveAgentToolSurfacePlan } from "./tool-surface-plan.js";

const secretMarker = () => ({ source: "exec", provider: "example", id: "example/value" });
const pluginConfig = (marker: unknown) => ({
  entries: { "example-plugin": { config: { marker } } },
});

function createRuntimeConfigPair(localModelLean = true) {
  const sourceConfig = {
    agents: { defaults: { experimental: { localModelLean } }, entries: { main: {} } },
    plugins: pluginConfig(secretMarker()),
  } as OpenClawConfig;
  const runtimeConfig = { ...sourceConfig, plugins: pluginConfig("resolved") } as OpenClawConfig;
  setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
  return { runtimeConfig, sourceConfig };
}

function resolveSurface(
  config: OpenClawConfig,
  options: Partial<Parameters<typeof resolveAgentToolSurfacePlan>[0]> = {},
) {
  return resolveAgentToolSurfacePlan({
    config,
    forceDirectMessageTool: true,
    toolsEnabled: true,
    isRawModelRun: false,
    ...options,
  }).toolSearchRuntimeConfig;
}

describe("Tool Search runtime snapshot selection", () => {
  afterEach(() => resetConfigRuntimeState());

  it.each([true, false])(
    "applies Tool Search after selecting the resolved snapshot for forced replies (lean: %s)",
    (localModelLean) => {
      const { runtimeConfig, sourceConfig } = createRuntimeConfigPair(localModelLean);
      const resolved = resolveSurface(sourceConfig, {
        model: localModelLean ? undefined : { toolSearchMode: "tools" },
      });

      expect(resolved?.tools?.toolSearch).toEqual({
        enabled: true,
        mode: "tools",
        searchDefaultLimit: 5,
        maxSearchLimit: 10,
      });
      expect(resolved?.plugins?.entries?.["example-plugin"]?.config).toMatchObject({
        marker: "resolved",
      });
      expect(runtimeConfig.tools).toBeUndefined();
      expect(sourceConfig.plugins?.entries?.["example-plugin"]?.config).toMatchObject({
        marker: secretMarker(),
      });
    },
  );

  it("returns the resolved snapshot unchanged for direct-message-only tool surfaces", () => {
    const { runtimeConfig, sourceConfig } = createRuntimeConfigPair();
    expect(
      resolveSurface(sourceConfig, { model: { toolSearchMode: "tools" }, toolsAllow: ["message"] }),
    ).toBe(runtimeConfig);
  });

  it.each([true, false])("preserves unrelated input with an active snapshot=%s", (snapshot) => {
    if (snapshot) {
      createRuntimeConfigPair();
    }
    const config: OpenClawConfig = snapshot
      ? { plugins: pluginConfig("explicit") }
      : { tools: { toolSearch: false } };
    expect(resolveAgentRuntimeToolConfig(config)).toBe(config);
    expect(resolveSurface(config)).toBe(config);
  });
});
