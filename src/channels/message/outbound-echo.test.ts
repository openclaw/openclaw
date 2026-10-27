import { beforeEach, describe, expect, it, vi } from "vitest";
import { outboundMessageIdentities } from "./outbound-echo-state.js";
import { isRecentOutboundMessageIdentity, recordOutboundMessageIdentity } from "./outbound-echo.js";

const identity = {
  channel: "discord",
  accountId: "default",
  conversationId: "thread-1",
  messageId: "message-1",
};
const message = (messageId: string) => ({ ...identity, accountId: undefined, messageId });

describe("outbound message identity registry", () => {
  beforeEach(() => {
    outboundMessageIdentities.clear();
    vi.restoreAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
  });

  it("scopes identities by channel and account", () => {
    recordOutboundMessageIdentity({
      ...identity,
      channel: "Discord",
      accountId: "Work",
    });

    expect(isRecentOutboundMessageIdentity({ ...identity, accountId: "work" })).toBe(true);
    expect(isRecentOutboundMessageIdentity({ ...identity, accountId: "other" })).toBe(false);
    expect(
      isRecentOutboundMessageIdentity({ ...identity, channel: "slack", accountId: "work" }),
    ).toBe(false);
    expect(
      isRecentOutboundMessageIdentity({
        ...identity,
        accountId: "work",
        conversationId: "thread-2",
      }),
    ).toBe(false);
  });

  it("expires identities after the bounded echo window", () => {
    let nowMs = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    recordOutboundMessageIdentity(identity);

    nowMs += 29_999;
    expect(isRecentOutboundMessageIdentity(identity)).toBe(true);
    nowMs += 1;
    expect(isRecentOutboundMessageIdentity(identity)).toBe(false);
  });

  it("does not retain identities when the expiry timestamp overflows", () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const overflow = { ...identity, accountId: undefined, messageId: "message-overflow" };
    recordOutboundMessageIdentity(overflow);

    expect(isRecentOutboundMessageIdentity(overflow)).toBe(false);
  });

  it("evicts the oldest identity when the registry reaches its entry bound", () => {
    for (let index = 0; index <= 10_000; index += 1) {
      recordOutboundMessageIdentity(message(`message-${index}`));
    }

    expect(outboundMessageIdentities.size).toBe(10_000);
    expect(isRecentOutboundMessageIdentity(message("message-0"))).toBe(false);
    expect(isRecentOutboundMessageIdentity(message("message-10000"))).toBe(true);
  });

  it("matches a transport-defined outbound source identity", () => {
    const source = { ...identity, messageId: undefined, sourceId: "webhook-1" };
    recordOutboundMessageIdentity(source);

    expect(isRecentOutboundMessageIdentity(source)).toBe(true);
  });
});
