import { beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes diagnostics to stderr (not stdout) so --json consumers can parse stdout cleanly (#81055)", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as const;
    const config = { channels: {} };
    const resolvedConfig = { channels: { telegram: {} } };
    const targetIds = new Set(["channels.telegram.token"]);
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig,
      diagnostics: [
        "status --json: failed to resolve channels.discord.token locally (env unset).",
        "status --json: gateway secrets.resolve unavailable (protocol mismatch).",
      ],
    });

    const result = await resolveCommandConfigWithSecrets({
      config,
      commandName: "status",
      targetIds,
      mode: "read_only_status",
      runtime,
    });

    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
      config,
      commandName: "status",
      targetIds,
      mode: "read_only_status",
    });
    expect(runtime.error).toHaveBeenCalledWith(
      "[secrets] status --json: failed to resolve channels.discord.token locally (env unset).",
    );
    expect(runtime.error).toHaveBeenCalledWith(
      "[secrets] status --json: gateway secrets.resolve unavailable (protocol mismatch).",
    );
    expect(runtime.error).toHaveBeenCalledTimes(2);
    expect(runtime.log).not.toHaveBeenCalled();
    expect(mocks.applyPluginAutoEnable).not.toHaveBeenCalled();
    expect(result).toEqual({
      resolvedConfig,
      effectiveConfig: resolvedConfig,
      diagnostics: [
        "status --json: failed to resolve channels.discord.token locally (env unset).",
        "status --json: gateway secrets.resolve unavailable (protocol mismatch).",
      ],
    });
  });

  it("returns auto-enabled config when requested", async () => {
    const resolvedConfig = { channels: {} };
    const effectiveConfig = { channels: {}, plugins: { allow: ["telegram"] } };
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig,
      diagnostics: [],
    });
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: effectiveConfig,
      changes: ["enabled telegram"],
    });

    const result = await resolveCommandConfigWithSecrets({
      config: resolvedConfig,
      commandName: "message",
      targetIds: new Set(["channels.telegram.token"]),
      autoEnable: true,
      env: { OPENCLAW_AUTO_ENABLE: "1" } as NodeJS.ProcessEnv,
    });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: resolvedConfig,
      env: { OPENCLAW_AUTO_ENABLE: "1" },
    });
    expect(result.effectiveConfig).toBe(effectiveConfig);
  });
});
