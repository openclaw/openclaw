import { describe, expect, it } from "vitest";

import type { MsgContext } from "../templating.js";
import {
  buildInboundDedupeKey,
  resetInboundDedupe,
  shouldSkipDuplicateInbound,
} from "./inbound-dedupe.js";

describe("inbound dedupe", () => {
  it("builds a stable key when MessageSid is present", () => {
    const ctx: MsgContext = {
      Provider: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:123",
      MessageSid: "42",
    };
    expect(buildInboundDedupeKey(ctx)).toBe("telegram|telegram:123|42");
  });

  it("skips duplicates with the same key", () => {
    resetInboundDedupe();
    const ctx: MsgContext = {
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+1555",
      MessageSid: "msg-1",
    };
    expect(shouldSkipDuplicateInbound(ctx, { now: 100 })).toBe(false);
    expect(shouldSkipDuplicateInbound(ctx, { now: 200 })).toBe(true);
  });

  it("does not dedupe when the peer changes", () => {
    resetInboundDedupe();
    const base: MsgContext = {
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      MessageSid: "msg-1",
    };
    expect(
      shouldSkipDuplicateInbound(
        { ...base, OriginatingTo: "whatsapp:+1000" },
        { now: 100 },
      ),
    ).toBe(false);
    expect(
      shouldSkipDuplicateInbound(
        { ...base, OriginatingTo: "whatsapp:+2000" },
        { now: 200 },
      ),
    ).toBe(false);
  });

  it("does not dedupe across session keys", () => {
    resetInboundDedupe();
    const base: MsgContext = {
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+1555",
      MessageSid: "msg-1",
    };
    expect(
      shouldSkipDuplicateInbound(
        { ...base, SessionKey: "agent:alpha:main" },
        { now: 100 },
      ),
    ).toBe(false);
    expect(
      shouldSkipDuplicateInbound(
        { ...base, SessionKey: "agent:bravo:main" },
        { now: 200 },
      ),
    ).toBe(false);
    expect(
      shouldSkipDuplicateInbound(
        { ...base, SessionKey: "agent:alpha:main" },
        { now: 300 },
      ),
    ).toBe(true);
  });
});
