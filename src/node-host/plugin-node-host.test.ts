import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginNodeHostCommandRegistration } from "../plugins/registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  hasRegisteredNodeHostCommandActiveWork as hasActiveWork,
  invokeRegisteredNodeHostCommand as invoke,
  isRegisteredNodeHostCommandDuplex as isDuplex,
  listRegisteredNodeHostCapsAndCommands as listCommands,
  notifyRegisteredNodeHostCommandDisconnect as disconnect,
  watchRegisteredNodeHostCommandAvailability as watchAvailability,
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
  registry.plugins = [...new Set(registry.nodeHostCommands.map(({ pluginId }) => pluginId))].map(
    (id) =>
      createPluginRecord({
        id,
        source: "test",
        origin: "bundled",
        enabled: true,
        configSchema: true,
      }),
  );
  setActivePluginRegistry(registry);
  return registry;
}
afterEach(resetPluginRuntimeStateForTest);

it.each([undefined, "optional", true] as const)(
  "advertises and dispatches commands with duplex=%s",
  async (duplex) => {
    const handle = vi.fn<Command["handle"]>(async (paramsJSON) => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return paramsJSON ?? "";
    });
    const registry = registerCommands({ command: "file.fetch", cap: "file", duplex, handle });
    expect(listCommands(availabilityContext)).toEqual({
      caps: ["file"],
      commands: ["file.fetch"],
      nodePluginTools: [],
    });
    expect(isDuplex("file.fetch")).toBe(duplex !== undefined);
    const payload = '{"ok":true}';
    if (duplex === undefined) {
      await expect(invoke("file.fetch", payload)).resolves.toBe(payload);
      await expect(invoke("missing.command", null)).resolves.toBeNull();
    } else {
      if (duplex === "optional") {
        await expect(invoke("file.fetch", payload)).resolves.toBe(payload);
        expect(handle).toHaveBeenLastCalledWith(payload, undefined);
      } else {
        await expect(invoke("file.fetch", null)).rejects.toThrow("requires duplex transport");
      }
      const io = {
        signal: new AbortController().signal,
        emitChunk: async () => {},
        onInput: () => {},
      };
      await expect(invoke("file.fetch", payload, io)).resolves.toBe(payload);
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
    const listed = listCommands({
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
    expect(listed.nodePluginTools).toHaveLength(Number(enabled));
    if (enabled) {
      expect(listed.nodePluginTools[0]).toEqual({
        pluginId: "browser",
        name: "browser_inspect",
        description: "Inspect browser state",
        command: "browser.proxy",
        parameters: { type: "object", properties: { url: { type: "string" } } },
      });
    }
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
  const stop = watchAvailability(availabilityContext, () => {
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
    expect(scopedRegistry.mock.calls).toEqual([[registry], [registry], [registry]]);
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
  const stop = watchAvailability(availabilityContext, vi.fn());
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
  expect(hasActiveWork()).toBe(false);
  await invoke("meeting.start");
  available = false;
  expect(listCommands(availabilityContext).commands).toEqual([]);
  expect(hasActiveWork()).toBe(true);
  await disconnect();
  expect(onDisconnect).toHaveBeenCalledOnce();
  expect(hasActiveWork()).toBe(false);
});
