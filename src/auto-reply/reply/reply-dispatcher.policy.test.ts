import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(async () => []),
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

const { createReplyDispatcher } = await import("./reply-dispatcher.js");

const redirectCfg = {
  session: {
    relayRouting: {
      targets: {
        ops: { channel: "slack", to: "channel:C-RELAY" },
      },
      rules: [
        {
          mode: "read-only",
          relayTo: "ops",
          match: { channel: "slack", chatId: "*" },
        },
      ],
    },
  },
} as OpenClawConfig;

const denyCfg = {
  session: {
    relayRouting: {
      rules: [
        {
          mode: "read-only",
          match: { channel: "slack", chatId: "*" },
        },
      ],
    },
  },
} as OpenClawConfig;

describe("createReplyDispatcher write-policy guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes destination info to closure delivery when policy allows", async () => {
    const deliver = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({
      cfg: {} as OpenClawConfig,
      destination: { channel: "slack", to: "channel:C1" },
      deliver,
    });

    dispatcher.sendFinalReply({ text: "hello" });
    await dispatcher.waitForIdle();

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ text: "hello" }),
      expect.objectContaining({
        kind: "final",
        destination: { channel: "slack", to: "channel:C1" },
      }),
    );
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("bypasses closure and relays through outbound delivery on redirect", async () => {
    const deliver = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({
      cfg: redirectCfg,
      destination: { channel: "slack", to: "channel:C1" },
      deliver,
    });

    dispatcher.sendFinalReply({ text: "hello" });
    await dispatcher.waitForIdle();

    expect(deliver).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        to: "channel:C-RELAY",
        payloads: [expect.objectContaining({ text: "hello" })],
      }),
    );
  });

  it("skips delivery entirely when policy denies", async () => {
    const deliver = vi.fn(async () => {});
    const dispatcher = createReplyDispatcher({
      cfg: denyCfg,
      destination: { channel: "slack", to: "channel:C1" },
      deliver,
    });

    dispatcher.sendFinalReply({ text: "hello" });
    await dispatcher.waitForIdle();

    expect(deliver).not.toHaveBeenCalled();
    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });
});
