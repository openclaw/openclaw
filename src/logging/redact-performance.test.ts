import { channel } from "node:diagnostics_channel";
import { expect, it } from "vitest";
import { redactLogRecordForTransport, redactText } from "./redact.js";

it("measures real redaction without publishing content and preserves a failing receiver", () => {
  const source = channel("openclaw.redaction");
  const records: unknown[] = [];
  const listener = (message: unknown) => records.push(message);
  const input = "Synthetic confidential body";
  const baseline = redactText(input, []);
  source.subscribe(listener);
  try {
    expect(redactText(input, [])).toBe(baseline);
    expect(redactLogRecordForTransport({ message: input })).toEqual({ message: input });
    const failure = new Error("Synthetic private failure detail");
    expect(() =>
      redactLogRecordForTransport({
        receiver: {
          toJSON() {
            throw failure;
          },
        },
      }),
    ).toThrow(failure);
  } finally {
    source.unsubscribe(listener);
  }
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        operation: "text",
        outcome: "ok",
        inputChars: input.length,
        patternCount: 0,
      }),
      expect.objectContaining({ operation: "log-record", outcome: "ok" }),
      expect.objectContaining({ operation: "log-record", outcome: "error" }),
    ]),
  );
  for (const entry of records) {
    expect(entry).toMatchObject({ elapsedMs: expect.any(Number), threadCpuMs: expect.any(Number) });
  }
  const serialized = JSON.stringify(records);
  expect(serialized).not.toContain(input);
  expect(serialized).not.toContain("Synthetic private failure detail");
  const count = records.length;
  redactText(input, []);
  expect(records).toHaveLength(count);
});
