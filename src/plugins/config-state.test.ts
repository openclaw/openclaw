import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveEnableState,
} from "./config-state.js";

function normalizeVoiceCallEntry(entry: Record<string, unknown>) {
  return normalizePluginsConfig({
    entries: {
      "voice-call": entry,
    },
  }).entries["voice-call"];
}

function expectResolvedEnableState(
  params: Parameters<typeof resolveEnableState>,
  expected: ReturnType<typeof resolveEnableState>,
) {
  expect(resolveEnableState(...params)).toEqual(expected);
}

function expectNormalizedEnableState(params: {
  id: string;
  origin: "bundled" | "workspace";
  config: Record<string, unknown>;
  manifestEnabledByDefault?: boolean;
  expected: ReturnType<typeof resolveEnableState>;
}) {
  expectResolvedEnableState(
    [
      params.id,
      params.origin,
      normalizePluginsConfig(params.config),
      params.manifestEnabledByDefault,
    ],
    params.expected,
  );
}

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

  it.each([
    {
      name: "normalizes plugin hook policy flags",
      entry: {
        hooks: {
          allowPromptInjection: false,
        },
      },
      expectedHooks: {
        allowPromptInjection: false,
      },
    },
    {
      name: "drops invalid plugin hook policy values",
      entry: {
        hooks: {
          allowPromptInjection: "nope",
        } as unknown as { allowPromptInjection: boolean },
      },
      expectedHooks: undefined,
    },
  ] as const)("$name", ({ entry, expectedHooks }) => {
    expect(normalizeVoiceCallEntry(entry)?.hooks).toEqual(expectedHooks);
  });

  it.each([
    {
      name: "normalizes plugin subagent override policy settings",
      subagent: {
        allowModelOverride: true,
        allowedModels: [" anthropic/claude-sonnet-4-6 ", "", "openai/gpt-5.4"],
      },
      expected: {
        allowModelOverride: true,
        hasAllowedModelsConfig: true,
        allowedModels: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"],
      },
    },
    {
      name: "preserves explicit subagent allowlist intent even when all entries are invalid",
      subagent: {
        allowModelOverride: true,
        allowedModels: [42, null, "anthropic"],
      } as unknown as { allowModelOverride: boolean; allowedModels: string[] },
      expected: {
        allowModelOverride: true,
        hasAllowedModelsConfig: true,
        allowedModels: ["anthropic"],
      },
    },
    {
      name: "keeps explicit invalid subagent allowlist config visible to callers",
      subagent: {
        allowModelOverride: "nope",
        allowedModels: [42, null],
      } as unknown as { allowModelOverride: boolean; allowedModels: string[] },
      expected: {
        hasAllowedModelsConfig: true,
      },
    },
  ] as const)("$name", ({ subagent, expected }) => {
    expect(normalizeVoiceCallEntry({ subagent })?.subagent).toEqual(expected);
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

  it("rescues bundled channel when excluded by allowlist but enabled in channels config", () => {
    // This tests the fix for #57219 / #56426
    // Setting plugins.allow should not silently disable bundled channels that are explicitly configured
    const state = resolveEffectiveEnableState({
      id: "telegram",
      origin: "bundled",
      config: normalizePluginsConfig({
        allow: ["acpx"], // telegram not in allowlist
      }),
      rootConfig: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
    });
    expect(state).toEqual({ enabled: true });
  });

  it("does not rescue bundled channel when disabled in channels config", () => {
    // Even with the allowlist rescue, channels config should still take precedence
    const state = resolveEffectiveEnableState({
      id: "telegram",
      origin: "bundled",
      config: normalizePluginsConfig({
        allow: ["acpx"],
      }),
      rootConfig: {
        channels: {
          telegram: {
            enabled: false, // explicitly disabled
          },
        },
      },
    });
    expect(state.enabled).toBe(false);
  });

  it("does NOT rescue workspace plugin via channels config (security boundary)", () => {
    // This tests the security boundary: origin === "bundled" guard
    // Workspace plugins should NOT be able to bypass allowlist via channels config
    const rootConfig = {
      channels: {
        telegram: {
          enabled: true,
        },
      },
      plugins: {
        allow: ["acpx"], // telegram not in allowlist
      },
    };

    const result = resolveEffectiveEnableState({
      id: "telegram",
      origin: "workspace", // NOT bundled - this is a hypothetical workspace plugin
      config: normalizePluginsConfig(rootConfig.plugins),
      rootConfig: rootConfig as OpenClawConfig,
    });

    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("workspace plugin (disabled by default)");
  });

  it("does not rescue bundled channel when not configured in channels", () => {
    // Bundled channels still need explicit channels.*.enabled: true to be rescued
    const state = resolveEffectiveEnableState({
      id: "telegram",
      origin: "bundled",
      config: normalizePluginsConfig({
        allow: ["acpx"],
      }),
      rootConfig: {
        channels: {
          // telegram not configured
        },
      },
    });
    expect(state.enabled).toBe(false);
    expect(state.reason).toBe("not in allowlist");
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
      expectResolvedEnableState([id, origin, config, manifestEnabledByDefault], expected);
    },
  );

  it.each([
    {
      name: "keeps the selected memory slot plugin enabled even when omitted from plugins.allow",
      config: {
        allow: ["telegram"],
        slots: { memory: "memory-core" },
      },
      expected: { enabled: true },
    },
    {
      name: "keeps explicit disable authoritative for the selected memory slot plugin",
      config: {
        allow: ["telegram"],
        slots: { memory: "memory-core" },
        entries: {
          "memory-core": {
            enabled: false,
          },
        },
      },
      expected: { enabled: false, reason: "disabled in config" },
    },
  ] as const)("$name", ({ config, expected }) => {
    expectNormalizedEnableState({
      id: "memory-core",
      origin: "bundled",
      config,
      expected,
    });
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
    expectNormalizedEnableState({
      id: "memory-core",
      origin: "workspace",
      config: {
        slots: { memory: "memory-core" },
      },
      expected: {
        enabled: false,
        reason: "workspace plugin (disabled by default)",
      },
    });
  });
});
