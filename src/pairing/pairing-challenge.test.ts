import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { issuePairingChallenge } from "./pairing-challenge.js";

describe("issuePairingChallenge", () => {
  const base = {
    channel: "forum",
    senderId: "123",
    senderIdLine: "Your forum user id: 123",
  };

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("supports custom reply text builder", async () => {
    const sendPairingReply = vi.fn(async (_text: string) => {});
    const result = await issuePairingChallenge({
      ...base,
      upsertPairingRequest: async () => ({ code: "ZXCV", created: true }),
      buildReplyText: ({ code }) => `custom ${code}`,
      sendPairingReply,
    });
    expect(result).toEqual({ created: true, code: "ZXCV" });
    expect(sendPairingReply.mock.calls).toEqual([["custom ZXCV"]]);
  });

  it("does not send a reply when request already exists", async () => {
    const sendPairingReply = vi.fn(async () => {});
    const result = await issuePairingChallenge({
      ...base,
      upsertPairingRequest: async () => ({ code: "ABCD", created: false }),
      sendPairingReply,
    });
    expect(result).toEqual({ created: false });
    expect(sendPairingReply).not.toHaveBeenCalled();
  });

  it("calls onCreated and forwards meta to upsert", async () => {
    const onCreated = vi.fn();
    const upsertPairingRequest = vi.fn(async () => ({ code: "1111", created: true }));
    const result = await issuePairingChallenge({
      ...base,
      meta: { name: "alice" },
      upsertPairingRequest,
      onCreated,
      sendPairingReply: async () => {},
    });
    expect(result).toEqual({ created: true, code: "1111" });
    expect(upsertPairingRequest).toHaveBeenCalledWith({ id: "123", meta: { name: "alice" } });
    expect(onCreated).toHaveBeenCalledWith({ code: "1111" });
  });

  it("captures reply errors through onReplyError", async () => {
    const error = new Error("send failed");
    const onReplyError = vi.fn();
    const result = await issuePairingChallenge({
      ...base,
      upsertPairingRequest: async () => ({ code: "9999", created: true }),
      onReplyError,
      sendPairingReply: async () => {
        throw error;
      },
    });
    expect(result).toEqual({ created: true, code: "9999" });
    expect(onReplyError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("fires channel_pairing_requested only for newly created requests", async () => {
    const handler = vi.fn(async () => {});
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "channel_pairing_requested",
          handler,
        },
      ]),
    );

    await issuePairingChallenge({
      ...base,
      accountId: "alerts",
      meta: { username: "alice" },
      upsertPairingRequest: async () => ({ code: "HOOK1234", created: true }),
      sendPairingReply: async () => {},
    });
    await issuePairingChallenge({
      ...base,
      accountId: "alerts",
      upsertPairingRequest: async () => ({ code: "EXISTS12", created: false }),
      sendPairingReply: async () => {},
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      {
        channel: "forum",
        accountId: "alerts",
        senderId: "123",
        code: "HOOK1234",
        metadata: { username: "alice" },
      },
      {
        channelId: "forum",
        accountId: "alerts",
        senderId: "123",
      },
    );
  });

  it("does not block pairing replies when pairing-request hooks fail or stall", async () => {
    const throwingHook = vi.fn(() => {
      throw new Error("notification failed");
    });
    const stallingHook = vi.fn(() => new Promise<void>(() => {}));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "channel_pairing_requested",
          handler: throwingHook,
          pluginId: "throwing",
        },
        {
          hookName: "channel_pairing_requested",
          handler: stallingHook,
          pluginId: "stalling",
        },
      ]),
    );
    const sendPairingReply = vi.fn(async () => {});

    const result = await issuePairingChallenge({
      ...base,
      upsertPairingRequest: async () => ({ code: "FAST1234", created: true }),
      sendPairingReply,
    });

    expect(result).toEqual({ created: true, code: "FAST1234" });
    expect(throwingHook).toHaveBeenCalledTimes(1);
    expect(stallingHook).toHaveBeenCalledTimes(1);
    expect(sendPairingReply).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("FAST1234"));
  });
});
