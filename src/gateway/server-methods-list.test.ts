import { describe, expect, it } from "vitest";
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js";

describe("GATEWAY_EVENTS", () => {
  it("advertises Talk event streams in hello features", () => {
    expect(GATEWAY_EVENTS).toEqual(
      expect.arrayContaining(["talk.event", "talk.realtime.relay", "talk.transcription.relay"]),
    );
  });
});

describe("listGatewayMethods", () => {
  it("advertises the versioned Talk session RPCs", () => {
    expect(listGatewayMethods()).toEqual(
      expect.arrayContaining([
        "talk.session.create",
        "talk.session.inputAudio",
        "talk.session.control",
        "talk.session.toolResult",
        "talk.session.close",
      ]),
    );
  });
});
