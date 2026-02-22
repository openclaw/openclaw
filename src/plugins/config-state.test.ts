import { describe, expect, it } from "vitest";
import { normalizePluginsConfig, resolveEnableState } from "./config-state.js";

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
});

describe("resolveEnableState", () => {
  const defaultConfig = normalizePluginsConfig({});

  it("denies non-bundled plugins by default (default-deny)", () => {
    const result = resolveEnableState("third-party-plugin", "workspace", defaultConfig);
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("not explicitly allowed");
  });

  it("denies non-bundled plugins from global extensions", () => {
    const result = resolveEnableState("some-plugin", "global", defaultConfig);
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("not explicitly allowed");
  });

  it("allows bundled plugins that are in BUNDLED_ENABLED_BY_DEFAULT", () => {
    const result = resolveEnableState("device-pair", "bundled", defaultConfig);
    expect(result.enabled).toBe(true);
  });

  it("denies bundled plugins not in BUNDLED_ENABLED_BY_DEFAULT", () => {
    const result = resolveEnableState("some-bundled", "bundled", defaultConfig);
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("bundled (disabled by default)");
  });

  it("allows non-bundled plugins when explicitly in allowlist", () => {
    const config = normalizePluginsConfig({ allow: ["my-plugin"] });
    const result = resolveEnableState("my-plugin", "workspace", config);
    expect(result.enabled).toBe(true);
  });

  it("allows non-bundled plugins when entry.enabled=true", () => {
    const config = normalizePluginsConfig({
      entries: { "my-plugin": { enabled: true } },
    });
    const result = resolveEnableState("my-plugin", "workspace", config);
    expect(result.enabled).toBe(true);
  });

  it("denies plugins on the denylist", () => {
    const config = normalizePluginsConfig({ deny: ["bad-plugin"] });
    const result = resolveEnableState("bad-plugin", "workspace", config);
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("blocked by denylist");
  });

  it("denies all plugins when plugins are disabled globally", () => {
    const config = normalizePluginsConfig({ enabled: false });
    const result = resolveEnableState("any-plugin", "bundled", config);
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("plugins disabled");
  });
});
