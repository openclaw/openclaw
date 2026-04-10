// Octopus Orchestrator -- Event normalizer tests (M2-02)
//
// Covers:
//   1. Valid output event normalizes correctly
//   2. Valid state event normalizes correctly
//   3. Valid cost event normalizes correctly
//   4. Valid error event normalizes correctly
//   5. Valid completion event normalizes correctly
//   6. Malformed event (missing kind) produces anomaly record
//   7. Malformed event (missing ts) produces anomaly record
//   8. Malformed event (wrong ts type) produces anomaly record
//   9. Malformed event (null input) produces anomaly record
//  10. Malformed event (missing data) produces anomaly record
//  11. Sequence numbers are monotonic per-arm
//  12. Multiple arms get independent sequence counters

import { describe, expect, it } from "vitest";
import { EventNormalizer } from "./event-normalizer.ts";

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function validEvent(kind: string, data: Record<string, unknown> = { text: "hello" }) {
  return { kind, ts: 1_700_000_000_000, data };
}

// ──────────────────────────────────────────────────────────────────────────
// Valid event normalization
// ──────────────────────────────────────────────────────────────────────────

describe("EventNormalizer", () => {
  describe("valid events", () => {
    it("normalizes output event correctly", () => {
      const normalizer = new EventNormalizer();
      const result = normalizer.normalize("arm-1", validEvent("output"));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.event.kind).toBe("output");
      expect(result.event.arm_id).toBe("arm-1");
      expect(result.event.sequence).toBe(0);
      expect(result.event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.event.append_input.entity_type).toBe("arm");
      expect(result.event.append_input.entity_id).toBe("arm-1");
      expect(result.event.append_input.event_type).toBe("arm.active");
      expect(result.event.append_input.schema_version).toBe(1);
      expect(result.event.append_input.actor).toBe("arm:arm-1");
      expect(result.event.append_input.payload).toMatchObject({
        adapter_kind: "output",
        sequence: 0,
        text: "hello",
      });
    });

    it("normalizes state event correctly", () => {
      const normalizer = new EventNormalizer();
      const result = normalizer.normalize("arm-2", validEvent("state", { state: "idle" }));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.event.kind).toBe("state");
      expect(result.event.append_input.event_type).toBe("arm.active");
    });

    it("normalizes cost event correctly", () => {
      const normalizer = new EventNormalizer();
      const result = normalizer.normalize("arm-3", validEvent("cost", { usd: 0.05 }));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.event.kind).toBe("cost");
      expect(result.event.append_input.event_type).toBe("arm.active");
      expect(result.event.append_input.payload).toMatchObject({ usd: 0.05 });
    });

    it("normalizes error event correctly", () => {
      const normalizer = new EventNormalizer();
      const result = normalizer.normalize("arm-4", validEvent("error", { message: "boom" }));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.event.kind).toBe("error");
      expect(result.event.append_input.event_type).toBe("arm.failed");
    });

    it("normalizes completion event correctly", () => {
      const normalizer = new EventNormalizer();
      const result = normalizer.normalize("arm-5", validEvent("completion", { exit_code: 0 }));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.event.kind).toBe("completion");
      expect(result.event.append_input.event_type).toBe("arm.completed");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Malformed events produce anomaly records
  // ──────────────────────────────────────────────────────────────────────

  describe("malformed events", () => {
    it("produces anomaly for missing kind", () => {
      const normalizer = new EventNormalizer();
      const result = normalizer.normalize("arm-x", { ts: 1000, data: {} });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.anomaly.arm_id).toBe("arm-x");
      expect(result.anomaly.reason).toContain("kind");
      expect(result.anomaly.raw).toEqual({ ts: 1000, data: {} });
    });

    it("produces anomaly for missing ts", () => {
      const normalizer = new EventNormalizer();
      const result = normalizer.normalize("arm-x", { kind: "output", data: {} });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.anomaly.reason).toContain("ts");
    });

    it("produces anomaly for wrong ts type (string instead of number)", () => {
      const normalizer = new EventNormalizer();
      const result = normalizer.normalize("arm-x", {
        kind: "output",
        ts: "not-a-number",
        data: {},
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.anomaly.reason).toContain("ts");
    });

    it("produces anomaly for null input", () => {
      const normalizer = new EventNormalizer();
      const result = normalizer.normalize("arm-x", null);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.anomaly.reason).toContain("not an object");
      expect(result.anomaly.raw).toBeNull();
    });

    it("produces anomaly for missing data field", () => {
      const normalizer = new EventNormalizer();
      const result = normalizer.normalize("arm-x", { kind: "output", ts: 1000 });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.anomaly.reason).toContain("data");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Sequence monotonicity
  // ──────────────────────────────────────────────────────────────────────

  describe("sequence numbers", () => {
    it("are monotonic per-arm", () => {
      const normalizer = new EventNormalizer();
      const seqs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const result = normalizer.normalize("arm-seq", validEvent("output"));
        if (result.ok) {
          seqs.push(result.event.sequence);
        }
      }
      expect(seqs).toEqual([0, 1, 2, 3, 4]);
    });

    it("are independent across different arms", () => {
      const normalizer = new EventNormalizer();
      const r1 = normalizer.normalize("arm-a", validEvent("output"));
      const r2 = normalizer.normalize("arm-b", validEvent("output"));
      const r3 = normalizer.normalize("arm-a", validEvent("state"));
      const r4 = normalizer.normalize("arm-b", validEvent("state"));

      expect(r1.ok && r1.event.sequence).toBe(0);
      expect(r2.ok && r2.event.sequence).toBe(0);
      expect(r3.ok && r3.event.sequence).toBe(1);
      expect(r4.ok && r4.event.sequence).toBe(1);
    });
  });
});
