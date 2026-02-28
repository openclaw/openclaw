import { describe, expect, it } from "vitest";
import { deriveTaint } from "./taint-propagation.js";
import { TaintTracker } from "./taint-tracker.js";
import { InstructionLevel } from "./types.js";

describe("TaintTracker", () => {
  describe("initial state", () => {
    it("starts at SYSTEM level with no fields", () => {
      const tracker = new TaintTracker();
      expect(tracker.getAggregateLevel()).toBe(InstructionLevel.SYSTEM);
      expect(tracker.fieldCount()).toBe(0);
      expect(tracker.isCollapsed()).toBe(false);
    });
  });

  describe("tagField", () => {
    it("tags a field and raises aggregate level", () => {
      const tracker = new TaintTracker();
      tracker.tagField("args.url", InstructionLevel.EXTERNAL_CONTENT, "web_fetch");

      expect(tracker.getAggregateLevel()).toBe(InstructionLevel.EXTERNAL_CONTENT);
      expect(tracker.fieldCount()).toBe(1);

      const field = tracker.getFieldTaint("args.url");
      expect(field).toBeDefined();
      expect(field!.level).toBe(InstructionLevel.EXTERNAL_CONTENT);
      expect(field!.source).toBe("web_fetch");
    });

    it("keeps worse taint when re-tagging same field at lower privilege", () => {
      const tracker = new TaintTracker();
      tracker.tagField("data", InstructionLevel.EXTERNAL_CONTENT);
      tracker.tagField("data", InstructionLevel.USER);

      const field = tracker.getFieldTaint("data");
      expect(field!.level).toBe(InstructionLevel.EXTERNAL_CONTENT);
    });

    it("upgrades taint when re-tagging same field at worse privilege", () => {
      const tracker = new TaintTracker();
      tracker.tagField("data", InstructionLevel.USER);
      tracker.tagField("data", InstructionLevel.EXTERNAL_CONTENT);

      const field = tracker.getFieldTaint("data");
      expect(field!.level).toBe(InstructionLevel.EXTERNAL_CONTENT);
    });

    it("tracks multiple independent fields", () => {
      const tracker = new TaintTracker();
      tracker.tagField("a", InstructionLevel.USER);
      tracker.tagField("b", InstructionLevel.TASK);
      tracker.tagField("c", InstructionLevel.EXTERNAL_CONTENT);

      expect(tracker.fieldCount()).toBe(3);
      expect(tracker.getAggregateLevel()).toBe(InstructionLevel.EXTERNAL_CONTENT);
    });
  });

  describe("explosion threshold", () => {
    it("auto-collapses when field count exceeds threshold", () => {
      const tracker = new TaintTracker({ explosionThreshold: 5 });

      for (let i = 0; i < 6; i++) {
        tracker.tagField(`field_${i}`, InstructionLevel.USER);
      }

      expect(tracker.isCollapsed()).toBe(true);
      expect(tracker.fieldCount()).toBe(0);
      expect(tracker.getFields()).toEqual([]);
      expect(tracker.getAggregateLevel()).toBe(InstructionLevel.USER);
    });

    it("stops tracking new fields after collapse", () => {
      const tracker = new TaintTracker({ explosionThreshold: 2 });
      tracker.tagField("a", InstructionLevel.USER);
      tracker.tagField("b", InstructionLevel.USER);
      tracker.tagField("c", InstructionLevel.USER); // triggers collapse

      expect(tracker.isCollapsed()).toBe(true);

      // New tags still update aggregate level
      tracker.tagField("d", InstructionLevel.EXTERNAL_CONTENT);
      expect(tracker.getAggregateLevel()).toBe(InstructionLevel.EXTERNAL_CONTENT);
      expect(tracker.getFieldTaint("d")).toBeUndefined();
    });
  });

  describe("tagArtifact", () => {
    it("collapses and sets aggregate level", () => {
      const tracker = new TaintTracker();
      tracker.tagField("a", InstructionLevel.USER);
      tracker.tagArtifact(InstructionLevel.EXTERNAL_CONTENT);

      expect(tracker.isCollapsed()).toBe(true);
      expect(tracker.getAggregateLevel()).toBe(InstructionLevel.EXTERNAL_CONTENT);
      expect(tracker.fieldCount()).toBe(0);
    });
  });

  describe("merge", () => {
    it("merges fields from another tracker (worst-case per field)", () => {
      const a = new TaintTracker();
      a.tagField("x", InstructionLevel.USER);

      const b = new TaintTracker();
      b.tagField("x", InstructionLevel.EXTERNAL_CONTENT);
      b.tagField("y", InstructionLevel.TASK);

      a.merge(b);

      expect(a.fieldCount()).toBe(2);
      expect(a.getFieldTaint("x")!.level).toBe(InstructionLevel.EXTERNAL_CONTENT);
      expect(a.getFieldTaint("y")!.level).toBe(InstructionLevel.TASK);
      expect(a.getAggregateLevel()).toBe(InstructionLevel.EXTERNAL_CONTENT);
    });

    it("collapses when merging a collapsed tracker", () => {
      const a = new TaintTracker();
      a.tagField("x", InstructionLevel.USER);

      const b = new TaintTracker();
      b.tagArtifact(InstructionLevel.EXTERNAL_CONTENT);

      a.merge(b);

      expect(a.isCollapsed()).toBe(true);
      expect(a.getAggregateLevel()).toBe(InstructionLevel.EXTERNAL_CONTENT);
    });

    it("triggers collapse when merged field count exceeds threshold", () => {
      const a = new TaintTracker({ explosionThreshold: 4 });
      a.tagField("a1", InstructionLevel.USER);
      a.tagField("a2", InstructionLevel.USER);

      const b = new TaintTracker();
      b.tagField("b1", InstructionLevel.TASK);
      b.tagField("b2", InstructionLevel.TASK);
      b.tagField("b3", InstructionLevel.TASK);

      a.merge(b);

      expect(a.isCollapsed()).toBe(true);
    });

    it("is a no-op for fields when receiver is already collapsed", () => {
      const a = new TaintTracker();
      a.tagArtifact(InstructionLevel.USER);

      const b = new TaintTracker();
      b.tagField("x", InstructionLevel.EXTERNAL_CONTENT);

      a.merge(b);

      expect(a.isCollapsed()).toBe(true);
      expect(a.getAggregateLevel()).toBe(InstructionLevel.EXTERNAL_CONTENT);
    });
  });

  describe("toTaggedPayload", () => {
    it("produces payload with fields when not collapsed", () => {
      const tracker = new TaintTracker();
      tracker.tagField("a", InstructionLevel.USER, "input");

      const payload = tracker.toTaggedPayload("content", "test");

      expect(payload.level).toBe(InstructionLevel.USER);
      expect(payload.content).toBe("content");
      expect(payload.source).toBe("test");
      expect(payload.fields).toHaveLength(1);
      expect(payload.fields![0].fieldPath).toBe("a");
    });

    it("omits fields when collapsed", () => {
      const tracker = new TaintTracker();
      tracker.tagArtifact(InstructionLevel.EXTERNAL_CONTENT);

      const payload = tracker.toTaggedPayload({ data: 1 });

      expect(payload.level).toBe(InstructionLevel.EXTERNAL_CONTENT);
      expect(payload.fields).toBeUndefined();
    });
  });
});

describe("deriveTaint", () => {
  it("returns SYSTEM for empty sources", () => {
    const result = deriveTaint([]);
    expect(result.level).toBe(InstructionLevel.SYSTEM);
  });

  it("returns worst-case level across sources", () => {
    const result = deriveTaint([
      { level: InstructionLevel.USER, content: "a" },
      { level: InstructionLevel.EXTERNAL_CONTENT, content: "b" },
    ]);
    expect(result.level).toBe(InstructionLevel.EXTERNAL_CONTENT);
  });

  it("merges fields from all sources (worst-case per path)", () => {
    const result = deriveTaint([
      {
        level: InstructionLevel.USER,
        content: "a",
        fields: [{ fieldPath: "x", level: InstructionLevel.USER }],
      },
      {
        level: InstructionLevel.EXTERNAL_CONTENT,
        content: "b",
        fields: [{ fieldPath: "x", level: InstructionLevel.EXTERNAL_CONTENT }],
      },
    ]);

    expect(result.fields).toHaveLength(1);
    expect(result.fields![0].level).toBe(InstructionLevel.EXTERNAL_CONTENT);
  });

  it("omits fields when any source lacks field-level taint", () => {
    const result = deriveTaint([
      {
        level: InstructionLevel.USER,
        content: "a",
        fields: [{ fieldPath: "x", level: InstructionLevel.USER }],
      },
      { level: InstructionLevel.EXTERNAL_CONTENT, content: "b" },
    ]);

    expect(result.fields).toBeUndefined();
  });
});
