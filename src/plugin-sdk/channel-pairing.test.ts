import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createChannelPairingController } from "./channel-pairing.js";

describe("createChannelPairingController", () => {
  it("scopes store access and issues pairing challenges through the scoped store", async () => {
    const readAllowFromStore = vi.fn(async () => ["alice"]);
    const upsertPairingRequest = vi.fn(async () => ({ code: "123456", created: true }));
    const replies: string[] = [];
    const sendPairingReply = vi.fn(async (text: string) => {
      replies.push(text);
    });
    const runtime = {
      channel: {
        pairing: {
          readAllowFromStore,
          upsertPairingRequest,
        },
      },
    } as unknown as PluginRuntime;

    const pairing = createChannelPairingController({
      core: runtime,
      channel: "googlechat",
      accountId: "Primary",
    });

    await expect(pairing.readAllowFromStore()).resolves.toEqual(["alice"]);
    await pairing.issueChallenge({
      senderId: "user-1",
      senderIdLine: "Your id: user-1",
      sendPairingReply,
    });

    expect(readAllowFromStore).toHaveBeenCalledWith({
      channel: "googlechat",
      accountId: "primary",
    });
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "googlechat",
      accountId: "primary",
      id: "user-1",
      meta: undefined,
    });
    expect(sendPairingReply).toHaveBeenCalledTimes(1);
    expect(replies[0]).toContain("123456");
  });
});
