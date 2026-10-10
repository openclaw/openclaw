import { describe, expect, it } from "vitest";
import { pickLastNonEmptyTextFromPayloads, resolveCronPayloadOutcome } from "./helpers.js";

type TextPayload = { text?: string | undefined; isError?: boolean | undefined };

const textPayloadPickerCases: Array<{
  name: string;
  payloads: TextPayload[];
  expected: string | undefined;
}> = [
  {
    name: "last non-empty text picks real text over error payload",
    payloads: [{ text: "Real output" }, { text: "Service error", isError: true }],
    expected: "Real output",
  },
  {
    name: "last non-empty text falls back to error payload when no real text exists",
    payloads: [{ text: "Service error", isError: true }],
    expected: "Service error",
  },
  {
    name: "last non-empty text returns undefined for empty payloads",
    payloads: [],
    expected: undefined,
  },
];

describe("text payload pickers", () => {
  it.each(textPayloadPickerCases)("$name", ({ payloads, expected }) => {
    expect(pickLastNonEmptyTextFromPayloads(payloads)).toBe(expected);
  });
});

describe("cron delivery outcomes", () => {
  it("keeps NO_REPLY as a silent heartbeat acknowledgement", () => {
    expect(
      resolveCronPayloadOutcome({ payloads: [{ text: "NO_REPLY" }] }).deliveryDisposition,
    ).toEqual({ kind: "heartbeat", controlOnly: true });
  });

  it("keeps media visible even when its text is a silent acknowledgement", () => {
    const payload = { text: "NO_REPLY", mediaUrl: "https://example.com/update.png" };
    const outcome = resolveCronPayloadOutcome({ payloads: [payload] });

    expect(outcome.deliveryDisposition).toEqual({ kind: "visible" });
    expect(outcome.deliveryPayloads).toEqual([payload]);
  });
});
