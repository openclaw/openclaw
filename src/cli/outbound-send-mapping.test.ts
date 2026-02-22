import { describe, expect, it, vi } from "vitest";
import {
  createOutboundSendDepsFromCliSource,
  type CliOutboundSendSource,
} from "./outbound-send-mapping.js";

describe("createOutboundSendDepsFromCliSource", () => {
  it("maps CLI send deps to outbound send deps", () => {
    const deps: CliOutboundSendSource = {
      sendMessageWhatsApp: vi.fn() as CliOutboundSendSource["sendMessageWhatsApp"],
      sendMessageTelegram: vi.fn() as CliOutboundSendSource["sendMessageTelegram"],
      sendMessageDiscord: vi.fn() as CliOutboundSendSource["sendMessageDiscord"],
      sendMessageSlack: vi.fn() as CliOutboundSendSource["sendMessageSlack"],
      sendMessageSignal: vi.fn() as CliOutboundSendSource["sendMessageSignal"],
      sendMessageIMessage: vi.fn() as CliOutboundSendSource["sendMessageIMessage"],
    };

    const outbound = createOutboundSendDepsFromCliSource(deps);

    expect(outbound).toEqual({
      sendWhatsApp: deps.sendMessageWhatsApp,
      sendTelegram: deps.sendMessageTelegram,
      sendDiscord: deps.sendMessageDiscord,
      sendSlack: deps.sendMessageSlack,
      sendSignal: deps.sendMessageSignal,
      sendIMessage: deps.sendMessageIMessage,
    });
  });
});
