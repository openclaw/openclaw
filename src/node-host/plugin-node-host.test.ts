/** Tests plugin node-host command registry loading, listing, and invocation. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  hasRegisteredNodeHostCommandActiveWork,
  invokeRegisteredNodeHostCommand,
  isRegisteredNodeHostCommandDuplex,
  listRegisteredNodeHostCapsAndCommands,
  notifyRegisteredNodeHostCommandDisconnect,
  watchRegisteredNodeHostCommandAvailability,
} from "./plugin-node-host.js";

const availabilityContext = { config: {}, env: {} };

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("plugin node-host registry", () => {
  it("advertises optional duplex to unary nodes and forwards IO only when available", async () => {
    const handle = vi.fn(async () => "{}");
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands.push({
      pluginId: "files",
      source: "test",
      command: { command: "file.fetch", cap: "file", duplex: "optional", handle },
    });
    setActivePluginRegistry(registry);
    expect(
      listRegisteredNodeHostCapsAndCommands(availabilityContext, { includeDuplex: false }).commands,
    ).toEqual(["file.fetch"]);
    expect(isRegisteredNodeHostCommandDuplex("file.fetch")).toBe(true);
    await expect(invokeRegisteredNodeHostCommand("file.fetch", "{}")).resolves.toBe("{}");
    expect(handle).toHaveBeenLastCalledWith("{}", undefined);
    const io = {
      signal: new AbortController().signal,
      emitChunk: async () => {},
      onInput: () => {},
    };
    await invokeRegisteredNodeHostCommand("file.fetch", "{}", io);
    expect(handle).toHaveBeenLastCalledWith("{}", io);
  });

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

  it("publishes a validated Computer Use descriptor beside its command pair", () => {
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "computer",
        pluginName: "Computer",
        command: {
          command: "computer.act",
          cap: "computer",
          computerUse: () => ({
            contractVersion: 2,
            provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
            actions: ["screenshot", "left_click"],
            targets: ["screen"],
            deliveryModes: ["foreground"],
            observations: ["image"],
            features: { recording: false, agentCursor: false, multiDisplay: false },
          }),
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    expect(listRegisteredNodeHostCapsAndCommands(availabilityContext)).toMatchObject({
      caps: ["computer"],
      commands: ["computer.act"],
      computerUse: {
        contractVersion: 2,
        provider: { id: "fixture", generation: "generation-1" },
        actions: ["screenshot", "left_click"],
      },
    });
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

  it("owns plugin availability watcher cleanup", async () => {
    let notify: (() => void) | undefined;
    const cleanup = vi.fn();
    const onChange = vi.fn();
    const scopedRegistry = vi.fn();
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "browser",
        pluginName: "Browser",
        command: {
          command: "browser.proxy",
          cap: "browser",
          watchAvailability: (_context, callback) => {
            notify = callback;
            scopedRegistry(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
            return () => {
              scopedRegistry(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
              cleanup();
            };
          },
          handle: vi.fn(async () => "{}"),
        },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);

    const stop = watchRegisteredNodeHostCommandAvailability(availabilityContext, () => {
      scopedRegistry(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
      onChange();
    });
    notify?.();
    expect(onChange).toHaveBeenCalledOnce();
    await stop();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(scopedRegistry).toHaveBeenCalledTimes(3);
    expect(scopedRegistry).toHaveBeenNthCalledWith(1, registry);
    expect(scopedRegistry).toHaveBeenNthCalledWith(2, registry);
    expect(scopedRegistry).toHaveBeenNthCalledWith(3, registry);
  });

  it("shares watcher stop with reentrant cleanup and fences late notifications", async () => {
    const registry = createEmptyPluginRegistry();
    const retiring = createDeferred();
    const entered = createDeferred();
    const onChange = vi.fn();
    let notify: (() => void) | undefined;
    let reentrant: unknown;
    const cleanup = vi.fn(() => {
      entered.resolve();
      // Do not await the completion whose cleanup is currently executing.
      if (cleanup.mock.calls.length === 1) {
        reentrant = stop();
      }
      return retiring.promise;
    });
    registry.nodeHostCommands.push({
      pluginId: "fixture",
      source: "test",
      command: {
        command: "fixture.observe",
        handle: async () => "{}",
        watchAvailability: (_context, callback) => {
          notify = callback;
          return cleanup;
        },
      },
    });
    setActivePluginRegistry(registry);
    const stop = watchRegisteredNodeHostCommandAvailability(availabilityContext, onChange);
    notify?.();
    const closing = stop();
    try {
      notify?.();
      await entered.promise;
      expect(reentrant).toBeInstanceOf(Promise);
      expect(reentrant).toBe(closing);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(onChange).toHaveBeenCalledOnce();
      retiring.resolve();
      await closing;
    } finally {
      retiring.resolve();
      await Promise.allSettled([closing, reentrant]);
    }
  });

  it("retries failed watcher cleanup without replaying successful siblings", async () => {
    const registry = createEmptyPluginRegistry();
    const failure = new Error("watcher retirement failed");
    const successful = vi.fn(async () => {});
    const retryable = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    for (const [index, cleanup] of [successful, retryable].entries()) {
      registry.nodeHostCommands.push({
        pluginId: `fixture-${index}`,
        source: "test",
        command: {
          command: `fixture.observe-${index}`,
          handle: async () => "{}",
          watchAvailability: () => cleanup,
        },
      });
    }
    setActivePluginRegistry(registry);
    const stop = watchRegisteredNodeHostCommandAvailability(availabilityContext, vi.fn());
    await expect(Promise.resolve(stop())).rejects.toBe(failure);
    await stop();
    expect(successful).toHaveBeenCalledOnce();
    expect(retryable).toHaveBeenCalledTimes(2);
  });

  it("notifies each shared plugin disconnect owner once", async () => {
    const onDisconnect = vi.fn(async () => {});
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = ["screen.snapshot", "computer.act"].map((command) => ({
      pluginId: "computer",
      pluginName: "Computer",
      command: { command, onDisconnect, handle: vi.fn(async () => "{}") },
      source: "test",
    }));
    setActivePluginRegistry(registry);

    await notifyRegisteredNodeHostCommandDisconnect();

    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("retains plugin work after invocation and availability end until its owner cleans up", async () => {
    let busy = false;
    let available = true;
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "meeting",
        pluginName: "Meeting",
        source: "test",
        command: {
          command: "meeting.start",
          isAvailable: () => available,
          handle: async () => {
            busy = true;
            return "{}";
          },
          hasActiveWork: () => {
            expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
            return busy;
          },
          onDisconnect: () => {
            busy = false;
          },
        },
      },
    ];
    setActivePluginRegistry(registry);

    expect(hasRegisteredNodeHostCommandActiveWork()).toBe(false);
    await invokeRegisteredNodeHostCommand("meeting.start");
    available = false;
    expect(listRegisteredNodeHostCapsAndCommands(availabilityContext).commands).toEqual([]);
    expect(hasRegisteredNodeHostCommandActiveWork()).toBe(true);
    await notifyRegisteredNodeHostCommandDisconnect();
    expect(hasRegisteredNodeHostCommandActiveWork()).toBe(false);
  });

  it("keeps uncertain plugin work busy when its owner query throws", () => {
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "meeting",
        pluginName: "Meeting",
        source: "test",
        command: {
          command: "meeting.start",
          handle: async () => "{}",
          hasActiveWork: () => {
            throw new Error("work state unavailable");
          },
        },
      },
    ];
    setActivePluginRegistry(registry);

    expect(hasRegisteredNodeHostCommandActiveWork()).toBe(true);
  });

  it("dispatches plugin-declared node-host commands", async () => {
    const handle = vi.fn(async (paramsJSON?: string | null) => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return paramsJSON ?? "";
    });
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

    const context = {
      sendNodeEvent: vi.fn(async () => undefined),
      sessionKey: "agent:main:canvas",
    };
    await expect(
      invokeRegisteredNodeHostCommand("browser.proxy", '{"ok":true}', undefined, context),
    ).resolves.toBe('{"ok":true}');
    await expect(invokeRegisteredNodeHostCommand("missing.command", null)).resolves.toBeNull();
    expect(handle).toHaveBeenCalledWith('{"ok":true}', undefined, {
      ...context,
      prepareExecAuthorization: expect.any(Function),
    });
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
});
