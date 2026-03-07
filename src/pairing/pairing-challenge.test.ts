import { describe, expect, it, vi } from "vitest";
import { issuePairingChallenge } from "./pairing-challenge.js";

describe("issuePairingChallenge", () => {
  it("skips sending a reply in silent mode", async () => {
    const sendPairingReply = vi.fn(async (_text: string) => {});

    const result = await issuePairingChallenge({
      channel: "discord",
      senderId: "123",
      senderIdLine: "Your Discord user id: 123",
      responseMode: "silent",
      upsertPairingRequest: async () => ({ code: "PAIR123", created: true }),
      sendPairingReply,
    });

    expect(result).toEqual({ created: true, code: "PAIR123" });
    expect(sendPairingReply).not.toHaveBeenCalled();
  });
});
