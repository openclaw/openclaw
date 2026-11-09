// Covers command config normalization and path validation.
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { isCommandFlagEnabled, isRestartEnabled } from "./commands.flags.js";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "./commands.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry(
      [
        { id: "discord", autoEnabled: true },
        { id: "telegram", autoEnabled: true },
        { id: "slack", autoEnabled: false },
        { id: "whatsapp", autoEnabled: false },
        { id: "demo-channel", autoEnabled: true },
      ].map(({ id, autoEnabled }) => ({
        pluginId: id,
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id }),
          commands: {
            nativeCommandsAutoEnabled: autoEnabled,
            nativeSkillsAutoEnabled: autoEnabled,
          },
        },
      })),
    ),
  );
});

describe.each([
  ["resolveNativeSkillsEnabled", resolveNativeSkillsEnabled],
  ["resolveNativeCommandsEnabled", resolveNativeCommandsEnabled],
] as const)("%s", (_name, resolve) => {
  it.each([
    ["discord", undefined, "auto", true],
    ["telegram", undefined, "auto", true],
    ["slack", undefined, "auto", false],
    ["whatsapp", undefined, "auto", false],
    ["demo-channel", undefined, "auto", true],
    ["slack", true, "auto", true],
    ["discord", false, true, false],
    ["slack", true, false, true],
    ["discord", undefined, false, false],
  ] as const)(
    "resolves %s with provider=%s and global=%s as %s",
    (providerId, providerSetting, globalSetting, expected) => {
      expect(resolve({ providerId, providerSetting, globalSetting })).toBe(expected);
    },
  );
});

describe("resolveNativeSkillsEnabled", () => {
  it("uses only enabled package channel metadata for bundled auto defaults before runtime loads", () => {
    setActivePluginRegistry(createTestRegistry([]));
    const env = {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
    };

    const discordConfig = (enabled: boolean) => ({
      plugins: { entries: { discord: { enabled } } },
    });
    for (const [resolve, providerId, config, expected] of [
      [resolveNativeSkillsEnabled, "discord", undefined, false],
      [resolveNativeSkillsEnabled, "discord", discordConfig(true), true],
      [resolveNativeCommandsEnabled, "slack", undefined, false],
      [resolveNativeCommandsEnabled, "discord", discordConfig(false), false],
    ] as const) {
      expect(
        resolve({ providerId, globalSetting: "auto", env, ...(config ? { config } : {}) }),
      ).toBe(expected);
    }
  });
});

describe("isNativeCommandsExplicitlyDisabled", () => {
  it.each([
    [false, true, true],
    [undefined, false, true],
    [true, false, false],
    ["auto", false, false],
  ] as const)(
    "resolves provider=%s and global=%s as %s",
    (providerSetting, globalSetting, expected) => {
      expect(isNativeCommandsExplicitlyDisabled({ providerSetting, globalSetting })).toBe(expected);
    },
  );
});

describe("isRestartEnabled", () => {
  it("defaults to enabled unless explicitly false", () => {
    expect(isRestartEnabled(undefined)).toBe(true);
    expect(isRestartEnabled({})).toBe(true);
    expect(isRestartEnabled({ commands: {} })).toBe(true);
    expect(isRestartEnabled({ commands: { restart: true } })).toBe(true);
    expect(isRestartEnabled({ commands: { restart: false } })).toBe(false);
  });

  it("ignores inherited restart flags", () => {
    expect(
      isRestartEnabled({ commands: Object.create({ restart: false }) as Record<string, unknown> }),
    ).toBe(true);
  });
});

describe("isCommandFlagEnabled", () => {
  it("requires own boolean true", () => {
    expect(isCommandFlagEnabled({ commands: { bash: true } }, "bash")).toBe(true);
    expect(isCommandFlagEnabled({ commands: { bash: false } }, "bash")).toBe(false);
    expect(
      isCommandFlagEnabled(
        { commands: Object.create({ bash: true }) as Record<string, unknown> },
        "bash",
      ),
    ).toBe(false);
  });
});

describe("retired commands config", () => {
  it("rejects legacy modelsWrite during validation", () => {
    const result = validateConfigObjectWithPlugins({
      commands: { text: true, modelsWrite: false },
    });

    expect(result.ok).toBe(false);
  });
});
