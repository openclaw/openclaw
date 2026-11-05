import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveCommandSecretRefsViaGateway: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
}));

vi.mock("./command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

import { resolveCommandConfigWithSecrets } from "./command-config-resolution.js";

describe("resolveCommandConfigWithSecrets", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves scoped secret resolution and stderr diagnostics without auto-enable", async () => {
    const runtime = createTestRuntime();
    const config = { channels: {} };
    const resolvedConfig = { channels: { telegram: {} } };
    const request = {
      config,
      commandName: "status",
      targetIds: new Set(["channels.telegram.token"]),
      agentId: "ops",
      mode: "read_only_status" as const,
      allowedPaths: new Set(["channels.telegram.token"]),
      forcedActivePaths: new Set(["channels.telegram.token"]),
    };
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig,
      diagnostics: ["resolved channels.telegram.token"],
    });

    const result = await resolveCommandConfigWithSecrets({ ...request, runtime });
    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith(request);
    expect(runtime.error).toHaveBeenCalledWith("[secrets] resolved channels.telegram.token");
    expect(runtime.log).not.toHaveBeenCalled();
    expect(mocks.applyPluginAutoEnable).not.toHaveBeenCalled();
    expect(result).toEqual({
      resolvedConfig,
      effectiveConfig: resolvedConfig,
      diagnostics: ["resolved channels.telegram.token"],
    });
  });

  it("returns auto-enabled config when requested", async () => {
    const resolvedConfig = { channels: {} };
    const effectiveConfig = { channels: {}, plugins: { allow: ["telegram"] } };
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({ resolvedConfig, diagnostics: [] });
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: effectiveConfig,
    });

    const result = await resolveCommandConfigWithSecrets({
      config: resolvedConfig,
      commandName: "message",
      targetIds: new Set(["channels.telegram.token"]),
      autoEnable: true,
      env: { OPENCLAW_AUTO_ENABLE: "1" },
    });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: resolvedConfig,
      env: { OPENCLAW_AUTO_ENABLE: "1" },
    });
    expect(result.effectiveConfig).toBe(effectiveConfig);
  });
});
