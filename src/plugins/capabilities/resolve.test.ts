import { describe, expect, it } from "vitest";
import { createUnrestrictedCapabilities, resolveCapabilities } from "./resolve.js";
import type { PluginCapabilities } from "./types.js";

describe("resolveCapabilities", () => {
  describe("no capabilities declared", () => {
    it("grants full access when manifest is undefined", () => {
      const caps = resolveCapabilities(undefined);
      expect(caps.isUnrestricted).toBe(true);
      expect(caps.hasRegister("channel")).toBe(true);
      expect(caps.hasRegister("tool")).toBe(true);
      expect(caps.hasRuntime("system")).toBe(true);
      expect(caps.hasRuntime("agent")).toBe(true);
    });
  });

  describe("wildcard capabilities", () => {
    it("grants full register access with ['*']", () => {
      const caps = resolveCapabilities({ register: ["*"], runtime: ["*"] });
      expect(caps.isUnrestricted).toBe(true);
      expect(caps.hasRegister("provider")).toBe(true);
      expect(caps.hasRegister("hook")).toBe(true);
    });

    it("grants full runtime access with ['*']", () => {
      const caps = resolveCapabilities({ register: ["*"], runtime: ["*"] });
      expect(caps.hasRuntime("config.read")).toBe(true);
      expect(caps.hasRuntime("media")).toBe(true);
    });
  });

  describe("explicit capabilities", () => {
    it("allows only declared register capabilities", () => {
      const manifest: PluginCapabilities = {
        register: ["channel", "hook", "cli"],
        runtime: ["config.read", "logging"],
      };
      const caps = resolveCapabilities(manifest);

      expect(caps.isUnrestricted).toBe(false);
      expect(caps.hasRegister("channel")).toBe(true);
      expect(caps.hasRegister("hook")).toBe(true);
      expect(caps.hasRegister("cli")).toBe(true);
      expect(caps.hasRegister("provider")).toBe(false);
      expect(caps.hasRegister("tool")).toBe(false);
    });

    it("allows only declared runtime capabilities", () => {
      const manifest: PluginCapabilities = {
        register: ["provider"],
        runtime: ["config.read", "modelAuth", "logging"],
      };
      const caps = resolveCapabilities(manifest);

      expect(caps.hasRuntime("config.read")).toBe(true);
      expect(caps.hasRuntime("modelAuth")).toBe(true);
      expect(caps.hasRuntime("logging")).toBe(true);
      expect(caps.hasRuntime("system")).toBe(false);
      expect(caps.hasRuntime("agent")).toBe(false);
    });
  });

  describe("invalid capabilities filtered", () => {
    it("ignores unknown register capabilities", () => {
      const manifest: PluginCapabilities = {
        register: ["channel", "nonexistent" as never],
        runtime: ["logging"],
      };
      const caps = resolveCapabilities(manifest);

      expect(caps.hasRegister("channel")).toBe(true);
      expect(caps.registerCaps.has("nonexistent")).toBe(false);
    });

    it("ignores empty strings", () => {
      const manifest: PluginCapabilities = {
        register: ["" as never, "tool"],
        runtime: ["" as never, "logging"],
      };
      const caps = resolveCapabilities(manifest);

      expect(caps.hasRegister("tool")).toBe(true);
      expect(caps.registerCaps.size).toBe(1);
    });
  });

  describe("overrides replace manifest", () => {
    it("overrides fully replace manifest capabilities", () => {
      const manifest: PluginCapabilities = {
        register: ["channel", "hook", "cli"],
        runtime: ["config.read", "logging", "agent"],
      };
      const overrides: PluginCapabilities = {
        register: ["provider"],
        runtime: ["modelAuth"],
      };
      const caps = resolveCapabilities(manifest, overrides);

      expect(caps.hasRegister("provider")).toBe(true);
      expect(caps.hasRegister("channel")).toBe(false);
      expect(caps.hasRuntime("modelAuth")).toBe(true);
      expect(caps.hasRuntime("agent")).toBe(false);
    });

    it("overrides can grant full access via wildcard", () => {
      const manifest: PluginCapabilities = {
        register: ["provider"],
        runtime: ["logging"],
      };
      const overrides: PluginCapabilities = {
        register: ["*"],
        runtime: ["*"],
      };
      const caps = resolveCapabilities(manifest, overrides);
      expect(caps.isUnrestricted).toBe(true);
    });
  });

  describe("missing arrays default to wildcard", () => {
    it("missing register array grants full register access", () => {
      const manifest: PluginCapabilities = {
        runtime: ["logging"],
      };
      const caps = resolveCapabilities(manifest);
      expect(caps.hasRegister("tool")).toBe(true);
      expect(caps.hasRegister("channel")).toBe(true);
    });

    it("missing runtime array grants full runtime access", () => {
      const manifest: PluginCapabilities = {
        register: ["provider"],
      };
      const caps = resolveCapabilities(manifest);
      expect(caps.hasRuntime("system")).toBe(true);
      expect(caps.hasRuntime("agent")).toBe(true);
    });
  });
});

describe("createUnrestrictedCapabilities", () => {
  it("creates a full-access capability set", () => {
    const caps = createUnrestrictedCapabilities();
    expect(caps.isUnrestricted).toBe(true);
    expect(caps.hasRegister("channel")).toBe(true);
    expect(caps.hasRuntime("system")).toBe(true);
  });
});
