/** Tests plugin node-host command registry loading, listing, and invocation. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  invokeRegisteredNodeHostCommand,
  listRegisteredNodeHostCapsAndCommands,
  resolvePluginNodeHostCommandError,
} from "./plugin-node-host.js";

const availabilityContext = { config: {}, env: {} };

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("plugin node-host registry", () => {
  it("lists plugin-declared caps and commands", () => {
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "browser",
        pluginName: "Browser",
        command: {
          command: "browser.proxy",
          cap: "browser",
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
      {
        pluginId: "photos",
        pluginName: "Photos",
        command: {
          command: "photos.proxy",
          cap: "photos",
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
      {
        pluginId: "browser-dup",
        pluginName: "Browser Dup",
        command: {
          command: "browser.inspect",
          cap: "browser",
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(listRegisteredNodeHostCapsAndCommands(availabilityContext)).toEqual({
      caps: ["browser", "photos"],
      commands: ["browser.inspect", "browser.proxy", "photos.proxy"],
      nodePluginTools: [],
    });
  });

  it("lists plugin-declared agent tool descriptors", () => {
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "browser",
        pluginName: "Browser",
        command: {
          command: "browser.proxy",
          cap: "browser",
          agentTool: {
            name: "browser_inspect",
            description: "Inspect browser state",
            parameters: {
              type: "object",
              properties: { url: { type: "string" } },
            },
          },
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(listRegisteredNodeHostCapsAndCommands(availabilityContext).nodePluginTools).toEqual([
      {
        pluginId: "browser",
        name: "browser_inspect",
        description: "Inspect browser state",
        parameters: {
          type: "object",
          properties: { url: { type: "string" } },
        },
        command: "browser.proxy",
      },
    ]);
  });

  it("skips agent tool descriptors with provider-unsafe names", () => {
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "browser",
        pluginName: "Browser",
        command: {
          command: "browser.proxy",
          cap: "browser",
          agentTool: {
            name: "browser.inspect",
            description: "Inspect browser state",
          },
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(listRegisteredNodeHostCapsAndCommands(availabilityContext)).toEqual({
      caps: ["browser"],
      commands: ["browser.proxy"],
      nodePluginTools: [],
    });
  });

  it("omits commands and capabilities unavailable in the node-local config", () => {
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "browser",
        pluginName: "Browser",
        command: {
          command: "browser.proxy",
          cap: "browser",
          isAvailable: ({ config }) => config.browser?.enabled !== false,
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
      {
        pluginId: "photos",
        pluginName: "Photos",
        command: {
          command: "photos.proxy",
          cap: "photos",
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(
      listRegisteredNodeHostCapsAndCommands({
        config: { browser: { enabled: false } },
        env: {},
      }),
    ).toEqual({
      caps: ["photos"],
      commands: ["photos.proxy"],
      nodePluginTools: [],
    });
  });

  it("dispatches plugin-declared node-host commands", async () => {
    const handle = vi.fn(async (paramsJSON?: string | null) => paramsJSON ?? "");
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "browser",
        pluginName: "Browser",
        command: {
          command: "browser.proxy",
          cap: "browser",
          handle,
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    await expect(invokeRegisteredNodeHostCommand("browser.proxy", '{"ok":true}')).resolves.toBe(
      '{"ok":true}',
    );
    await expect(invokeRegisteredNodeHostCommand("missing.command", null)).resolves.toBeNull();
    expect(handle).toHaveBeenCalledWith('{"ok":true}');
  });

  it("gates duplex commands from embedded-worker manifests and supplies their IO context", async () => {
    const handle = vi.fn(async (paramsJSON?: string | null) => paramsJSON ?? "");
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "terminal",
        pluginName: "Terminal",
        command: {
          command: "terminal.resume.v1",
          cap: "terminal",
          duplex: true,
          handle,
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(
      listRegisteredNodeHostCapsAndCommands(availabilityContext, { includeDuplex: false }),
    ).toEqual({ caps: [], commands: [], nodePluginTools: [] });
    const io = {
      signal: new AbortController().signal,
      emitChunk: async () => {},
      onInput: () => {},
    };
    await expect(
      invokeRegisteredNodeHostCommand("terminal.resume.v1", '{"threadId":"id"}', io),
    ).resolves.toBe('{"threadId":"id"}');
    expect(handle).toHaveBeenCalledWith('{"threadId":"id"}', io);
    await expect(invokeRegisteredNodeHostCommand("terminal.resume.v1", null)).rejects.toThrow(
      "requires duplex transport",
    );
  });

  it("preserves explicit command error codes and contains unknown failures", () => {
    expect(resolvePluginNodeHostCommandError(new Error("CAMERA_UNAVAILABLE: no camera"))).toEqual({
      code: "CAMERA_UNAVAILABLE",
      message: "CAMERA_UNAVAILABLE: no camera",
    });
    expect(resolvePluginNodeHostCommandError(new Error("boom"))).toEqual({
      code: "INVALID_REQUEST",
      message: "Error: boom",
    });
  });
});
