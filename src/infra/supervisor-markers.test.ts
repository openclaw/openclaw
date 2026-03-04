import { describe, it, expect } from "vitest";
import { hasSupervisorHint } from "./supervisor-markers.js";

describe("hasSupervisorHint", () => {
  it("detects Windows scheduled task marker", () => {
    expect(hasSupervisorHint({ OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway" })).toBe(true);
  });

  it("detects Windows task script marker", () => {
    expect(hasSupervisorHint({ OPENCLAW_TASK_SCRIPT: "gateway.cmd" })).toBe(true);
  });

  it("returns false for empty env", () => {
    expect(hasSupervisorHint({})).toBe(false);
  });
});
