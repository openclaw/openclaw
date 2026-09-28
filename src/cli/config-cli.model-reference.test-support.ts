import { expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { ConfigCliWriter } from "./config-cli.snapshot.test-support.js";

type ModelReferenceFixture = {
  setSnapshot: (resolved: OpenClawConfig, config: OpenClawConfig) => void;
  runConfigCommand: (args: string[]) => Promise<void>;
  runConfigSet: (...args: string[]) => Promise<void>;
  firstWrittenConfig: () => OpenClawConfig;
  mockWriteConfigFile: Mock<ConfigCliWriter>;
  mockCheckTouchedTextModelRefs: Mock;
  expectErrorIncludes: (text: string) => void;
  ExitError: new (code: number, message?: string) => Error;
};

export function registerConfigSetModelReferenceTests(fixture: () => ModelReferenceFixture) {
  it("normalizes retired Google Gemini model refs before writing config mutations", async () => {
    const {
      setSnapshot,
      runConfigCommand,
      firstWrittenConfig,
      mockWriteConfigFile,
      mockCheckTouchedTextModelRefs,
    } = fixture();
    const resolved: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["google/gemini-3-pro-preview"],
          },
          models: {
            "google/gemini-3-pro-preview": { alias: "gemini" },
          },
        },
      },
    };
    setSnapshot(resolved, resolved);

    await runConfigCommand([
      "config",
      "set",
      "agents.defaults.model.primary",
      "google/gemini-3-pro-preview",
    ]);

    expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
    const written = firstWrittenConfig();
    expect(written.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    });
    expect(written.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": { alias: "gemini" },
    });
    expect(mockCheckTouchedTextModelRefs).toHaveBeenCalledWith({
      env: expect.any(Object),
      previousEnv: expect.any(Object),
      config: written,
      previousConfig: expect.any(Object),
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      redactDependencyValues: true,
    });
  });

  it("rejects an unresolved primary model before writing config", async () => {
    const {
      setSnapshot,
      runConfigSet,
      mockWriteConfigFile,
      mockCheckTouchedTextModelRefs,
      expectErrorIncludes,
      ExitError,
    } = fixture();
    const resolved: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.4-mini" } } },
    };
    setSnapshot(resolved, resolved);
    mockCheckTouchedTextModelRefs.mockResolvedValueOnce({
      refsChecked: 1,
      refsTotal: 1,
      errors: [
        'Cannot set model reference "missing/nope" at agents.defaults.model.primary: Unknown model: missing/nope. Run openclaw models list to list available models.',
      ],
    });

    await expect(runConfigSet("agents.defaults.model.primary", "missing/nope")).rejects.toThrow(
      ExitError,
    );

    expect(mockWriteConfigFile).not.toHaveBeenCalled();
    expectErrorIncludes('Cannot set model reference "missing/nope"');
    expectErrorIncludes("openclaw models list");
  });

  it("preserves an authored env placeholder after model validation", async () => {
    const { setSnapshot, runConfigSet, firstWrittenConfig, mockCheckTouchedTextModelRefs } =
      fixture();
    const resolved: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.4-mini" } } },
    };
    setSnapshot(resolved, resolved);
    mockCheckTouchedTextModelRefs.mockResolvedValueOnce({
      refsChecked: 1,
      refsTotal: 1,
      errors: [],
    });

    await runConfigSet("agents.defaults.model.primary", "${MODEL_REF}");

    expect(firstWrittenConfig().agents?.defaults?.model).toEqual({
      primary: "${MODEL_REF}",
    });
    expect(mockCheckTouchedTextModelRefs).toHaveBeenCalledWith({
      env: expect.any(Object),
      previousEnv: expect.any(Object),
      config: expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({ model: { primary: "${MODEL_REF}" } }),
        }),
      }),
      previousConfig: resolved,
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      redactDependencyValues: true,
    });
  });
}

export function registerConfigUnsetModelReferenceTest(fixture: () => ModelReferenceFixture) {
  it("rejects an unset that makes a dependent model reference unresolved", async () => {
    const {
      setSnapshot,
      runConfigCommand,
      mockWriteConfigFile,
      mockCheckTouchedTextModelRefs,
      expectErrorIncludes,
      ExitError,
    } = fixture();
    const resolved: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "provider-a/main",
            fallbacks: ["backup"],
          },
        },
      },
    };
    setSnapshot(resolved, resolved);
    mockCheckTouchedTextModelRefs.mockResolvedValueOnce({
      refsChecked: 1,
      refsTotal: 1,
      errors: [
        'Cannot set model reference "backup" at agents.defaults.model.fallbacks.0: Unknown model: openai/backup. Run openclaw models list to list available models.',
      ],
    });

    await expect(
      runConfigCommand(["config", "unset", "agents.defaults.model.primary"]),
    ).rejects.toThrow(ExitError);

    expect(mockWriteConfigFile).not.toHaveBeenCalled();
    expect(mockCheckTouchedTextModelRefs).toHaveBeenCalledWith({
      env: expect.any(Object),
      previousEnv: expect.any(Object),
      config: {
        agents: { defaults: { model: { fallbacks: ["backup"] } } },
      },
      previousConfig: resolved,
      touchedPaths: [["agents", "defaults", "model", "primary"]],
      redactDependencyValues: true,
    });
    expectErrorIncludes('Cannot set model reference "backup"');
  });
}
