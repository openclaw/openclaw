import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { commandFixture } from "./session-share.test-support.js";

it("rejects profile-shaped synthetic clients without host-attested device admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = commandFixture();
    fixture.select({
      groups: ["Team"],
      involvingProfileId: "person",
      gateway: true,
      gatewayDeviceIds: ["reader"],
    });
    const respond = vi.fn();
    await fixture.gatewayHandlers["session-share.list"]!({
      req: { method: "session-share.list" },
      params: {},
      context: {},
      respond,
      hasCurrentClientAuthority: () => true,
      client: { preparedSessionProfile: { profileId: "person", aliases: new Set(["person"]) } },
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
      undefined,
    );
  });
});
