import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginNodeHostCommandRegistration } from "../plugins/registry-types.js";
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
type Command = PluginNodeHostCommandRegistration["command"];
function registerCommands(...commands: Command[]) {
  const registry = createEmptyPluginRegistry();
  registry.nodeHostCommands = commands.map((command) => ({
    pluginId: command.command.split(".")[0]!,
    source: "test",
    command,
  }));
  setActivePluginRegistry(registry);
  return registry;
}
afterEach(resetPluginRuntimeStateForTest);

describe("plugin node-host registry", () => {
  it.each([undefined, "optional", true] as const)(
    "advertises and dispatches commands with duplex=%s",
    async (duplex) => {
      const handle = vi.fn<Command["handle"]>(async (paramsJSON) => {
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
        return paramsJSON ?? "";
      });
      const registry = registerCommands({ command: "file.fetch", cap: "file", duplex, handle });
      expect(listRegisteredNodeHostCapsAndCommands(availabilityContext)).toEqual({
        caps: ["file"],
        commands: ["file.fetch"],
        nodePluginTools: [],
      });
      expect(isRegisteredNodeHostCommandDuplex("file.fetch")).toBe(duplex !== undefined);
      const payload = '{"ok":true}';
      if (duplex === undefined) {
        const context = {
          sendNodeEvent: vi.fn(async () => undefined),
          sessionKey: "agent:main:canvas",
        };
        await expect(
          invokeRegisteredNodeHostCommand("file.fetch", payload, undefined, context),
        ).resolves.toBe(payload);
        expect(handle).toHaveBeenCalledWith(payload, undefined, {
          ...context,
          prepareExecAuthorization: expect.any(Function),
        });
        await expect(invokeRegisteredNodeHostCommand("missing.command", null)).resolves.toBeNull();
      } else {
        if (duplex === "optional") {
          await expect(invokeRegisteredNodeHostCommand("file.fetch", payload)).resolves.toBe(
            payload,
          );
          expect(handle).toHaveBeenLastCalledWith(payload, undefined);
        } else {
          await expect(invokeRegisteredNodeHostCommand("file.fetch", null)).rejects.toThrow(
            "requires duplex transport",
          );
        }
        const io = {
          signal: new AbortController().signal,
          emitChunk: async () => {},
          onInput: () => {},
        };
        await expect(invokeRegisteredNodeHostCommand("file.fetch", payload, io)).resolves.toBe(
          payload,
        );
        expect(handle).toHaveBeenLastCalledWith(payload, io);
      }
    },
  );

  it.each([true, false])(
    "publishes available capabilities and validated descriptors (browser=%s)",
    (enabled) => {
      const browser = {
        cap: "browser",
        handle: async () => "{}",
        isAvailable: ({ config }: Parameters<NonNullable<Command["isAvailable"]>>[0]) =>
          config.browser?.enabled !== false,
      };
      registerCommands(
        {
          ...browser,
          command: "browser.proxy",
          agentTool: {
            name: "browser_inspect",
            description: "Inspect browser state",
            parameters: { type: "object", properties: { url: { type: "string" } } },
          },
        },
        {
          ...browser,
          command: "browser.inspect",
          agentTool: { name: "browser.inspect", description: "Inspect browser state" },
        },
        { command: "photos.proxy", cap: "photos", handle: async () => "{}" },
        {
          command: "computer.act",
          cap: "computer",
          handle: async () => "{}",
          computerUse: () => ({
            contractVersion: 2,
            provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
            actions: ["screenshot", "left_click"],
            targets: ["screen"],
            deliveryModes: ["foreground"],
            observations: ["image"],
            features: { recording: false, agentCursor: false, multiDisplay: false },
          }),
        },
      );
      const listed = listRegisteredNodeHostCapsAndCommands({
        config: { browser: { enabled } },
        env: {},
      });
      expect(listed.caps).toEqual(
        enabled ? ["browser", "computer", "photos"] : ["computer", "photos"],
      );
      expect(listed.commands).toEqual(
        enabled
          ? ["browser.inspect", "browser.proxy", "computer.act", "photos.proxy"]
          : ["computer.act", "photos.proxy"],
      );
      expect(listed.nodePluginTools).toEqual(
        enabled
          ? [
              {
                pluginId: "browser",
                name: "browser_inspect",
                description: "Inspect browser state",
                command: "browser.proxy",
                parameters: { type: "object", properties: { url: { type: "string" } } },
              },
            ]
          : [],
      );
      expect(listed.computerUse).toMatchObject({
        contractVersion: 2,
        provider: { id: "fixture", generation: "generation-1" },
        actions: ["screenshot", "left_click"],
      });
    },
  );

  it("scopes watcher callbacks, shares reentrant cleanup, and fences late notifications", async () => {
    const retiring = createDeferred();
    const entered = createDeferred();
    const onChange = vi.fn();
    const scopedRegistry = vi.fn();
    let notify: (() => void) | undefined;
    let reentrant: unknown;
    const cleanup = vi.fn(() => {
      scopedRegistry(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
      entered.resolve();
      // Do not await the completion whose cleanup is currently executing.
      if (cleanup.mock.calls.length === 1) {
        reentrant = stop();
      }
      return retiring.promise;
    });
    const registry = registerCommands({
      command: "fixture.observe",
      handle: async () => "{}",
      watchAvailability: (_context, callback) => {
        scopedRegistry(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
        notify = callback;
        return cleanup;
      },
    });
    const stop = watchRegisteredNodeHostCommandAvailability(availabilityContext, () => {
      scopedRegistry(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
      onChange();
    });
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
      expect(scopedRegistry).toHaveBeenCalledTimes(3);
      for (let call = 1; call <= 3; call++) {
        expect(scopedRegistry).toHaveBeenNthCalledWith(call, registry);
      }
    } finally {
      retiring.resolve();
      await Promise.allSettled([closing, reentrant]);
    }
  });

  it("retries failed watcher cleanup without replaying successful siblings", async () => {
    const failure = new Error("watcher retirement failed");
    const successful = vi.fn(async () => {});
    const retryable = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    registerCommands(
      ...[successful, retryable].map((cleanup, index) => ({
        command: `fixture.observe-${index}`,
        handle: async () => "{}",
        watchAvailability: () => cleanup,
      })),
    );
    const stop = watchRegisteredNodeHostCommandAvailability(availabilityContext, vi.fn());
    await expect(Promise.resolve(stop())).rejects.toBe(failure);
    await stop();
    expect(successful).toHaveBeenCalledOnce();
    expect(retryable).toHaveBeenCalledTimes(2);
  });

  it("retains unavailable plugin work until its shared disconnect owner cleans up once", async () => {
    let busy = false;
    let available = true;
    const onDisconnect = vi.fn(() => {
      busy = false;
    });
    const registry = registerCommands(
      ...["meeting.start", "meeting.observe"].map((command) => ({
        command,
        isAvailable: () => available,
        handle: async () => {
          busy = true;
          return "{}";
        },
        hasActiveWork: () => {
          expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
          return busy;
        },
        onDisconnect,
      })),
    );
    expect(hasRegisteredNodeHostCommandActiveWork()).toBe(false);
    await invokeRegisteredNodeHostCommand("meeting.start");
    available = false;
    expect(listRegisteredNodeHostCapsAndCommands(availabilityContext).commands).toEqual([]);
    expect(hasRegisteredNodeHostCommandActiveWork()).toBe(true);
    await notifyRegisteredNodeHostCommandDisconnect();
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(hasRegisteredNodeHostCommandActiveWork()).toBe(false);
  });
});
