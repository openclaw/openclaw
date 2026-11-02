// Control UI tests cover session run state behavior.
import { describe, expect, it } from "vitest";
import { isSessionRunStateActive } from "./session-run-state.ts";

describe("isSessionRunStateActive", () => {
  it("uses explicit live-run state over stale running status", () => {
    expect(isSessionRunStateActive({ status: "running", hasActiveRun: false })).toBe(false);
    expect(isSessionRunStateActive({ status: "running", hasActiveRun: true })).toBe(true);
  });

  it("keeps terminal status authoritative over stale active flags", () => {
    expect(isSessionRunStateActive({ status: "done", hasActiveRun: true })).toBe(false);
    expect(isSessionRunStateActive({ status: "failed", hasActiveRun: true })).toBe(false);
    expect(isSessionRunStateActive({ status: "killed", hasActiveRun: true })).toBe(false);
    expect(isSessionRunStateActive({ status: "timeout", hasActiveRun: true })).toBe(false);
  });

  it("keeps legacy running status active when no live-run flag exists", () => {
    expect(isSessionRunStateActive({ status: "running" })).toBe(true);
    expect(isSessionRunStateActive({ hasActiveRun: true })).toBe(true);
  });

  it("keeps queued work active before execution starts", () => {
    expect(isSessionRunStateActive({ status: "queued", hasActiveRun: true })).toBe(true);
    expect(isSessionRunStateActive({ status: "queued" })).toBe(true);
  });
});
