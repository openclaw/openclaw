import { describe, expect, it } from "vitest";
import { isolateLiveGatewayConfig } from "./gateway-models.profiles.live.test-helpers.js";

describe("isolateLiveGatewayConfig", () => {
  it("disables independent session-observer model traffic", () => {
    expect(
      isolateLiveGatewayConfig({
        gateway: { controlUi: { enabled: false, sessionObserver: true } },
      }).gateway?.controlUi,
    ).toMatchObject({ enabled: false, sessionObserver: false });
  });
});
