import { describe, expect, it } from "vitest";
import { resolveCronPayloadOutcome } from "./helpers.js";

describe("cron delivery outcomes", () => {
  it.each(["NO_REPLY", "no_r", "NO_R"])("keeps prepared literal %s visible", (text) => {
    const payloads = [{ text }, { text: "Scheduled result" }];
    const outcome = resolveCronPayloadOutcome({ payloads });
    expect(outcome.deliveryDisposition).toEqual({ kind: "visible" });
    expect(outcome.deliveryPayloads).toEqual(payloads);
    expect(resolveCronPayloadOutcome({ payloads: [{ text }] }).deliveryDisposition).toEqual({
      kind: "visible",
    });
  });

  it("keeps media visible even when its text is a silent acknowledgement", () => {
    const payload = { text: "NO_REPLY", mediaUrl: "https://example.com/update.png" };
    const outcome = resolveCronPayloadOutcome({ payloads: [payload] });

    expect(outcome.deliveryDisposition).toEqual({ kind: "visible" });
    expect(outcome.deliveryPayloads).toEqual([payload]);
  });
});
