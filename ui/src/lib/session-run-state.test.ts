// Control UI tests cover session run state behavior.
import { describe, expect, it } from "vitest";
import { isSessionRunActive } from "./session-run-state.ts";

describe("isSessionRunActive", () => {
  it("uses explicit live-run state over stale running status", () => {
    expect(isSessionRunActive({ status: "running", hasActiveRun: false })).toBe(false);
    expect(isSessionRunActive({ status: "running", hasActiveRun: true })).toBe(true);
  });

  it("keeps terminal status authoritative over stale active flags", () => {
    expect(isSessionRunActive({ status: "done", hasActiveRun: true })).toBe(false);
    expect(isSessionRunActive({ status: "failed", hasActiveRun: true })).toBe(false);
    expect(isSessionRunActive({ status: "killed", hasActiveRun: true })).toBe(false);
    expect(isSessionRunActive({ status: "timeout", hasActiveRun: true })).toBe(false);
  });

  it("keeps legacy running status active when no live-run flag exists", () => {
    expect(isSessionRunActive({ status: "running" })).toBe(true);
    expect(isSessionRunActive({ hasActiveRun: true })).toBe(true);
  });

  it("treats paused (sessions_yield) sessions as active so the UI does not reconcile them to terminal", () => {
    // Paused sessions ended via sessions_yield with a queued continuation
    // still pending. Treating them as inactive would let the UI fall through
    // to the "interrupted/killed" reconciler path. Mirrors the gateway-side
    // nonterminal set (running + paused).
    expect(isSessionRunActive({ status: "paused" })).toBe(true);
    expect(isSessionRunActive({ status: "paused", hasActiveRun: false })).toBe(true);
    expect(isSessionRunActive({ status: "paused", hasActiveRun: true })).toBe(true);
  });
});
