import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
  setRuntimeConfigSnapshot: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
  getModelsCommandSecretTargetIds: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  readConfigFileSnapshotForWrite: mocks.readConfigFileSnapshotForWrite,
  setRuntimeConfigSnapshot: mocks.setRuntimeConfigSnapshot,
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../../cli/command-secret-targets.js", () => ({
  getModelsCommandSecretTargetIds: mocks.getModelsCommandSecretTargetIds,
}));

import { loadModelsConfig, loadModelsConfigWithSource } from "./load-config.js";

describe("models load-config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns source+resolved configs and sets runtime snapshot", async () => {
    const sourceConfig = {
      models: {
        providers: {
          openai: {
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
          },
        },
      },
    };
    const runtimeConfig = {
      models: { providers: { openai: { apiKey: "sk-runtime" } } }, // pragma: allowlist secret
    };
    const resolvedConfig = {
      models: { providers: { openai: { apiKey: "sk-resolved" } } }, // pragma: allowlist secret
    };
    const targetIds = new Set(["models.providers.*.apiKey"]);
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    mocks.loadConfig.mockReturnValue(runtimeConfig);
    mocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: { valid: true, resolved: sourceConfig },
      writeOptions: {},
    });
    mocks.getModelsCommandSecretTargetIds.mockReturnValue(targetIds);
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig,
      diagnostics: ["diag-one", "diag-two"],
    });

    const result = await loadModelsConfigWithSource({ commandName: "models list", runtime });

    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
      config: runtimeConfig,
      commandName: "models list",
      targetIds,
    });
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenCalledWith(resolvedConfig, sourceConfig);
    expect(runtime.log).toHaveBeenNthCalledWith(1, "[secrets] diag-one");
    expect(runtime.log).toHaveBeenNthCalledWith(2, "[secrets] diag-two");
    expect(result).toEqual({
      sourceConfig,
      resolvedConfig,
      diagnostics: ["diag-one", "diag-two"],
    });
  });

  it("loadModelsConfig returns resolved config while preserving runtime snapshot behavior", async () => {
    const sourceConfig = { models: { providers: {} } };
    const runtimeConfig = {
      models: { providers: { openai: { apiKey: "sk-runtime" } } }, // pragma: allowlist secret
    };
    const resolvedConfig = {
      models: { providers: { openai: { apiKey: "sk-resolved" } } }, // pragma: allowlist secret
    };
    const targetIds = new Set(["models.providers.*.apiKey"]);

    mocks.loadConfig.mockReturnValue(runtimeConfig);
    mocks.readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: { valid: true, resolved: sourceConfig },
      writeOptions: {},
    });
    mocks.getModelsCommandSecretTargetIds.mockReturnValue(targetIds);
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig,
      diagnostics: [],
    });

    await expect(loadModelsConfig({ commandName: "models list" })).resolves.toBe(resolvedConfig);
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenCalledWith(resolvedConfig, sourceConfig);
  });
});
