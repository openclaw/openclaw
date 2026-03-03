import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../protocol/client-info.js";
import { resolvePostConnectHealthRefreshOptions } from "./post-connect-health.js";

describe("resolvePostConnectHealthRefreshOptions", () => {
  it("disables active probes for gateway CLI reconnects", () => {
    expect(
      resolvePostConnectHealthRefreshOptions({
        id: GATEWAY_CLIENT_IDS.CLI,
        version: "2026.3.3",
        platform: "linux",
        mode: GATEWAY_CLIENT_MODES.CLI,
      }),
    ).toEqual({ probe: false });
  });

  it("keeps active probes enabled for non-CLI clients", () => {
    expect(
      resolvePostConnectHealthRefreshOptions({
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        version: "2026.3.3",
        platform: "darwin",
        mode: GATEWAY_CLIENT_MODES.UI,
      }),
    ).toEqual({ probe: true });
  });
});
