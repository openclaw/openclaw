import { describe, expect, it } from "vitest";
import type { BridgeCommand } from "./types.js";
import { CommandBridgeRegistry } from "./registry.js";

describe("CommandBridgeRegistry", () => {
  it("should register and retrieve commands", () => {
    const registry = new CommandBridgeRegistry();
    const cmd: BridgeCommand<{ foo: string }> = {
      name: "test.cmd",
      description: "A test command",
      handler: async () => ({ success: true, data: "ok" }),
    };

    registry.register(cmd);
    expect(registry.get("test.cmd")).toBe(cmd);
    expect(registry.has("test.cmd")).toBe(true);
  });

  it("should throw on duplicate registration", () => {
    const registry = new CommandBridgeRegistry();
    const cmd: BridgeCommand = {
      name: "test.dup",
      description: "Duplicate",
      handler: async () => ({ success: true }),
    };

    registry.register(cmd);
    expect(() => registry.register(cmd)).toThrow(/already registered/);
  });

  it("should unregister commands", () => {
    const registry = new CommandBridgeRegistry();
    const cmd: BridgeCommand = {
      name: "test.rm",
      description: "Remove me",
      handler: async () => ({ success: true }),
    };

    registry.register(cmd);
    expect(registry.has("test.rm")).toBe(true);

    const removed = registry.unregister("test.rm");
    expect(removed).toBe(true);
    expect(registry.has("test.rm")).toBe(false);
    expect(registry.get("test.rm")).toBeUndefined();
  });

  it("should return all commands", () => {
    const registry = new CommandBridgeRegistry();
    registry.register({
      name: "a",
      description: "a",
      handler: async () => ({ success: true }),
    });
    registry.register({
      name: "b",
      description: "b",
      handler: async () => ({ success: true }),
    });

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.name).toSorted()).toEqual(["a", "b"]);
  });

  it("should clear all commands", () => {
    const registry = new CommandBridgeRegistry();
    registry.register({
      name: "a",
      description: "a",
      handler: async () => ({ success: true }),
    });
    registry.clear();
    expect(registry.getAll()).toHaveLength(0);
  });
});
