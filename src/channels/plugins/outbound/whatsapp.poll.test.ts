import { describe, expect, it, vi } from "vitest";
import {
  createWhatsAppPollFixture,
  expectWhatsAppPollSent,
} from "../../../test-helpers/whatsapp-outbound.js";

const hoisted = vi.hoisted(() => ({
  sendPollWhatsApp: vi.fn(async () => ({ messageId: "poll-1", toJid: "1555@s.whatsapp.net" })),
}));

vi.mock("../../../globals.js", () => ({
  shouldLogVerbose: () => false,
}));

vi.mock("../../../web/outbound.js", () => ({
  sendPollWhatsApp: hoisted.sendPollWhatsApp,
}));

import { whatsappOutbound } from "./whatsapp.js";

describe("whatsappOutbound sendPoll", () => {
  it("threads cfg through poll send options", async () => {
    const { cfg, poll, to, accountId } = createWhatsAppPollFixture();

    const result = await whatsappOutbound.sendPoll!({
      cfg,
      to,
      poll,
      accountId,
    });

    expectWhatsAppPollSent(hoisted.sendPollWhatsApp, { cfg, poll, to, accountId });
    expect(result).toEqual({ messageId: "poll-1", toJid: "1555@s.whatsapp.net" });
  });
});
