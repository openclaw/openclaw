// Octopus Orchestrator -- Chaos test: malformed adapter events (M2-19)
//
// Injects various malformed events through EventNormalizer.normalize() and
// asserts:
//   1. Events are rejected (ok: false)
//   2. Anomaly records are produced with clear descriptions
//   3. The normalizer does NOT throw (no crash)
//   4. Valid events interleaved with malformed ones still normalize correctly
//
// Boundary discipline (OCTO-DEC-033): only node:* builtins and relative
// imports inside src/octo/.

import { describe, expect, it } from "vitest";
import type { AdapterEvent } from "../../adapters/base.ts";
import { EventNormalizer } from "../../adapters/event-normalizer.ts";
import type { NormalizationResult } from "../../adapters/event-normalizer.ts";

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const ARM_ID = "chaos-test-arm-01";

function validEvent(): AdapterEvent {
  return { kind: "output", ts: Date.now(), data: { text: "hello" } };
}

function expectAnomaly(result: NormalizationResult, reasonSubstring: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.anomaly.arm_id).toBe(ARM_ID);
    expect(typeof result.anomaly.sequence).toBe("number");
    expect(typeof result.anomaly.detected_at).toBe("string");
    expect(result.anomaly.reason).toContain(reasonSubstring);
    expect("raw" in result.anomaly).toBe(true);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("Chaos: malformed adapter events through EventNormalizer", () => {
  it("rejects event with missing kind field", () => {
    const normalizer = new EventNormalizer();
    const raw = { ts: Date.now(), data: { x: 1 } };
    const result = normalizer.normalize(ARM_ID, raw);
    expectAnomaly(result, "kind");
  });

  it("rejects event with missing ts field", () => {
    const normalizer = new EventNormalizer();
    const raw = { kind: "output", data: { x: 1 } };
    const result = normalizer.normalize(ARM_ID, raw);
    expectAnomaly(result, "ts");
  });

  it("rejects event with wrong type for kind (number instead of string)", () => {
    const normalizer = new EventNormalizer();
    const raw = { kind: 42, ts: Date.now(), data: { x: 1 } };
    const result = normalizer.normalize(ARM_ID, raw);
    expectAnomaly(result, "kind");
  });

  it("rejects event with wrong type for data (string instead of object)", () => {
    const normalizer = new EventNormalizer();
    const raw = { kind: "output", ts: Date.now(), data: "not-an-object" };
    const result = normalizer.normalize(ARM_ID, raw);
    expectAnomaly(result, "data");
  });

  it("rejects event with unknown kind value", () => {
    const normalizer = new EventNormalizer();
    const raw = { kind: "banana", ts: Date.now(), data: { x: 1 } };
    const result = normalizer.normalize(ARM_ID, raw);
    expectAnomaly(result, "kind");
  });

  it("rejects null event", () => {
    const normalizer = new EventNormalizer();
    const result = normalizer.normalize(ARM_ID, null);
    expectAnomaly(result, "not an object");
  });

  it("rejects undefined event", () => {
    const normalizer = new EventNormalizer();
    const result = normalizer.normalize(ARM_ID, undefined);
    expectAnomaly(result, "not an object");
  });

  it("rejects event with data as array", () => {
    const normalizer = new EventNormalizer();
    const raw = { kind: "output", ts: Date.now(), data: [1, 2, 3] };
    const result = normalizer.normalize(ARM_ID, raw);
    expectAnomaly(result, "data");
  });

  it("rejects event with negative ts", () => {
    const normalizer = new EventNormalizer();
    const raw = { kind: "output", ts: -1, data: { x: 1 } };
    const result = normalizer.normalize(ARM_ID, raw);
    expectAnomaly(result, "ts");
  });

  it("rejects event with NaN ts", () => {
    const normalizer = new EventNormalizer();
    const raw = { kind: "output", ts: NaN, data: { x: 1 } };
    const result = normalizer.normalize(ARM_ID, raw);
    expectAnomaly(result, "ts");
  });

  it("valid event after a malformed one still normalizes correctly (recovery)", () => {
    const normalizer = new EventNormalizer();

    // First: malformed
    const bad = normalizer.normalize(ARM_ID, null);
    expect(bad.ok).toBe(false);

    // Second: valid
    const good = normalizer.normalize(ARM_ID, validEvent());
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.event.arm_id).toBe(ARM_ID);
      expect(good.event.kind).toBe("output");
      expect(typeof good.event.ts).toBe("string");
      expect(good.event.data).toEqual({ text: "hello" });
      expect(good.event.append_input).toBeDefined();
      expect(good.event.sequence).toBe(1); // 0 was the anomaly
    }
  });

  it("sequences increment monotonically across malformed and valid events", () => {
    const normalizer = new EventNormalizer();
    const results: NormalizationResult[] = [
      normalizer.normalize(ARM_ID, null), // seq 0
      normalizer.normalize(ARM_ID, { bad: true }), // seq 1
      normalizer.normalize(ARM_ID, validEvent()), // seq 2
      normalizer.normalize(ARM_ID, undefined), // seq 3
      normalizer.normalize(ARM_ID, validEvent()), // seq 4
    ];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) {
        continue;
      }
      const seq = r.ok ? r.event.sequence : r.anomaly.sequence;
      expect(seq).toBe(i);
    }
  });

  it("never throws on any malformed input", () => {
    const normalizer = new EventNormalizer();
    const inputs: unknown[] = [
      null,
      undefined,
      42,
      "string",
      true,
      [],
      { kind: 0 },
      { kind: "output", ts: "not-a-number", data: {} },
      { kind: "output", ts: Infinity, data: {} },
      Object.create(null),
    ];

    for (const input of inputs) {
      expect(() => normalizer.normalize(ARM_ID, input)).not.toThrow();
    }
  });
});
