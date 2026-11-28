import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import {
  createChannelPairingChallengeIssuer,
  createChannelPairingController,
} from "./channel-pairing.js";
import { createPluginRuntimeMock } from "./test-helpers/plugin-runtime-mock.js";

function challenge(senderId: string, sendPairingReply = vi.fn(async (_text: string) => {})) {
  return { senderId, senderIdLine: `Your id: ${senderId}`, sendPairingReply };
}

function controller(code = "123456") {
  const store = {
    readAllowFromStore: vi.fn(async () => ["alice"]),
    removeAllowFromStoreEntry: vi.fn(async () => ({ changed: true, allowFrom: [] })),
    upsertPairingRequest: vi.fn(async () => ({ code, created: true })),
  };
  const core = createPluginRuntimeMock({ channel: { pairing: store } });
  return {
    ...store,
    pairing: createChannelPairingController({ core, channel: "googlechat", accountId: "Primary" }),
  };
}

function hook() {
  const handler = vi.fn(async () => {});
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "channel_pairing_requested", handler }]),
  );
  return handler;
}

function expectHook(
  handler: ReturnType<typeof hook>,
  channel: string,
  accountId: string,
  senderId: string,
  code?: string,
) {
  const scope = { accountId, senderId };
  expect(handler).toHaveBeenCalledWith(
    expect.objectContaining({ channel, ...scope, ...(code ? { code } : {}) }),
    expect.objectContaining({ channelId: channel, ...scope }),
  );
}

afterEach(() => {
  resetGlobalHookRunner();
});

describe("createChannelPairingController", () => {
  it("scopes store access and issues pairing challenges through the scoped store", async () => {
    const { pairing, readAllowFromStore, removeAllowFromStoreEntry, upsertPairingRequest } =
      controller();
    const input = challenge("user-1");

    await expect(pairing.readAllowFromStore()).resolves.toEqual(["alice"]);
    await expect(pairing.removeAllowFromStoreEntry("alice")).resolves.toEqual({
      changed: true,
      allowFrom: [],
    });
    await pairing.issueChallenge(input);

    expect(readAllowFromStore).toHaveBeenCalledWith({
      channel: "googlechat",
      accountId: "primary",
    });
    expect(removeAllowFromStoreEntry).toHaveBeenCalledWith({
      channel: "googlechat",
      accountId: "primary",
      entry: "alice",
    });
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "googlechat",
      accountId: "primary",
      id: "user-1",
      meta: undefined,
    });
    expect(input.sendPairingReply).toHaveBeenCalledTimes(1);
    expect(input.sendPairingReply.mock.calls[0]?.[0]).toContain("123456");
  });

  it("passes the scoped account id to channel_pairing_requested hooks", async () => {
    const handler = hook();
    const { pairing } = controller("ACCT1234");
    await pairing.issueChallenge(challenge("user-1"));

    expectHook(handler, "googlechat", "primary", "user-1", "ACCT1234");
  });
});

describe("createChannelPairingChallengeIssuer", () => {
  it("binds a channel and scoped pairing store to challenge issuance", async () => {
    const upsertPairingRequest = vi.fn(async () => ({ code: "654321", created: true }));
    const input = challenge("user-2");
    const issueChallenge = createChannelPairingChallengeIssuer({
      channel: "quietchat",
      upsertPairingRequest,
    });

    await issueChallenge(input);

    expect(upsertPairingRequest).toHaveBeenCalledWith({
      id: "user-2",
      meta: undefined,
    });
    expect(input.sendPairingReply.mock.calls[0]?.[0]).toContain("654321");
  });

  it("keeps normalized bound scope in hooks despite conflicting challenge fields", async () => {
    const handler = hook();
    const issueChallenge = createChannelPairingChallengeIssuer({
      channel: "quietchat",
      accountId: "Alerts",
      upsertPairingRequest: vi.fn(async () => ({ code: "NORM1234", created: true })),
    });

    const input = {
      ...challenge("user-3"),
      channel: "other",
      accountId: "other-account",
    };
    await issueChallenge(input);

    expectHook(handler, "quietchat", "alerts", "user-3");
  });
});
