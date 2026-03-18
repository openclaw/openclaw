import { describe, expect, it, vi, beforeEach } from "vitest";

const mockEmitOagEvent = vi.fn();
vi.mock("./oag-event-bus.js", () => ({
  emitOagEvent: (...args: unknown[]) => mockEmitOagEvent(...args),
}));

const { recordOagIncident, collectActiveIncidents, clearActiveIncidents, resolveIncidentOutcome } =
  await import("./oag-incident-collector.js");

describe("oag-incident-collector", () => {
  beforeEach(() => {
    clearActiveIncidents();
    mockEmitOagEvent.mockClear();
  });

  it("records a new incident", () => {
    recordOagIncident({ type: "channel_crash_loop", channel: "telegram", detail: "ETIMEDOUT" });
    const incidents = collectActiveIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].type).toBe("channel_crash_loop");
    expect(incidents[0].count).toBe(1);
  });

  it("emits incident_recorded event after recording", () => {
    recordOagIncident({ type: "channel_crash_loop", channel: "telegram", detail: "ETIMEDOUT" });
    expect(mockEmitOagEvent).toHaveBeenCalledWith("incident_recorded", {
      type: "channel_crash_loop",
      channel: "telegram",
      detail: "ETIMEDOUT",
    });
  });

  it("increments count for duplicate incidents", () => {
    recordOagIncident({ type: "channel_crash_loop", channel: "telegram", detail: "first" });
    recordOagIncident({ type: "channel_crash_loop", channel: "telegram", detail: "second" });
    const incidents = collectActiveIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].count).toBe(2);
    expect(incidents[0].detail).toBe("second");
  });

  it("tracks different channels separately", () => {
    recordOagIncident({ type: "channel_crash_loop", channel: "telegram", detail: "t" });
    recordOagIncident({ type: "channel_crash_loop", channel: "discord", detail: "d" });
    expect(collectActiveIncidents()).toHaveLength(2);
  });

  it("clears all incidents", () => {
    recordOagIncident({ type: "stale_detection", channel: "slack", detail: "stale" });
    clearActiveIncidents();
    expect(collectActiveIncidents()).toHaveLength(0);
  });

  it("evicts oldest incident when exceeding 1000 limit", () => {
    for (let i = 0; i < 1005; i++) {
      recordOagIncident({
        type: "stale_detection",
        channel: `ch-${i}`,
        detail: `incident ${i}`,
      });
    }
    const incidents = collectActiveIncidents();
    expect(incidents.length).toBeLessThanOrEqual(1000);
  });

  it("stores lastError field on new incident", () => {
    recordOagIncident({
      type: "channel_crash_loop",
      channel: "telegram",
      detail: "restart",
      lastError: "ETIMEDOUT 10.0.0.1:443",
    });
    const incidents = collectActiveIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].lastError).toBe("ETIMEDOUT 10.0.0.1:443");
  });

  it("updates lastError on duplicate incident", () => {
    recordOagIncident({
      type: "channel_crash_loop",
      channel: "telegram",
      detail: "first",
      lastError: "error-1",
    });
    recordOagIncident({
      type: "channel_crash_loop",
      channel: "telegram",
      detail: "second",
      lastError: "error-2",
    });
    const incidents = collectActiveIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].lastError).toBe("error-2");
  });

  it("resolveIncidentOutcome updates recovery time on existing incident", () => {
    recordOagIncident({
      type: "channel_crash_loop",
      channel: "telegram",
      detail: "restart",
    });
    resolveIncidentOutcome("channel_crash_loop:telegram", 1500);
    const incidents = collectActiveIncidents();
    expect(incidents[0].recoveryMs).toBe(1500);
    expect(incidents[0].resolvedAt).toBeTypeOf("string");
  });

  it("resolveIncidentOutcome is a no-op for unknown keys", () => {
    // Should not throw
    resolveIncidentOutcome("nonexistent:key", 500);
    expect(collectActiveIncidents()).toHaveLength(0);
  });

  it("classifies incident as false positive when recoveryMs < 30s", () => {
    recordOagIncident({
      type: "channel_crash_loop",
      channel: "telegram",
      detail: "restart",
    });
    resolveIncidentOutcome("channel_crash_loop:telegram", 5_000);
    const incidents = collectActiveIncidents();
    // recoveryMs < 30_000 means false positive
    expect(incidents[0].recoveryMs).toBeLessThan(30_000);
  });
});
