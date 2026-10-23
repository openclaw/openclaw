import { beforeEach, expect, it, vi } from "vitest";
import { withPluginRuntimePluginScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  setChannelConversationBindingIdleTimeoutBySessionKey,
  setChannelConversationBindingIdleTimeoutBySessionKeyAsync,
  setChannelConversationBindingMaxAgeBySessionKey,
  setChannelConversationBindingMaxAgeBySessionKeyAsync,
} from "./conversation-bindings.js";
import type { ChannelConversationBindingSupport } from "./types.adapters.js";

const fixture = vi.hoisted(() => ({
  adapter: {} as ChannelConversationBindingSupport,
}));
vi.mock("./registry.js", () => ({
  getChannelPlugin: () => ({ conversationBindings: fixture.adapter }),
}));
beforeEach(() => {
  fixture.adapter = {};
});

const idleParams = {
  channelId: "test",
  targetSessionKey: "agent:test:binding",
  idleTimeoutMs: 200,
};

it("awaits async idle updates and keeps synchronous callers on their own implementation", async () => {
  const gate = createDeferredCore<Array<{ boundAt: number; lastActivityAt: number }>>();
  const legacy = vi.fn(() => []);
  fixture.adapter = {
    setIdleTimeoutBySessionKey: legacy,
    setIdleTimeoutBySessionKeyAsync: () => gate.promise,
  };
  let settled = false;
  const pending = setChannelConversationBindingIdleTimeoutBySessionKeyAsync(idleParams).then(
    (records) => {
      settled = true;
      return records;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(legacy).not.toHaveBeenCalled();
  const records = [{ boundAt: 1, lastActivityAt: 2 }];
  gate.resolve(records);
  expect(await pending).toEqual(records);
  expect(setChannelConversationBindingIdleTimeoutBySessionKey(idleParams)).toEqual([]);
  expect(legacy).toHaveBeenCalledTimes(1);
});

it("propagates async max-age errors without invoking the synchronous fallback", async () => {
  const gate = createDeferredCore<Array<{ boundAt: number; lastActivityAt: number }>>();
  const legacy = vi.fn(() => []);
  fixture.adapter = {
    setMaxAgeBySessionKey: legacy,
    setMaxAgeBySessionKeyAsync: () => gate.promise,
  };
  const params = { channelId: "test", targetSessionKey: "agent:test:binding", maxAgeMs: 500 };
  const pending = setChannelConversationBindingMaxAgeBySessionKeyAsync(params);
  const rejected = expect(pending).rejects.toThrow("write failed");
  gate.reject(new Error("write failed"));
  await rejected;
  expect(legacy).not.toHaveBeenCalled();
  expect(setChannelConversationBindingMaxAgeBySessionKey(params)).toEqual([]);
  expect(legacy).toHaveBeenCalledTimes(1);
});

it("retains legacy adapter results and missing-support no-ops during migration", async () => {
  using warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  expect(await setChannelConversationBindingIdleTimeoutBySessionKeyAsync(idleParams)).toEqual([]);
  expect(warning).not.toHaveBeenCalled();
  const records = [{ boundAt: 1, lastActivityAt: 2 }];
  fixture.adapter = { setIdleTimeoutBySessionKey: () => records };
  await withPluginRuntimePluginScope({ pluginId: "thread-binding-compat-proof" }, async () => {
    expect(await setChannelConversationBindingIdleTimeoutBySessionKeyAsync(idleParams)).toEqual(
      records,
    );
    await setChannelConversationBindingIdleTimeoutBySessionKeyAsync(idleParams);
  });
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining(
      "ChannelConversationBindingSupport.setIdleTimeoutBySessionKey is deprecated; use ChannelConversationBindingSupport.setIdleTimeoutBySessionKeyAsync",
    ),
    { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
  );
});
