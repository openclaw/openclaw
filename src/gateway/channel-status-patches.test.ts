import { describe, expect, it } from "vitest";
import { createConnectedChannelStatusPatch } from "./channel-status-patches.js";

describe("createConnectedChannelStatusPatch", () => {
  it("uses one timestamp for connected event-liveness state", () => {
    expect(createConnectedChannelStatusPatch(1234)).toEqual({
      connected: true,
      lastConnectedAt: 1234,
      lastEventAt: 1234,
    });
  });
});
