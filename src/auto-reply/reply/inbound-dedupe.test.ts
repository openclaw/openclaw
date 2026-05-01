import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import {
  buildInboundDedupeKey,
  resetInboundDedupe,
  shouldSkipDuplicateInbound,
  type InboundDedupeClaimResult,
} from "./inbound-dedupe.js";

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

function expectClaimed(result: InboundDedupeClaimResult, expectedKey: string): string {
  expect(result).toEqual({ status: "claimed", key: expectedKey });
  if (result.status !== "claimed") {
    throw new Error(`expected claimed inbound dedupe result, got ${result.status}`);
  }
  return result.key;
}

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

  it("deduplicates inbound messages with equivalent numeric and string thread ids", () => {
    expect(
      buildInboundDedupeKey({
        ...sharedInboundContext,
        MessageThreadId: 77,
      }),
    ).toBe(
      buildInboundDedupeKey({
        ...sharedInboundContext,
        MessageThreadId: "77",
      }),
    );
  });

  it("uses the route-key JSON shape for idless content fallbacks", () => {
    const providerKey = buildInboundDedupeKey({
      ...sharedInboundContext,
      MessageThreadId: 77,
    });
    const idlessKey = buildInboundDedupeKey({
      ...sharedInboundContext,
      MessageSid: undefined,
      MessageThreadId: 77,
      Body: "hello from webchat",
      Timestamp: 1777207291784,
    });

    expect(providerKey).not.toBeNull();
    expect(idlessKey).not.toBeNull();

    const providerParts = JSON.parse(providerKey ?? "[]") as unknown[];
    const idlessParts = JSON.parse(idlessKey ?? "[]") as unknown[];

    expect(idlessParts).toHaveLength(3);
    expect(idlessParts.slice(0, 2)).toEqual(providerParts.slice(0, 2));
    expect(idlessParts[2]).toMatch(/^content:[a-f0-9]{32}$/);
  });

  it("shares claim/release state across distinct module instances", async () => {
    const expectedKey = buildInboundDedupeKey(sharedInboundContext);
    if (!expectedKey) {
      throw new Error("expected inbound dedupe key");
    }
    const inboundA = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=claim-a",
    );
    const inboundB = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=claim-b",
    );

    inboundA.resetInboundDedupe();
    inboundB.resetInboundDedupe();

    try {
      const firstClaim = inboundA.claimInboundDedupe(sharedInboundContext);
      const firstClaimKey = expectClaimed(firstClaim, expectedKey);
      expect(inboundB.claimInboundDedupe(sharedInboundContext)).toEqual({
        status: "inflight",
        key: expectedKey,
      });
      inboundB.releaseInboundDedupe(firstClaimKey);
      expect(inboundA.claimInboundDedupe(sharedInboundContext)).toEqual({
        status: "claimed",
        key: expectedKey,
      });
    } finally {
      inboundA.resetInboundDedupe();
      inboundB.resetInboundDedupe();
    }
  });

  it("shares claim/commit state across distinct module instances", async () => {
    const expectedKey = buildInboundDedupeKey(sharedInboundContext);
    if (!expectedKey) {
      throw new Error("expected inbound dedupe key");
    }
    const inboundA = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=commit-a",
    );
    const inboundB = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=commit-b",
    );

    inboundA.resetInboundDedupe();
    inboundB.resetInboundDedupe();

    try {
      const firstClaim = inboundA.claimInboundDedupe(sharedInboundContext);
      const firstClaimKey = expectClaimed(firstClaim, expectedKey);
      inboundA.commitInboundDedupe(firstClaimKey);
      expect(inboundB.claimInboundDedupe(sharedInboundContext)).toEqual({
        status: "duplicate",
        key: expectedKey,
      });
    } finally {
      inboundA.resetInboundDedupe();
      inboundB.resetInboundDedupe();
    }
  });

  it("dedupes retries without provider message ids by content and timestamp", () => {
    const first = {
      ...sharedInboundContext,
      MessageSid: undefined,
      Body: "hello from webchat",
      Timestamp: 1777207291784,
    };
    const retry = {
      ...first,
      BodyForAgent: "Sender metadata\n\nhello from webchat",
    };

    expect(shouldSkipDuplicateInbound(first)).toBe(false);
    expect(shouldSkipDuplicateInbound(retry)).toBe(true);
  });

  it("does not collapse distinct same-body messages with different timestamps", () => {
    const first = {
      ...sharedInboundContext,
      MessageSid: undefined,
      Body: "repeatable text",
      Timestamp: 1777207291784,
    };
    const later = {
      ...first,
      Timestamp: 1777207299999,
    };

    expect(shouldSkipDuplicateInbound(first)).toBe(false);
    expect(shouldSkipDuplicateInbound(later)).toBe(false);
  });

  it("does not create a fallback key for idless messages without timestamps", () => {
    const first = {
      ...sharedInboundContext,
      MessageSid: undefined,
      Body: "repeatable text",
      Timestamp: undefined,
    };
    const retry = {
      ...first,
      BodyForAgent: "Sender metadata\n\nrepeatable text",
    };

    expect(buildInboundDedupeKey(first)).toBeNull();
    expect(shouldSkipDuplicateInbound(first)).toBe(false);
    expect(shouldSkipDuplicateInbound(retry)).toBe(false);
  });

  it("does not create a fallback key for idless messages without text content", () => {
    expect(
      buildInboundDedupeKey({
        ...sharedInboundContext,
        MessageSid: undefined,
        Body: "",
        RawBody: "",
        CommandBody: "",
        Timestamp: 1777207291784,
      }),
    ).toBeNull();
  });
});
