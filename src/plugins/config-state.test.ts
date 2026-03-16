import { describe, expect, it } from "vitest";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveEnableState,
} from "./config-state.js";

describe("normalizePluginsConfig", () => {
  it("uses default memory slot when not specified", () => {
    const result = normalizePluginsConfig({});
    expect(result.slots.memory).toBe("memory-core");
  });

  it("respects explicit memory slot value", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "custom-memory" },
    });
    expect(result.slots.memory).toBe("custom-memory");
  });

  it("disables memory slot when set to 'none' (case insensitive)", () => {
    expect(
      normalizePluginsConfig({
        slots: { memory: "none" },
      }).slots.memory,
    ).toBeNull();
    expect(
      normalizePluginsConfig({
        slots: { memory: "None" },
      }).slots.memory,
    ).toBeNull();
  });

  it("trims whitespace from memory slot value", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "  custom-memory  " },
    });
    expect(result.slots.memory).toBe("custom-memory");
  });

  it("uses default when memory slot is empty string", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "" },
    });
    expect(result.slots.memory).toBe("memory-core");
  });

  it("uses default when memory slot is whitespace only", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "   " },
    });
    expect(result.slots.memory).toBe("memory-core");
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

  it("normalizes legacy plugin ids to their merged bundled plugin id", () => {
    const result = normalizePluginsConfig({
      allow: ["openai-codex"],
      deny: ["openai-codex"],
      entries: {
        "openai-codex": {
          enabled: true,
        },
      },
    });

    expect(result.allow).toEqual(["openai"]);
    expect(result.deny).toEqual(["openai"]);
    expect(result.entries.openai?.enabled).toBe(true);
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

  it("enables bundled channels when channels.<id>.enabled=true", () => {
    const state = resolveBundledTelegramState({
      enabled: true,
    });
    expect(state).toEqual({ enabled: true });
  });

  it("keeps explicit plugin-level disable authoritative", () => {
    const state = resolveBundledTelegramState({
      enabled: true,
      entries: {
        telegram: {
          enabled: false,
        },
      },
    });
    expect(state).toEqual({ enabled: false, reason: "disabled in config" });
  });
});

describe("resolveEnableState", () => {
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

  it("disables workspace plugins by default when they are only auto-discovered from the workspace", () => {
    const state = resolveEnableState("workspace-helper", "workspace", normalizePluginsConfig({}));
    expect(state).toEqual({
      enabled: false,
      reason: "workspace plugin (disabled by default)",
    });
  });

  it("allows workspace plugins when explicitly listed in plugins.allow", () => {
    const state = resolveEnableState(
      "workspace-helper",
      "workspace",
      normalizePluginsConfig({
        allow: ["workspace-helper"],
      }),
    );
    expect(state).toEqual({ enabled: true });
  });

  it("allows workspace plugins when explicitly enabled in plugin entries", () => {
    const state = resolveEnableState(
      "workspace-helper",
      "workspace",
      normalizePluginsConfig({
        entries: {
          "workspace-helper": {
            enabled: true,
          },
        },
      }),
    );
    expect(state).toEqual({ enabled: true });
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
