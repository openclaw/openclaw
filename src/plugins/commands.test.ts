import { afterEach, describe, expect, it } from "vitest";
import {
  clearPluginCommands,
  getPluginCommandSpecs,
  listPluginCommands,
  registerPluginCommand,
} from "./commands.js";

afterEach(() => {
  clearPluginCommands();
});

describe("registerPluginCommand", () => {
  it("rejects malformed runtime command shapes", () => {
    const invalidName = registerPluginCommand(
      "demo-plugin",
      // Runtime plugin payloads are untyped; guard at boundary.
      {
        name: undefined as unknown as string,
        description: "Demo",
        handler: async () => ({ text: "ok" }),
      },
    );
    expect(invalidName).toEqual({
      ok: false,
      error: "Command name must be a string",
    });

    const invalidDescription = registerPluginCommand("demo-plugin", {
      name: "demo",
      description: undefined as unknown as string,
      handler: async () => ({ text: "ok" }),
    });
    expect(invalidDescription).toEqual({
      ok: false,
      error: "Command description must be a string",
    });
  });

  it("normalizes command metadata for downstream consumers", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "  demo_cmd  ",
      description: "  Demo command  ",
      handler: async () => ({ text: "ok" }),
    });
    expect(result).toEqual({ ok: true });
    expect(listPluginCommands()).toHaveLength(1);
    expect(listPluginCommands()[0]).toEqual(
      expect.objectContaining({
        name: "demo_cmd",
        description: "Demo command",
        pluginId: "demo-plugin",
      }),
    );
    expect(getPluginCommandSpecs()).toHaveLength(1);
    expect(getPluginCommandSpecs()[0]).toEqual(
      expect.objectContaining({
        name: "demo_cmd",
        description: "Demo command",
        acceptsArgs: false,
      }),
    );
  });
});
