import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn(),
  logConfigUpdated: vi.fn(),
  resolveAgentModelPrimaryValue: vi.fn(),
  applyDefaultModelPrimaryUpdate: vi.fn(),
  resolveModelTarget: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
  writeConfigFile: (...args: unknown[]) => mocks.writeConfigFile(...args),
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: (...args: unknown[]) => mocks.logConfigUpdated(...args),
}));

vi.mock("../../config/model-input.js", () => ({
  resolveAgentModelPrimaryValue: (...args: unknown[]) =>
    mocks.resolveAgentModelPrimaryValue(...args),
  toAgentModelListLike: vi.fn((x) => x),
}));

vi.mock("./shared.js", () => ({
  applyDefaultModelPrimaryUpdate: (...args: unknown[]) =>
    mocks.applyDefaultModelPrimaryUpdate(...args),
  resolveModelTarget: (...args: unknown[]) => mocks.resolveModelTarget(...args),
  updateConfig: async (fn: (cfg: unknown) => unknown) => {
    const cfg = await mocks.readConfigFileSnapshot();
    return fn(cfg.config);
  },
}));

import { modelsSetCommand } from "./set.js";

describe("models/set", () => {
  const mockRuntime = {
    log: vi.fn(),
  } as unknown as import("../../runtime.js").RuntimeEnv;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("auto-save old model as fallback", () => {
    it("adds old model as fallback when switching models", async () => {
      const oldConfig = {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-4o",
            },
          },
        },
      } as unknown as OpenClawConfig;

      const updatedConfig = {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      } as unknown as OpenClawConfig;

      mocks.resolveAgentModelPrimaryValue.mockReturnValueOnce("openai/gpt-4o");
      mocks.applyDefaultModelPrimaryUpdate.mockReturnValueOnce(updatedConfig);
      mocks.resolveModelTarget.mockReturnValueOnce({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });

      mocks.readConfigFileSnapshot
        .mockResolvedValueOnce({ valid: true, config: oldConfig })
        .mockResolvedValueOnce({ valid: true, config: oldConfig })
        .mockResolvedValueOnce({ valid: true, config: updatedConfig });

      mocks.writeConfigFile.mockResolvedValue(undefined);

      await modelsSetCommand("claude-opus-4-6", mockRuntime);

      // Should have called writeConfigFile 3 times (read old, update, add fallback)
      expect(mocks.writeConfigFile).toHaveBeenCalledTimes(3);
    });

    it("does not add duplicate fallback if already in fallbacks", async () => {
      const oldConfig = {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-4o",
              fallbacks: ["anthropic/claude-sonnet-4-5"],
            },
          },
        },
      } as unknown as OpenClawConfig;

      const updatedConfig = {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["anthropic/claude-sonnet-4-5"],
            },
          },
        },
      } as unknown as OpenClawConfig;

      mocks.resolveAgentModelPrimaryValue.mockReturnValueOnce("openai/gpt-4o");
      mocks.applyDefaultModelPrimaryUpdate.mockReturnValueOnce(updatedConfig);
      mocks.resolveModelTarget.mockReturnValueOnce({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });

      mocks.readConfigFileSnapshot
        .mockResolvedValueOnce({ valid: true, config: oldConfig })
        .mockResolvedValueOnce({ valid: true, config: oldConfig })
        .mockResolvedValueOnce({ valid: true, config: updatedConfig });

      mocks.writeConfigFile.mockResolvedValue(undefined);

      await modelsSetCommand("claude-opus-4-6", mockRuntime);

      // Should only write twice (read + update), not add duplicate fallback
      expect(mocks.writeConfigFile).toHaveBeenCalledTimes(2);
    });

    it("does not add fallback if old model equals new model", async () => {
      const config = {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      } as unknown as OpenClawConfig;

      mocks.resolveAgentModelPrimaryValue.mockReturnValueOnce("anthropic/claude-opus-4-6");
      mocks.applyDefaultModelPrimaryUpdate.mockReturnValueOnce(config);
      mocks.resolveModelTarget.mockReturnValueOnce({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });

      mocks.readConfigFileSnapshot
        .mockResolvedValueOnce({ valid: true, config })
        .mockResolvedValueOnce({ valid: true, config });

      mocks.writeConfigFile.mockResolvedValue(undefined);

      await modelsSetCommand("claude-opus-4-6", mockRuntime);

      // Should only write twice (read + update), no fallback added
      expect(mocks.writeConfigFile).toHaveBeenCalledTimes(2);
    });

    it("does not add fallback if no old model exists", async () => {
      const oldConfig = {
        agents: {},
      } as unknown as OpenClawConfig;

      const newConfig = {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
            },
          },
        },
      } as unknown as OpenClawConfig;

      mocks.resolveAgentModelPrimaryValue.mockReturnValueOnce(null);
      mocks.applyDefaultModelPrimaryUpdate.mockReturnValueOnce(newConfig);

      mocks.readConfigFileSnapshot
        .mockResolvedValueOnce({ valid: true, config: oldConfig })
        .mockResolvedValueOnce({ valid: true, config: newConfig });

      mocks.writeConfigFile.mockResolvedValue(undefined);

      await modelsSetCommand("claude-opus-4-6", mockRuntime);

      // Should only write once (update only), no fallback
      expect(mocks.writeConfigFile).toHaveBeenCalledTimes(1);
    });
  });
});
