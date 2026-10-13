import { describe, expect, it, vi } from "vitest";
import {
  buildChannelSourceTurnId,
  readChannelSourceTurnId,
  readChannelSourceTurnSameThreadRequired,
  resolveCausalInboundMessageId,
  setChannelSourceTurnId,
  setChannelSourceTurnSameThreadRequired,
  shouldMintChannelSourceTurnId,
} from "./source-turn-id.js";

describe("buildChannelSourceTurnId", () => {
  it("is stable for the same normalized channel route", () => {
    expect(
      buildChannelSourceTurnId({
        provider: "Telegram",
        accountId: "DEFAULT",
        conversationId: "chat:42",
        messageId: 7,
      }),
    ).toBe(
      buildChannelSourceTurnId({
        provider: "telegram",
        accountId: "default",
        conversationId: "chat:42",
        messageId: "7",
      }),
    );
  });

  it("scopes provider-local message ids by conversation and account", () => {
    const sourceTurnId = buildChannelSourceTurnId({
      provider: "telegram",
      accountId: "default",
      conversationId: "chat:42",
      messageId: "7",
    });
    expect(sourceTurnId).toMatch(/^channel-user:v1:[a-f0-9]{64}$/);
    expect(
      buildChannelSourceTurnId({
        provider: "telegram",
        accountId: "default",
        conversationId: "chat:43",
        messageId: "7",
      }),
    ).not.toBe(sourceTurnId);
    expect(
      buildChannelSourceTurnId({
        provider: "telegram",
        accountId: "ops",
        conversationId: "chat:42",
        messageId: "7",
      }),
    ).not.toBe(sourceTurnId);
  });

  it("fails closed without complete route scope", () => {
    expect(
      buildChannelSourceTurnId({ provider: "telegram", conversationId: "chat:42" }),
    ).toBeUndefined();
    expect(buildChannelSourceTurnId({ provider: "telegram", messageId: "7" })).toBeUndefined();
  });

  it("carries host-only identity through clones and runtime module boundaries without serializing it", async () => {
    const context = { MessageSid: "7" };
    setChannelSourceTurnId(context, "channel-user:v1:source-7");
    setChannelSourceTurnSameThreadRequired(context, true);

    expect(readChannelSourceTurnId({ ...context })).toBe("channel-user:v1:source-7");
    expect(readChannelSourceTurnSameThreadRequired({ ...context })).toBe(true);
    expect(JSON.stringify(context)).toBe('{"MessageSid":"7"}');
    vi.resetModules();
    const otherRuntime = await import("./source-turn-id.js");
    expect(otherRuntime.readChannelSourceTurnId({ ...context })).toBe("channel-user:v1:source-7");
    expect(otherRuntime.readChannelSourceTurnSameThreadRequired({ ...context })).toBe(true);
  });
  it("does not mint channel source-turn ids for internal-origin ingress", () => {
    // Gateway chat.send stamps the internal channel as the ingress provider and
    // keys the persisted user turn by run id; minting a channel id there would
    // trip the source-keyed admission guard (live regression via #108283).
    expect(shouldMintChannelSourceTurnId("webchat")).toBe(false);
    expect(shouldMintChannelSourceTurnId("telegram")).toBe(true);
    expect(shouldMintChannelSourceTurnId(undefined)).toBe(true);
  });
});

describe("resolveCausalInboundMessageId", () => {
  it("uses the admitted full id rather than reply routing aliases for one source", () => {
    expect(
      resolveCausalInboundMessageId({ MessageSid: "short", MessageSidFull: " full " }, {}),
    ).toBe("full");
    expect(
      resolveCausalInboundMessageId(
        {
          MessageSid: "one",
          MessageSids: ["one", "one"],
          MessageSidFirst: "one",
          MessageSidLast: "one",
        },
        {},
      ),
    ).toBe("one");
  });

  it.each([
    { MessageSids: ["first", "last"] },
    { MessageSidFirst: "first", MessageSidLast: "last" },
    { MessageSids: ["first"], MessageSidLast: "last" },
  ])("withholds a representative when batch members disagree: %j", (batch) => {
    expect(resolveCausalInboundMessageId({ MessageSid: "last", ...batch }, {})).toBeUndefined();
  });

  it.each([
    { isHeartbeat: true },
    { inputProvenance: { kind: "internal_system" as const } },
    { inputProvenance: { kind: "inter_session" as const } },
  ])("withholds stale ids for synthetic input: %j", (source) => {
    expect(resolveCausalInboundMessageId({ MessageSidFull: "stale" }, source)).toBeUndefined();
  });

  it("does not invent a causal id from a batch boundary without an admitted message id", () => {
    expect(
      resolveCausalInboundMessageId({ MessageSidFirst: "one", MessageSidLast: "one" }, {}),
    ).toBeUndefined();
  });
});
