import { describe, it, expect } from "vitest";
import { hasSupervisorHint } from "./supervisor-markers.js";

describe("hasSupervisorHint", () => {
  it("detects Windows scheduled task marker", () => {
    expect(hasSupervisorHint({ OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway" })).toBe(true);
  });

  it("does not treat OPENCLAW_TASK_SCRIPT as supervisor hint", () => {
    expect(hasSupervisorHint({ OPENCLAW_TASK_SCRIPT: "gateway.cmd" })).toBe(false);
  });

  it("returns false for empty env", () => {
    expect(hasSupervisorHint({})).toBe(false);
  });
});
