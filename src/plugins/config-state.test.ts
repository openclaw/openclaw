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

  it("disables memory slot when set to 'none'", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "none" },
    });
    expect(result.slots.memory).toBeNull();
  });

  it("disables memory slot when set to 'None' (case insensitive)", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "None" },
    });
    expect(result.slots.memory).toBeNull();
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

  it("disables workspace plugins by default", () => {
    const result = normalizePluginsConfig({});
    expect(result.workspaceEnabled).toBe(false);
  });

  it("respects explicit workspace plugin enablement", () => {
    const result = normalizePluginsConfig({
      workspace: { enabled: true },
    });
    expect(result.workspaceEnabled).toBe(true);
  });
});

describe("resolveEnableState", () => {
  it("disables non-bundled plugins by default", () => {
    const config = normalizePluginsConfig({});
    expect(resolveEnableState("demo", "global", config)).toEqual({
      enabled: false,
      reason: "disabled by default (set plugins.entries.<id>.enabled=true)",
    });
  });

  it("blocks workspace plugins when workspace loading is disabled", () => {
    const config = normalizePluginsConfig({
      entries: {
        demo: { enabled: true },
      },
    });
    expect(resolveEnableState("demo", "workspace", config)).toEqual({
      enabled: false,
      reason: "workspace plugins disabled (set plugins.workspace.enabled=true)",
    });
  });

  it("allows workspace plugins when explicitly enabled", () => {
    const config = normalizePluginsConfig({
      workspace: { enabled: true },
      entries: {
        demo: { enabled: true },
      },
    });
    expect(resolveEnableState("demo", "workspace", config)).toEqual({
      enabled: true,
    });
  });
});
