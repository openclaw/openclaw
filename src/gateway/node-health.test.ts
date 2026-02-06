import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearNodeHealthFramesForNode,
  getLatestNodeHealthFrames,
  upsertNodeHealthFrame,
} from "./node-health.js";

describe("node health", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearNodeHealthFramesForNode("n1");
  });

  it("evicts entries older than TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    upsertNodeHealthFrame({ nodeId: "n1", frame: { ts: Date.now(), data: { ok: true } } });
    expect(getLatestNodeHealthFrames().map((e) => e.nodeId)).toEqual(["n1"]);

    // TTL is 10 minutes in node-health.ts.
    vi.setSystemTime(new Date("2026-01-01T00:10:00.001Z"));

    expect(getLatestNodeHealthFrames()).toEqual([]);
  });
});
