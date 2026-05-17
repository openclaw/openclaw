import { describe, expect, it } from "vitest";
import { normalizeExplicitSessionKey } from "./explicit-session-key-normalization.js";
import { installDiscordSessionKeyNormalizerFixture, makeCtx } from "./session-key.test-helpers.js";

installDiscordSessionKeyNormalizerFixture();

describe("normalizeExplicitSessionKey", () => {
  it("dispatches discord keys through the provider normalizer", () => {
    expect(
      normalizeExplicitSessionKey(
        "agent:fina:discord:channel:123456",
        makeCtx({
          Surface: "discord",
          ChatType: "direct",
          From: "discord:123456",
          SenderId: "123456",
        }),
      ),
    ).toBe("agent:fina:discord:direct:123456");
  });

  it("infers the provider from From when explicit provider fields are absent", () => {
    expect(
      normalizeExplicitSessionKey(
        "discord:dm:123456",
        makeCtx({
          ChatType: "direct",
          From: "discord:123456",
          SenderId: "123456",
        }),
      ),
    ).toBe("discord:direct:123456");
  });

  it("uses Provider when Surface is absent", () => {
    expect(
      normalizeExplicitSessionKey(
        "agent:fina:discord:dm:123456",
        makeCtx({
          Provider: "Discord",
          ChatType: "direct",
          SenderId: "123456",
        }),
      ),
    ).toBe("agent:fina:discord:direct:123456");
  });

  it("lowercases unknown providers while preserving opaque Signal group IDs", () => {
    expect(
      normalizeExplicitSessionKey(
        "Agent:Fina:Slack:DM:ABC",
        makeCtx({
          Surface: "slack",
          From: "slack:U123",
        }),
      ),
    ).toBe("agent:fina:slack:dm:abc");
    const groupId = "VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=";
    expect(
      normalizeExplicitSessionKey(
        `Agent:Main:Signal:Group:${groupId}`,
        makeCtx({ Surface: "signal", ChatType: "group", From: `group:${groupId}` }),
      ),
    ).toBe(`agent:main:signal:group:${groupId}`);
  });
});
