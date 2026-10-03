import { describe, expect, it } from "vitest";
import { resolveHeartbeatVisibility } from "./heartbeat-visibility.js";

describe("historical heartbeat reporting visibility", () => {
  it("keeps ACKs hidden without reading retired channel configuration", () => {
    expect(resolveHeartbeatVisibility({ cfg: {}, channel: "webchat" })).toEqual({
      showOk: false,
      showAlerts: true,
      useIndicator: true,
    });
  });
});
