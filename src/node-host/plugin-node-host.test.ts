import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginNodeHostCommandRegistration } from "../plugins/registry-types.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { registerCommands } from "./node-host-command.fixture.test-support.js";
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
afterEach(resetPluginRuntimeStateForTest);

it.each([undefined, "optional", true] as const)(
  "advertises and dispatches commands with duplex=%s",
  async (duplex) => {
    const handle = vi.fn<Command["handle"]>(async (paramsJSON) => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return paramsJSON ?? "";
    });
    const registry = registerCommands({ command: "file.fetch", cap: "file", duplex, handle });
    expect(isDuplex("file.fetch")).toBe(duplex !== undefined);
    const payload = '{"ok":true}';
    if (duplex === true) {
      await expect(invoke("file.fetch", null)).rejects.toThrow("requires duplex transport");
    } else {
      await expect(invoke("file.fetch", payload)).resolves.toBe(payload);
      await expect(invoke("missing.command", null)).resolves.toBeNull();
    }
    if (duplex !== undefined) {
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
      { command: "photos.proxy", cap: "photos" },
    );
    const listed = listCommands({ config: { browser: { enabled } }, env: {} });
    expect(listed.caps).toEqual(enabled ? ["browser", "photos"] : ["photos"]);
    expect(listed.commands).toEqual(
      enabled ? ["browser.inspect", "browser.proxy", "photos.proxy"] : ["photos.proxy"],
    );
    expect(listed.nodePluginTools).toHaveLength(Number(enabled));
    if (enabled) {
      expect(listed.nodePluginTools[0]).toMatchObject({
        pluginId: "browser",
        name: "browser_inspect",
        description: "Inspect browser state",
        command: "browser.proxy",
        parameters: { type: "object", properties: { url: { type: "string" } } },
      });
    }
  },
);

it("scopes watcher callbacks, fences late notifications, and retries only failed cleanup", async () => {
  const retiring = createDeferred();
  const entered = createDeferred();
  const failure = new Error("watcher retirement failed");
  const successful = vi.fn(async () => {});
  const onChange = vi.fn();
  const assertScope = () =>
    expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
  let notify: (() => void) | undefined;
  let reentrant: unknown;
  const cleanup = vi.fn(() => {
    assertScope();
    entered.resolve();
    // Do not await the completion whose cleanup is currently executing.
    if (cleanup.mock.calls.length === 1) {
      reentrant = stop();
      return retiring.promise;
    }
    return Promise.resolve();
  });
  const registry = registerCommands(
    { command: "fixture.idle", watchAvailability: () => successful },
    {
      command: "fixture.observe",
      watchAvailability: (_context, callback) => {
        assertScope();
        notify = callback;
        return cleanup;
      },
    },
  );
  const stop = watchAvailability(availabilityContext, () => {
    assertScope();
    onChange();
  });
  notify?.();
  const closing = stop();
  const rejected = expect(closing).rejects.toBe(failure);
  try {
    notify?.();
    await entered.promise;
    expect(reentrant).toBe(closing);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
    retiring.reject(failure);
    await rejected;
    await stop();
    expect(successful).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledTimes(2);
  } finally {
    retiring.resolve();
    await Promise.allSettled([closing, reentrant, rejected]);
  }
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
