import { describe, expect, it, beforeEach } from "vitest";
import {
  recordOagIncident,
  collectActiveIncidents,
  clearActiveIncidents,
} from "./oag-incident-collector.js";

describe("oag-incident-collector", () => {
  beforeEach(() => {
    clearActiveIncidents();
  });

  it("records a new incident", () => {
    recordOagIncident({ type: "channel_crash_loop", channel: "telegram", detail: "ETIMEDOUT" });
    const incidents = collectActiveIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].type).toBe("channel_crash_loop");
    expect(incidents[0].count).toBe(1);
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

  it("evicts oldest incident when exceeding 100 limit", () => {
    for (let i = 0; i < 105; i++) {
      recordOagIncident({
        type: "stale_detection",
        channel: `ch-${i}`,
        detail: `incident ${i}`,
      });
    }
    const incidents = collectActiveIncidents();
    expect(incidents.length).toBeLessThanOrEqual(100);
  });
});
