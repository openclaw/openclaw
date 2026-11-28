import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModelsCommandSecretTargetIds } from "../../cli/model-secret-targets.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  getRuntimeConfigSourceSnapshot: vi.fn(),
  setRuntimeConfigSnapshot: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
}));

// mock-isolation: Model-command fixtures control source and runtime snapshots without loading operator state.
vi.mock("../../config/config.js", async () => {
  const { createTestConfigReadMocks } = await import("../test-runtime-config-helpers.js");
  return {
    ...createTestConfigReadMocks(mocks, "getRuntimeConfig"),
    getRuntimeConfigSourceSnapshot: mocks.getRuntimeConfigSourceSnapshot,
    setRuntimeConfigSnapshot: mocks.setRuntimeConfigSnapshot,
  };
});

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

import { loadModelsConfig } from "./load-config.js";

describe("models load-config", () => {
  const configWithKey = (apiKey: unknown) => ({ models: { providers: { openai: { apiKey } } } });
  const runtimeConfig = configWithKey("sk-runtime"); // pragma: allowlist secret
  const resolvedConfig = configWithKey("sk-resolved"); // pragma: allowlist secret
  const targetIds = getModelsCommandSecretTargetIds();

  const sourceConfig = configWithKey({ source: "env", provider: "default", id: "OPENAI_API_KEY" });
  const diagnostics = ["diag-one", "diag-two"];
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
    mocks.getRuntimeConfigSourceSnapshot.mockReturnValue(sourceConfig);
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({ resolvedConfig, diagnostics });
  });

  it.each([
    ["pinned", sourceConfig],
    ["unpinned", null],
  ] as const)("resolves secrets and preserves the %s source snapshot", async (_label, source) => {
    mocks.getRuntimeConfigSourceSnapshot.mockReturnValue(source);
    const runtime = createTestRuntime();
    const result = await loadModelsConfig({ commandName: "models list", runtime });
    const expectedSource = source ?? runtimeConfig;
    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
      config: runtimeConfig,
      commandName: "models list",
      targetIds,
    });
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenCalledWith(resolvedConfig, expectedSource);
    expect(runtime.error.mock.calls).toEqual([["[secrets] diag-one"], ["[secrets] diag-two"]]);
    expect(runtime.log).not.toHaveBeenCalled();
    expect(result).toBe(resolvedConfig);
  });

  it.each([false, true])("loads the resolved config with skipPluginValidation=%s", async (skip) => {
    await expect(
      loadModelsConfig({ commandName: "models list", skipPluginValidation: skip }),
    ).resolves.toBe(resolvedConfig);
    expect(mocks.getRuntimeConfig).toHaveBeenCalledWith(
      skip ? { skipPluginValidation: true } : undefined,
    );
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenCalledWith(resolvedConfig, sourceConfig);
  });
});
