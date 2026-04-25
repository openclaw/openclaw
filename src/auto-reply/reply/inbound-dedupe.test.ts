import { afterEach, describe, expect, it } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import type { MsgContext } from "../templating.js";
import {
  claimInboundDedupe,
  poisonInboundDedupe,
  releaseInboundDedupe,
  resetInboundDedupe,
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

  it("shares claim/release state across distinct module instances", async () => {
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
      expect(firstClaim).toMatchObject({ status: "claimed" });
      expect(inboundB.claimInboundDedupe(sharedInboundContext)).toMatchObject({
        status: "inflight",
      });
      if (firstClaim.status !== "claimed") {
        throw new Error("expected claimed inbound dedupe result");
      }
      inboundB.releaseInboundDedupe(firstClaim.key);
      expect(inboundA.claimInboundDedupe(sharedInboundContext)).toMatchObject({
        status: "claimed",
      });
    } finally {
      inboundA.resetInboundDedupe();
      inboundB.resetInboundDedupe();
    }
  });

  it("poisonInboundDedupe stamps the cache so subsequent identical inbound is skipped", () => {
    const claim = claimInboundDedupe(sharedInboundContext);
    expect(claim).toMatchObject({ status: "claimed" });
    if (claim.status !== "claimed") {
      throw new Error("expected claimed inbound dedupe result");
    }

    poisonInboundDedupe(claim.key);

    // cache.peek (used by claim) hits the stamped cache → duplicate.
    expect(claimInboundDedupe(sharedInboundContext)).toMatchObject({ status: "duplicate" });
  });

  it("releaseInboundDedupe leaves the cache unstamped so transient retries can re-claim", () => {
    const claim = claimInboundDedupe(sharedInboundContext);
    expect(claim).toMatchObject({ status: "claimed" });
    if (claim.status !== "claimed") {
      throw new Error("expected claimed inbound dedupe result");
    }

    releaseInboundDedupe(claim.key);

    // Cache is unstamped; the same message_id can re-enter and re-claim.
    expect(claimInboundDedupe(sharedInboundContext)).toMatchObject({ status: "claimed" });
  });
});
