// Node presence tests cover alive reason normalization for heartbeat metadata.
import { describe, expect, it } from "vitest";
import { NODE_PRESENCE_ALIVE_EVENT, normalizeNodePresenceAliveReason } from "./node-presence.js";

describe("NODE_PRESENCE_ALIVE_EVENT", () => {
  it("is the expected gateway event name", () => {
    expect(NODE_PRESENCE_ALIVE_EVENT).toBe("node.presence.alive");
  });
});

describe("normalizeNodePresenceAliveReason", () => {
  it("trims whitespace from input", () => {
    expect(normalizeNodePresenceAliveReason("  manual  ")).toBe("manual");
  });

  it("defaults to background for unknown values", () => {
    expect(normalizeNodePresenceAliveReason("unknown")).toBe("background");
    expect(normalizeNodePresenceAliveReason("")).toBe("background");
  });
});
