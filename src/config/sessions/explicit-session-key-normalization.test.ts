import { describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { normalizeExplicitSessionKey } from "./explicit-session-key-normalization.js";

function makeCtx(overrides: Partial<MsgContext>): MsgContext {
  return {
    Body: "",
    From: "",
    To: "",
    ...overrides,
  } as MsgContext;
}

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

  it("migrates legacy :dm: to :direct: for all channels", () => {
    expect(
      normalizeExplicitSessionKey(
        "Agent:Fina:Slack:DM:ABC",
        makeCtx({
          Surface: "slack",
          From: "slack:U123",
        }),
      ),
    ).toBe("agent:fina:slack:direct:abc");
  });

  it("migrates whatsapp :dm: keys to :direct:", () => {
    expect(
      normalizeExplicitSessionKey(
        "agent:main:whatsapp:dm:+61419009073",
        makeCtx({
          Surface: "whatsapp",
          From: "+61419009073",
        }),
      ),
    ).toBe("agent:main:whatsapp:direct:+61419009073");
  });

  it("migrates telegram :dm: keys to :direct:", () => {
    expect(
      normalizeExplicitSessionKey(
        "telegram:dm:123456",
        makeCtx({
          Surface: "telegram",
          From: "telegram:123456",
        }),
      ),
    ).toBe("telegram:direct:123456");
  });

  it("preserves :thread: suffix during :dm: migration", () => {
    expect(
      normalizeExplicitSessionKey(
        "agent:main:slack:dm:C0123ABC:thread:1234567890.123",
        makeCtx({
          Surface: "slack",
          From: "slack:U123",
        }),
      ),
    ).toBe("agent:main:slack:direct:c0123abc:thread:1234567890.123");
  });
});
