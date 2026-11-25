import { afterEach, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { issuePairingChallenge } from "./pairing-challenge.js";

async function issue(
  code: string,
  overrides: Partial<Parameters<typeof issuePairingChallenge>[0]> = {},
  created = true,
) {
  const result = await issuePairingChallenge({
    channel: "forum",
    senderId: "123",
    senderIdLine: "Your forum user id: 123",
    upsertPairingRequest: async () => ({ code, created }),
    sendPairingReply: async () => {},
    ...overrides,
  });
  expect(result).toEqual(created ? { created: true, code } : { created: false });
}
function hooks(...entries: Parameters<typeof createMockPluginRegistry>[0]) {
  initializeGlobalHookRunner(createMockPluginRegistry(entries));
}

afterEach(resetGlobalHookRunner);

it("notifies and replies only when creating a request, preserving metadata and context", async () => {
  const handler = vi.fn(async () => {});
  hooks({ hookName: "channel_pairing_requested", handler });
  const meta = { name: "alice" };
  const sendPairingReply = vi.fn(async (_text: string) => {});
  const onCreated = vi.fn();
  const upsertPairingRequest = vi.fn(async () => ({ code: "1111", created: true }));
  const options = { accountId: "alerts", meta, onCreated, sendPairingReply };
  await issue("1111", {
    ...options,
    upsertPairingRequest,
    buildReplyText: ({ code }) => `custom ${code}`,
  });
  await issue("EXISTS12", options, false);
  expect(upsertPairingRequest).toHaveBeenCalledWith({ id: "123", meta });
  expect(onCreated).toHaveBeenCalledExactlyOnceWith({ code: "1111" });
  expect(sendPairingReply.mock.calls).toEqual([["custom 1111"]]);
  expect(handler).toHaveBeenCalledExactlyOnceWith(
    { channel: "forum", accountId: "alerts", senderId: "123", code: "1111", metadata: meta },
    { channelId: "forum", accountId: "alerts", senderId: "123" },
  );
});

it("captures reply errors through onReplyError", async () => {
  const error = new Error("send failed");
  const onReplyError = vi.fn();
  await issue("9999", {
    onReplyError,
    sendPairingReply: () => Promise.reject(error),
  });
  expect(onReplyError).toHaveBeenCalledExactlyOnceWith(error);
});

it("does not block pairing replies when pairing-request hooks fail or stall", async () => {
  const throwingHook = vi.fn(() => {
    throw new Error("notification failed");
  });
  const stallingHook = vi.fn(() => new Promise<void>(() => {}));
  hooks(
    { hookName: "channel_pairing_requested", handler: throwingHook, pluginId: "throwing" },
    { hookName: "channel_pairing_requested", handler: stallingHook, pluginId: "stalling" },
  );
  const sendPairingReply = vi.fn(async () => {});

  await issue("FAST1234", { sendPairingReply });
  expect(throwingHook).toHaveBeenCalledTimes(1);
  expect(stallingHook).toHaveBeenCalledTimes(1);
  expect(sendPairingReply).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("FAST1234"));
});
