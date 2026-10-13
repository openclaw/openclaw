import { beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  setChannelConversationBindingIdleTimeoutBySessionKeyAsync,
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

it("awaits committed idle updates", async () => {
  const gate = createDeferredCore<Array<{ boundAt: number; lastActivityAt: number }>>();
  fixture.adapter = {
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
  const records = [{ boundAt: 1, lastActivityAt: 2 }];
  gate.resolve(records);
  expect(await pending).toEqual(records);
});

it("propagates max-age update errors", async () => {
  const gate = createDeferredCore<Array<{ boundAt: number; lastActivityAt: number }>>();
  fixture.adapter = {
    setMaxAgeBySessionKeyAsync: () => gate.promise,
  };
  const params = { channelId: "test", targetSessionKey: "agent:test:binding", maxAgeMs: 500 };
  const pending = setChannelConversationBindingMaxAgeBySessionKeyAsync(params);
  const rejected = expect(pending).rejects.toThrow("write failed");
  gate.reject(new Error("write failed"));
  await rejected;
});

it("treats missing support as a no-op", async () => {
  expect(await setChannelConversationBindingIdleTimeoutBySessionKeyAsync(idleParams)).toEqual([]);
  expect(
    await setChannelConversationBindingMaxAgeBySessionKeyAsync({
      channelId: "test",
      targetSessionKey: "agent:test:binding",
      maxAgeMs: 500,
    }),
  ).toEqual([]);
});
