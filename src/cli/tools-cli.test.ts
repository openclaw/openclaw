import { describe, expect, it } from "vitest";
import { formatExecutePlanTextSummary } from "./tools-cli.js";

describe("formatExecutePlanTextSummary", () => {
  it("reports continued runs with failed steps as completed with errors", () => {
    expect(
      formatExecutePlanTextSummary({
        ok: false,
        stopped: false,
        steps: [
          {
            index: 0,
            action: "deploy.production",
            status: "blocked",
            durationMs: 1,
            error: { code: "requires_approval", message: "approval required" },
          },
          {
            index: 1,
            action: "openclaw.version",
            status: "completed",
            durationMs: 1,
          },
        ],
      }),
    ).toEqual([
      "1. deploy.production: blocked - approval required",
      "2. openclaw.version: completed",
      "plan completed with errors",
    ]);
  });

  it("reports stopped runs as stopped", () => {
    expect(
      formatExecutePlanTextSummary({
        ok: false,
        stopped: true,
        stopReason: "blocked_tool",
        steps: [
          {
            index: 0,
            action: "deploy.production",
            status: "blocked",
            durationMs: 1,
            error: { code: "forbidden", message: "tool call blocked" },
          },
        ],
      }),
    ).toEqual(["1. deploy.production: blocked - tool call blocked", "plan stopped: blocked_tool"]);
  });
});
