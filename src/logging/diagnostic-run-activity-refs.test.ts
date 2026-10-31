// Covers release of retained session activity refs for long-lived Gateways.
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityByRef, resolveSessionActivity } from "./diagnostic-run-activity-state.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";

const TTL_MS = 30 * 60 * 1000;

// Reclamation runs inside the production lookup path; a run-only probe never creates state.
function probeLookup(): void {
  resolveSessionActivity({ sessionId: "probe-session" });
}

afterEach(() => {
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
});

describe("diagnostic session activity refs", () => {
  it("releases idle activities whose ttl expired", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-10-20T00:00:00Z");
    vi.setSystemTime(startedAt);
    startDiagnosticRunActivityTracking();
    markDiagnosticRunProgress({
      sessionId: "idle-session",
      sessionKey: "agent:main:webchat",
      reason: "model_call:stream_progress",
    });
    expect(activityByRef.size).toBeGreaterThan(0);

    vi.setSystemTime(startedAt + TTL_MS + 60_000);
    probeLookup();

    // Releasing only one ref would keep the activity reachable through the other.
    expect(activityByRef.has("id:idle-session")).toBe(false);
    expect(activityByRef.has("key:agent:main:webchat")).toBe(false);
    expect(activityByRef.size).toBe(0);
  });

  it("keeps activities that still have an active embedded run", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-10-20T00:00:00Z");
    vi.setSystemTime(startedAt);
    startDiagnosticRunActivityTracking();
    const ref = {
      sessionId: "active-session",
      sessionKey: "agent:main:webchat",
      runId: "active-run",
    };
    const owner = createDiagnosticEmbeddedRunOwner(ref);
    markDiagnosticEmbeddedRunStarted({ ...ref, owner });
    expect(activityByRef.size).toBeGreaterThan(0);

    vi.setSystemTime(startedAt + TTL_MS + 60_000);
    probeLookup();

    expect(activityByRef.size).toBeGreaterThan(0);
    expect(resolveSessionActivity({ sessionId: ref.sessionId })).toBeDefined();
  });

  it("caps the retained activity set", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-10-20T00:00:00Z");
    vi.setSystemTime(startedAt);
    startDiagnosticRunActivityTracking();
    // Each run mints its own session identity, so each adds a distinct activity.
    for (let index = 0; index < 2_100; index++) {
      markDiagnosticRunProgress({
        sessionId: `run-${index}`,
        sessionKey: `agent:main:cron:job:run:${index}`,
        reason: "model_call:stream_progress",
      });
    }
    // The cap holds during normal operation, not only after an explicit prune.
    // An insertion may exceed the cap by one, exactly like the sibling session-state index.
    expect(new Set(activityByRef.values()).size).toBeLessThanOrEqual(2_001);

    probeLookup();

    expect(new Set(activityByRef.values()).size).toBeLessThanOrEqual(2_000);
  });

  it("does not accumulate stale id: aliases for one activity whose sessionKey stays stable across resets", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-10-20T00:00:00Z");
    vi.setSystemTime(startedAt);
    startDiagnosticRunActivityTracking();
    const sessionKey = "agent:main:cron:stable-key";
    // Same sessionKey, a fresh sessionId per reset - the pattern a long-lived Gateway
    // cron/boot/subagent identity produces on every re-arm.
    for (let index = 0; index < 500; index++) {
      vi.setSystemTime(startedAt + index * 1_000);
      markDiagnosticRunProgress({
        sessionId: `rotating-id-${index}`,
        sessionKey,
        reason: "model_call:stream_progress",
      });
    }
    const refs = [...activityByRef.keys()].filter(
      (ref) => ref === `key:${sessionKey}` || ref.startsWith("id:rotating-id-"),
    );
    // Only the current id: ref (plus the stable key: ref) should remain - not one per reset.
    expect(refs).toHaveLength(2);
    expect(activityByRef.has("key:" + sessionKey)).toBe(true);
    expect(activityByRef.has("id:rotating-id-499")).toBe(true);
    expect(activityByRef.has("id:rotating-id-0")).toBe(false);
  });

  it("keeps an activity with a pending recovery cutoff reachable past the idle ttl", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-10-20T00:00:00Z");
    vi.setSystemTime(startedAt);
    startDiagnosticRunActivityTracking();
    const ref = { sessionId: "cutoff-session", sessionKey: "agent:main:cutoff" };
    // Starting and closing an embedded run owner records a recovery cutoff for its runId,
    // which protects against a delayed/queued start event for that same run arriving late.
    for (let index = 0; index < 4; index++) {
      const runId = `cutoff-run-${index}`;
      const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
      markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
      closeDiagnosticEmbeddedRunOwner(owner);
    }
    const activity = resolveSessionActivity(ref);
    expect(activity?.recoveredOwnerStartEventCutoffs.size).toBeGreaterThan(0);

    vi.setSystemTime(startedAt + TTL_MS + 60_000);
    probeLookup();

    // A pending cutoff means a queued start for this owner can still arrive; releasing the
    // activity early would let it recreate a phantom activity with no cutoff on replay.
    expect(activityByRef.has("id:cutoff-session")).toBe(true);
    expect(activityByRef.has("key:agent:main:cutoff")).toBe(true);
  });

  it("keeps the old id: alias until a pending recovery cutoff drains", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-20T00:00:00Z"));
    startDiagnosticRunActivityTracking();
    const key = "agent:main:cron:fenced";
    const first = { sessionId: "old-id", sessionKey: key, runId: "fenced-run" };
    const owner = createDiagnosticEmbeddedRunOwner(first);
    markDiagnosticEmbeddedRunStarted({ ...first, owner });
    closeDiagnosticEmbeddedRunOwner(owner);
    const activity = resolveSessionActivity({ sessionKey: key });
    expect(activity?.recoveredOwnerStartEventCutoffs.size).toBeGreaterThan(0);

    markDiagnosticRunProgress({
      sessionId: "new-id",
      sessionKey: key,
      reason: "model_call:stream_progress",
    });

    // A queued id-only event for the old identity must still resolve to the fenced activity.
    expect(resolveSessionActivity({ sessionId: "old-id" })).toBe(activity);
    expect(activityByRef.has("id:new-id")).toBe(true);
  });

  it("does not rebuild the ref grouping on every lookup when nothing is reclaimable", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-20T00:00:00Z"));
    startDiagnosticRunActivityTracking();
    // 2_001 live activities, each with an id: and a key: ref, none of them evictable.
    for (let index = 0; index < 2_001; index++) {
      const ref = {
        sessionId: `live-${index}`,
        sessionKey: `agent:main:live:${index}`,
        runId: `live-run-${index}`,
      };
      markDiagnosticEmbeddedRunStarted({ ...ref, owner: createDiagnosticEmbeddedRunOwner(ref) });
    }
    expect(activityByRef.size).toBeGreaterThan(4_000);
    probeLookup();

    const iterate = vi.spyOn(activityByRef, Symbol.iterator);
    for (let index = 0; index < 50; index++) {
      probeLookup();
    }
    expect(iterate).not.toHaveBeenCalled();
  });
});
