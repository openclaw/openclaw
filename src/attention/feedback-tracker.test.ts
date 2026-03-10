import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetCacheForTest,
  getFeedbackStats,
  getSalienceModifier,
  recordFeedback,
} from "./feedback-tracker.js";
import type { FeedbackEvent } from "./feedback-tracker.js";

// ---------------------------------------------------------------------------
// Test setup: isolated temp directory per test
// ---------------------------------------------------------------------------

let tempDir: string;
let feedbackPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-feedback-test-"));
  feedbackPath = path.join(tempDir, "feedback.jsonl");
  process.env["AETHER_FEEDBACK_PATH"] = feedbackPath;
  _resetCacheForTest();
});

afterEach(() => {
  delete process.env["AETHER_FEEDBACK_PATH"];
  _resetCacheForTest();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  feedback_type: FeedbackEvent["feedback_type"],
  item_hash = "hash-001",
): FeedbackEvent {
  return {
    item_hash,
    item_content_preview: "PDUFA alert for NVDA: FDA decision expected today",
    feedback_type,
    timestamp: new Date().toISOString(),
    mode_at_feedback: "trading",
  };
}

// ---------------------------------------------------------------------------
// Tests: recordFeedback
// ---------------------------------------------------------------------------

describe("recordFeedback — file I/O", () => {
  it("creates the feedback file on first write", () => {
    expect(fs.existsSync(feedbackPath)).toBe(false);
    recordFeedback(makeEvent("acknowledged"));
    expect(fs.existsSync(feedbackPath)).toBe(true);
  });

  it("appends valid JSON lines", () => {
    recordFeedback(makeEvent("acted_on"));
    recordFeedback(makeEvent("deferred"));
    const lines = fs.readFileSync(feedbackPath, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as FeedbackEvent);
    expect(parsed[0]?.feedback_type).toBe("acted_on");
    expect(parsed[1]?.feedback_type).toBe("deferred");
  });

  it("persists all fields", () => {
    const event = makeEvent("dismissed_timing", "hash-abc");
    recordFeedback(event);
    const raw = fs.readFileSync(feedbackPath, "utf-8").trim();
    const parsed = JSON.parse(raw) as FeedbackEvent;
    expect(parsed.item_hash).toBe("hash-abc");
    expect(parsed.feedback_type).toBe("dismissed_timing");
    expect(parsed.mode_at_feedback).toBe("trading");
    expect(parsed.timestamp).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tests: getSalienceModifier — state machine transitions
// ---------------------------------------------------------------------------

describe("getSalienceModifier — default", () => {
  it("returns 1.0 for unknown item", () => {
    expect(getSalienceModifier("nonexistent-hash")).toBe(1.0);
  });
});

describe("getSalienceModifier — acted_on", () => {
  it("increases modifier by +0.15", () => {
    recordFeedback(makeEvent("acted_on"));
    expect(getSalienceModifier("hash-001")).toBeCloseTo(1.0 + 0.15, 5);
  });
});

describe("getSalienceModifier — dismissed_context", () => {
  it("decreases modifier by -0.15", () => {
    recordFeedback(makeEvent("dismissed_context"));
    expect(getSalienceModifier("hash-001")).toBeCloseTo(1.0 - 0.15, 5);
  });
});

describe("getSalienceModifier — dismissed_timing", () => {
  it("INCREASES modifier by +0.05 (never decrements)", () => {
    recordFeedback(makeEvent("dismissed_timing"));
    const modifier = getSalienceModifier("hash-001");
    // Critical invariant: dismissed_timing must produce a positive delta
    expect(modifier).toBeGreaterThan(1.0);
    expect(modifier).toBeCloseTo(1.0 + 0.05, 5);
  });

  it("stays positive even after multiple dismissed_timing events", () => {
    for (let i = 0; i < 5; i++) {
      recordFeedback(makeEvent("dismissed_timing"));
    }
    expect(getSalienceModifier("hash-001")).toBeGreaterThan(1.0);
  });

  it("dismissed_timing CANNOT cancel out a previous acted_on", () => {
    recordFeedback(makeEvent("acted_on"));
    recordFeedback(makeEvent("dismissed_timing"));
    const modifier = getSalienceModifier("hash-001");
    // acted_on (+0.15) + dismissed_timing (+0.05) = 1.20
    expect(modifier).toBeGreaterThan(1.0 + 0.15);
  });
});

describe("getSalienceModifier — acknowledged", () => {
  it("increases modifier by +0.05", () => {
    recordFeedback(makeEvent("acknowledged"));
    expect(getSalienceModifier("hash-001")).toBeCloseTo(1.0 + 0.05, 5);
  });
});

describe("getSalienceModifier — deferred", () => {
  it("increases modifier by +0.02", () => {
    recordFeedback(makeEvent("deferred"));
    expect(getSalienceModifier("hash-001")).toBeCloseTo(1.0 + 0.02, 5);
  });
});

describe("getSalienceModifier — expired", () => {
  it("decreases modifier by -0.05", () => {
    recordFeedback(makeEvent("expired"));
    expect(getSalienceModifier("hash-001")).toBeCloseTo(1.0 - 0.05, 5);
  });
});

// ---------------------------------------------------------------------------
// Tests: clamping
// ---------------------------------------------------------------------------

describe("getSalienceModifier — clamping to [0.5, 1.5]", () => {
  it("clamps at 1.5 after many positive events", () => {
    for (let i = 0; i < 20; i++) {
      recordFeedback(makeEvent("acted_on"));
    }
    expect(getSalienceModifier("hash-001")).toBe(1.5);
  });

  it("clamps at 0.5 after many negative events", () => {
    for (let i = 0; i < 20; i++) {
      recordFeedback(makeEvent("dismissed_context"));
    }
    expect(getSalienceModifier("hash-001")).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Tests: cache persistence
// ---------------------------------------------------------------------------

describe("getSalienceModifier — cache reload", () => {
  it("reloads modifier from disk after cache reset", () => {
    recordFeedback(makeEvent("acted_on"));
    // Simulate process restart — flush in-memory cache
    _resetCacheForTest();
    // Reload from disk
    expect(getSalienceModifier("hash-001")).toBeCloseTo(1.15, 5);
  });

  it("handles missing file gracefully (returns default)", () => {
    _resetCacheForTest();
    // No file written — should default to 1.0
    expect(getSalienceModifier("no-file-yet-hash")).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Tests: getFeedbackStats
// ---------------------------------------------------------------------------

describe("getFeedbackStats", () => {
  it("returns zero counts when file does not exist", () => {
    const stats = getFeedbackStats();
    for (const [, val] of Object.entries(stats)) {
      expect(val.count).toBe(0);
    }
  });

  it("counts events per feedback type", () => {
    recordFeedback(makeEvent("acted_on", "h1"));
    recordFeedback(makeEvent("acted_on", "h2"));
    recordFeedback(makeEvent("dismissed_context", "h3"));
    recordFeedback(makeEvent("dismissed_timing", "h4"));

    const stats = getFeedbackStats();
    expect(stats["acted_on"]?.count).toBe(2);
    expect(stats["dismissed_context"]?.count).toBe(1);
    expect(stats["dismissed_timing"]?.count).toBe(1);
    expect(stats["acknowledged"]?.count).toBe(0);
  });

  it("net_delta for dismissed_timing is positive (key invariant)", () => {
    recordFeedback(makeEvent("dismissed_timing", "h1"));
    recordFeedback(makeEvent("dismissed_timing", "h2"));
    const stats = getFeedbackStats();
    expect(stats["dismissed_timing"]?.net_delta).toBeGreaterThan(0);
  });

  it("net_delta for dismissed_context is negative", () => {
    recordFeedback(makeEvent("dismissed_context", "h1"));
    const stats = getFeedbackStats();
    expect(stats["dismissed_context"]?.net_delta).toBeLessThan(0);
  });

  it("net_delta for acted_on is strongly positive", () => {
    recordFeedback(makeEvent("acted_on", "h1"));
    const stats = getFeedbackStats();
    expect(stats["acted_on"]?.net_delta).toBeCloseTo(0.15, 5);
  });
});

// ---------------------------------------------------------------------------
// Tests: multiple items tracked independently
// ---------------------------------------------------------------------------

describe("multiple items", () => {
  it("tracks separate modifiers per item_hash", () => {
    recordFeedback(makeEvent("acted_on", "hash-A"));
    recordFeedback(makeEvent("dismissed_context", "hash-B"));

    expect(getSalienceModifier("hash-A")).toBeCloseTo(1.15, 5);
    expect(getSalienceModifier("hash-B")).toBeCloseTo(0.85, 5);
  });
});
