// Covers the shared startup-plan activation config assembly used by both gateway boot
// (prepareGatewayPluginBootstrap) and the /status plugins should-run drift check.
import { describe, expect, it, vi } from "vitest";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayStartupPluginActivationConfig } from "./plugin-activation-runtime-config.js";

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: vi.fn(),
}));

const applyPluginAutoEnableMock = vi.mocked(applyPluginAutoEnable);

describe("resolveGatewayStartupPluginActivationConfig", () => {
  it("auto-enables the source config, then merges activation into the runtime config", () => {
    const runtimeConfig = {
      plugins: { entries: { keep: { enabled: true, runtimeOnly: 1 } } },
    } as unknown as OpenClawConfig;
    const sourceConfig = {
      plugins: { entries: { keep: { enabled: true } } },
    } as unknown as OpenClawConfig;
    // Auto-enable runs against the source config and yields an activation config that
    // enables an extra plugin; only enable/allow surfaces should carry into runtime config.
    applyPluginAutoEnableMock.mockReturnValue({
      config: { plugins: { entries: { added: { enabled: true } } } },
    } as unknown as ReturnType<typeof applyPluginAutoEnable>);

    const result = resolveGatewayStartupPluginActivationConfig({
      runtimeConfig,
      activationSourceConfig: sourceConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    // Activation is computed from the operator source config, not the runtime config.
    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith(
      expect.objectContaining({ config: sourceConfig }),
    );
    // Runtime-only field is preserved; the auto-enabled activation entry is merged in.
    expect(result.plugins?.entries?.keep).toEqual({ enabled: true, runtimeOnly: 1 });
    expect(result.plugins?.entries?.added).toEqual({ enabled: true });
  });

  it("passes manifestRegistry and discovery through to auto-enable when provided", () => {
    applyPluginAutoEnableMock.mockReturnValue({
      config: {},
    } as unknown as ReturnType<typeof applyPluginAutoEnable>);
    const manifestRegistry = { plugins: [] } as never;
    const discovery = { candidates: [] } as never;

    resolveGatewayStartupPluginActivationConfig({
      runtimeConfig: {} as OpenClawConfig,
      activationSourceConfig: {} as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
      manifestRegistry,
      discovery,
    });

    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith(
      expect.objectContaining({ manifestRegistry, discovery }),
    );
  });
});
