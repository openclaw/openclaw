// Covers runtime status formatting.
import { describe, expect, it } from "vitest";
import { formatRuntimeStatusWithDetails } from "./runtime-status.js";

describe("formatRuntimeStatusWithDetails", () => {
  it.each<[Parameters<typeof formatRuntimeStatusWithDetails>[0], string]>([
    [{}, "unknown"],
    [{ status: "   " }, "unknown"],
    [
      {
        status: "running",
        pid: 1234,
        state: "sleeping",
        details: ["healthy", "", "port 18789"],
      },
      "running (pid 1234, state sleeping, healthy, port 18789)",
    ],
    [
      {
        status: "running",
        state: " sleeping ",
        details: [" healthy ", "  port 18789  "],
      },
      "running (state sleeping, healthy, port 18789)",
    ],
    [{ status: "running", pid: 0, state: "RUNNING", details: [] }, "running"],
    [{ status: " RUNNING ", state: "running", details: [] }, "RUNNING"],
    [{ status: "running", state: "   ", details: ["", "   "] }, "running"],
  ])("formats status and normalized details for %j", (input, expected) => {
    expect(formatRuntimeStatusWithDetails(input)).toBe(expected);
  });
});
