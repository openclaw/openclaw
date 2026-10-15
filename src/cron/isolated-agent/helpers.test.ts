import { describe, expect, it } from "vitest";
import { resolveCronPayloadOutcome } from "./helpers.js";

describe("cron delivery outcomes", () => {
  it("treats the retired heartbeat acknowledgement as ordinary output", () => {
    const payload = { text: "HEARTBEAT_OK" };
    const outcome = resolveCronPayloadOutcome({ payloads: [payload] });
    expect(outcome.deliveryDisposition).toEqual({ kind: "visible" });
    expect(outcome.deliveryPayloads).toEqual([payload]);
  });
  it("keeps NO_REPLY as a silent acknowledgement", () => {
    expect(
      resolveCronPayloadOutcome({ payloads: [{ text: "NO_REPLY" }] }).deliveryDisposition,
    ).toEqual({ kind: "silent", controlOnly: true });
  });

  it("keeps media visible even when its text is a silent acknowledgement", () => {
    const payload = { text: "NO_REPLY", mediaUrl: "https://example.com/update.png" };
    const outcome = resolveCronPayloadOutcome({ payloads: [payload] });

    expect(outcome.deliveryDisposition).toEqual({ kind: "visible" });
    expect(outcome.deliveryPayloads).toEqual([payload]);
  });
});
