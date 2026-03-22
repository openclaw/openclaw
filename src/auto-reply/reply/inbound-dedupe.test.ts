import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import type { DedupeCache } from "../../infra/dedupe.js";
import type { MsgContext } from "../templating.js";
import { resetInboundDedupe, shouldSkipDuplicateInbound } from "./inbound-dedupe.js";

const sharedInboundContext: MsgContext = {
  Provider: "discord",
  Surface: "discord",
  From: "discord:user-1",
  To: "channel:c1",
  OriginatingChannel: "discord",
  OriginatingTo: "channel:c1",
  SessionKey: "agent:main:discord:channel:c1",
  MessageSid: "msg-1",
};

describe("inbound dedupe", () => {
  afterEach(() => {
    resetInboundDedupe();
  });

  it("shares dedupe state across distinct module instances", async () => {
    const inboundA = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=shared-a",
    );
    const inboundB = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=shared-b",
    );

    inboundA.resetInboundDedupe();
    inboundB.resetInboundDedupe();

    try {
      expect(inboundA.shouldSkipDuplicateInbound(sharedInboundContext)).toBe(false);
      expect(inboundB.shouldSkipDuplicateInbound(sharedInboundContext)).toBe(true);
    } finally {
      inboundA.resetInboundDedupe();
      inboundB.resetInboundDedupe();
    }
  });

  it("dedupes short-lived discord thread content clones for agent sessions", () => {
    const first: MsgContext = {
      Provider: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:c1",
      SessionKey: "agent:main:discord:channel:c1",
      MessageThreadId: "thread-1",
      MessageSid: "msg-1",
      BodyForCommands: "hello there",
    };
    const second: MsgContext = {
      ...first,
      MessageSid: "msg-2",
      RawBody: undefined,
      CommandBody: undefined,
      BodyForCommands: "hello   there",
    };

    expect(shouldSkipDuplicateInbound(first, { now: 100 })).toBe(false);
    expect(shouldSkipDuplicateInbound(second, { now: 101 })).toBe(true);
  });

  it("does not apply content-clone dedupe outside discord agent threads", () => {
    const base: MsgContext = {
      Provider: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:c1",
      MessageSid: "msg-1",
      BodyForCommands: "same body",
    };

    expect(
      shouldSkipDuplicateInbound(
        { ...base, SessionKey: "agent:main:discord:channel:c1", MessageThreadId: undefined },
        { now: 100 },
      ),
    ).toBe(false);
    expect(
      shouldSkipDuplicateInbound(
        { ...base, SessionKey: "agent:main:discord:channel:c1", MessageSid: "msg-2" },
        { now: 101 },
      ),
    ).toBe(false);
    expect(
      shouldSkipDuplicateInbound(
        {
          ...base,
          SessionKey: "discord:channel:c1",
          MessageThreadId: "thread-1",
          MessageSid: "msg-3",
        },
        { now: 102 },
      ),
    ).toBe(false);
  });

  it("supports overriding the content-clone cache separately", () => {
    const first: MsgContext = {
      Provider: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:c1",
      SessionKey: "agent:main:discord:channel:c1",
      MessageThreadId: "thread-1",
      MessageSid: "msg-1",
      BodyForCommands: "same body",
    };
    const second: MsgContext = {
      ...first,
      MessageSid: "msg-2",
    };
    const cloneCache: DedupeCache = {
      check: vi.fn((key: string) => key.endsWith("same body")),
      clear: vi.fn(),
    };

    expect(shouldSkipDuplicateInbound(first, { now: 100, cloneCache })).toBe(true);
    expect(cloneCache.check).toHaveBeenCalled();
    expect(shouldSkipDuplicateInbound(second, { now: 101, cache: cloneCache, cloneCache })).toBe(
      true,
    );
  });
});
