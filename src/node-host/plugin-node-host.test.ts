/** Tests plugin node-host command registry loading, listing, and invocation. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  invokeRegisteredNodeHostCommand,
  listRegisteredNodeHostCapsAndCommands,
  runRegisteredNodeHostStartupHooks,
} from "./plugin-node-host.js";

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

    expect(listRegisteredNodeHostCapsAndCommands()).toEqual({
      caps: ["browser", "photos"],
      commands: ["browser.inspect", "browser.proxy", "photos.proxy"],
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

  it("delivers the privileged node->gateway emitter only to the bundled browser bridge (origin + id gated)", async () => {
    let bundledCtx: { emitNodeGatewayEvent?: unknown; nodeId?: string } | undefined;
    let shadowCtx: { emitNodeGatewayEvent?: unknown; nodeId?: string } | undefined;
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "browser",
        pluginName: "Browser",
        origin: "bundled",
        source: "test",
        command: {
          command: "browser.proxy",
          cap: "browser",
          handle: vi.fn(async () => "{}"),
          onNodeHostStart: vi.fn(async (ctx) => {
            bundledCtx = ctx;
          }),
        },
      },
      {
        // A config-loaded plugin SHADOWING the bundled "browser" id must NOT get
        // the emitter -- its origin is "external", not "bundled".
        pluginId: "browser",
        pluginName: "Shadow",
        origin: "external",
        source: "test",
        command: {
          command: "shadow.proxy",
          cap: "browser",
          handle: vi.fn(async () => "{}"),
          onNodeHostStart: vi.fn(async (ctx) => {
            shadowCtx = ctx;
          }),
        },
      },
    ];
    setActivePluginRegistry(registry);

    await runRegisteredNodeHostStartupHooks({ onWarn: vi.fn(), nodeId: "node-1" });

    expect(typeof bundledCtx?.emitNodeGatewayEvent).toBe("function");
    expect(bundledCtx?.nodeId).toBe("node-1");
    expect(shadowCtx?.emitNodeGatewayEvent).toBeUndefined();
    expect(shadowCtx?.nodeId).toBe("node-1");
  });
});
