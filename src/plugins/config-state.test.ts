import { describe, expect, it } from "vitest";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveEnableState,
} from "./config-state.js";

describe("normalizePluginsConfig", () => {
  it.each([
    [{}, "memory-core"],
    [{ slots: { memory: "custom-memory" } }, "custom-memory"],
    [{ slots: { memory: "none" } }, null],
    [{ slots: { memory: "None" } }, null],
    [{ slots: { memory: "  custom-memory  " } }, "custom-memory"],
    [{ slots: { memory: "" } }, "memory-core"],
    [{ slots: { memory: "   " } }, "memory-core"],
  ] as const)("normalizes memory slot for %o", (config, expected) => {
    expect(normalizePluginsConfig(config).slots.memory).toBe(expected);
  });

  it("normalizes plugin hook policy flags", () => {
    const result = normalizePluginsConfig({
      entries: {
        "voice-call": {
          hooks: {
            allowPromptInjection: false,
          },
        },
      },
    });
    expect(result.entries["voice-call"]?.hooks?.allowPromptInjection).toBe(false);
  });

  it("drops invalid plugin hook policy values", () => {
    const result = normalizePluginsConfig({
      entries: {
        "voice-call": {
          hooks: {
            allowPromptInjection: "nope",
          } as unknown as { allowPromptInjection: boolean },
        },
      },
    });
    expect(result.entries["voice-call"]?.hooks).toBeUndefined();
  });

  it("normalizes plugin subagent override policy settings", () => {
    const result = normalizePluginsConfig({
      entries: {
        "voice-call": {
          subagent: {
            allowModelOverride: true,
            allowedModels: [" anthropic/claude-sonnet-4-6 ", "", "openai/gpt-5.4"],
          },
        },
      },
    });
    expect(result.entries["voice-call"]?.subagent).toEqual({
      allowModelOverride: true,
      hasAllowedModelsConfig: true,
      allowedModels: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"],
    });
  });

  it("preserves explicit subagent allowlist intent even when all entries are invalid", () => {
    const result = normalizePluginsConfig({
      entries: {
        "voice-call": {
          subagent: {
            allowModelOverride: true,
            allowedModels: [42, null, "anthropic"],
          } as unknown as { allowModelOverride: boolean; allowedModels: string[] },
        },
      },
    });
    expect(result.entries["voice-call"]?.subagent).toEqual({
      allowModelOverride: true,
      hasAllowedModelsConfig: true,
      allowedModels: ["anthropic"],
    });
  });

  it("keeps explicit invalid subagent allowlist config visible to callers", () => {
    const result = normalizePluginsConfig({
      entries: {
        "voice-call": {
          subagent: {
            allowModelOverride: "nope",
            allowedModels: [42, null],
          } as unknown as { allowModelOverride: boolean; allowedModels: string[] },
        },
      },
    });
    expect(result.entries["voice-call"]?.subagent).toEqual({
      hasAllowedModelsConfig: true,
    });
  });

  it("normalizes legacy plugin ids to their merged bundled plugin id", () => {
    const result = normalizePluginsConfig({
      allow: ["openai-codex", "google-gemini-cli", "minimax-portal-auth"],
      deny: ["openai-codex", "google-gemini-cli", "minimax-portal-auth"],
      entries: {
        "openai-codex": {
          enabled: true,
        },
        "google-gemini-cli": {
          enabled: true,
        },
        "minimax-portal-auth": {
          enabled: false,
        },
      },
    });

    expect(result.allow).toEqual(["openai", "google", "minimax"]);
    expect(result.deny).toEqual(["openai", "google", "minimax"]);
    expect(result.entries.openai?.enabled).toBe(true);
    expect(result.entries.google?.enabled).toBe(true);
    expect(result.entries.minimax?.enabled).toBe(false);
  });
});

describe("resolveEffectiveEnableState", () => {
  function resolveBundledTelegramState(config: Parameters<typeof normalizePluginsConfig>[0]) {
    const normalized = normalizePluginsConfig(config);
    return resolveEffectiveEnableState({
      id: "telegram",
      origin: "bundled",
      config: normalized,
      rootConfig: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
    });
  }

  it.each([
    [{ enabled: true }, { enabled: true }],
    [
      {
        enabled: true,
        entries: {
          telegram: {
            enabled: false,
          },
        },
      },
      { enabled: false, reason: "disabled in config" },
    ],
  ] as const)("resolves bundled telegram state for %o", (config, expected) => {
    expect(resolveBundledTelegramState(config)).toEqual(expected);
  });
});

describe("resolveEnableState", () => {
  it.each([
    [
      "openai",
      "bundled",
      normalizePluginsConfig({}),
      undefined,
      { enabled: false, reason: "bundled (disabled by default)" },
    ],
    ["openai", "bundled", normalizePluginsConfig({}), true, { enabled: true }],
    ["google", "bundled", normalizePluginsConfig({}), true, { enabled: true }],
    ["profile-aware", "bundled", normalizePluginsConfig({}), true, { enabled: true }],
  ] as const)(
    "resolves %s enable state for origin=%s manifestEnabledByDefault=%s",
    (id, origin, config, manifestEnabledByDefault, expected) => {
      expect(resolveEnableState(id, origin, config, manifestEnabledByDefault)).toEqual(expected);
    },
  );

  it("keeps the selected memory slot plugin enabled even when omitted from plugins.allow", () => {
    const state = resolveEnableState(
      "memory-core",
      "bundled",
      normalizePluginsConfig({
        allow: ["telegram"],
        slots: { memory: "memory-core" },
      }),
    );
    expect(state).toEqual({ enabled: true });
  });

  it("keeps explicit disable authoritative for the selected memory slot plugin", () => {
    const state = resolveEnableState(
      "memory-core",
      "bundled",
      normalizePluginsConfig({
        allow: ["telegram"],
        slots: { memory: "memory-core" },
        entries: {
          "memory-core": {
            enabled: false,
          },
        },
      }),
    );
    expect(state).toEqual({ enabled: false, reason: "disabled in config" });
  });

  it.each([
    [
      normalizePluginsConfig({}),
      {
        enabled: false,
        reason: "workspace plugin (disabled by default)",
      },
    ],
    [
      normalizePluginsConfig({
        allow: ["workspace-helper"],
      }),
      { enabled: true },
    ],
    [
      normalizePluginsConfig({
        entries: {
          "workspace-helper": {
            enabled: true,
          },
        },
      }),
      { enabled: true },
    ],
  ] as const)("resolves workspace-helper enable state for %o", (config, expected) => {
    expect(resolveEnableState("workspace-helper", "workspace", config)).toEqual(expected);
  });

  it("does not let the default memory slot auto-enable an untrusted workspace plugin", () => {
    const state = resolveEnableState(
      "memory-core",
      "workspace",
      normalizePluginsConfig({
        slots: { memory: "memory-core" },
      }),
    );
    expect(state).toEqual({
      enabled: false,
      reason: "workspace plugin (disabled by default)",
    });
  });
});
