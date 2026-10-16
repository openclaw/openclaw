import { describe, expect, it } from "vitest";
import { resolveCronPayloadOutcome } from "./helpers.js";

describe("cron delivery outcomes", () => {
  it("keeps prepared literal NO_REPLY visible", () => {
    expect(
      resolveCronPayloadOutcome({ payloads: [{ text: "NO_REPLY" }] }).deliveryDisposition,
    ).toEqual({ kind: "visible" });
  });

  it("keeps media visible even when its text is a silent acknowledgement", () => {
    const payload = { text: "NO_REPLY", mediaUrl: "https://example.com/update.png" };
    const outcome = resolveCronPayloadOutcome({ payloads: [payload] });

    expect(outcome.deliveryDisposition).toEqual({ kind: "visible" });
    expect(outcome.deliveryPayloads).toEqual([payload]);
  });
});
