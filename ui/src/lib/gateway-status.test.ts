// @vitest-environment node
import { expect, it } from "vitest";
import {
  resolveGatewayStatus,
  type GatewayStatus,
  type GatewayStatusSnapshot,
} from "./gateway-status.ts";

it("resolves lifecycle precedence, offline grace, and read recovery", () => {
  const connected: GatewayStatusSnapshot = {
    phase: "connected",
    offlineStable: false,
    client: { recoveryScopeReady: true },
  };
  const cases: Array<
    [
      snapshot: Partial<GatewayStatusSnapshot>,
      expected: GatewayStatus | null,
      refreshRequired?: boolean,
      historyRecovering?: boolean,
    ]
  > = [
    [{ restartPending: true, suspensionPhase: "prepared" }, "reload-required", true],
    [{ phase: "reload-required", restartPending: true }, "reload-required"],
    [{ phase: "starting", restartPending: true, suspensionPhase: "prepared" }, "restarting"],
    [{ suspensionPhase: "preparing" }, "suspending"],
    [{ phase: "reconnecting", offlineStable: true, suspensionPhase: "draining" }, "suspending"],
    [{ phase: "connecting", suspensionPhase: "prepared" }, "suspended"],
    [{ phase: "connecting", client: null }, "connecting"],
    [{ phase: "starting", client: null }, "starting"],
    [{ phase: "reconnecting", client: null }, null],
    [{ phase: "reconnecting", client: null, offlineStable: true }, "reconnecting"],
    [{ phase: "offline", client: null }, null],
    [{ phase: "offline", client: null, offlineStable: true }, "offline"],
    [{ phase: "stopped", client: null }, null],
    [{ phase: "stopped", client: null, offlineStable: true }, "offline"],
    [
      { offlineStable: true, suspensionPhase: "accepting", client: { recoveryScopeReady: false } },
      "restoring",
    ],
    [{ offlineStable: true, suspensionPhase: "accepting" }, null],
    [{}, "restoring", false, true],
    [{}, null, false, false],
    [{ phase: "reconnecting", offlineStable: true }, "reconnecting", false, true],
    [{ suspensionPhase: "prepared" }, "suspended", false, true],
    [{}, "reload-required", true, true],
    [{ client: null }, null],
  ];
  for (const [snapshot, expected, refresh, recovering] of cases) {
    expect(
      resolveGatewayStatus({ ...connected, ...snapshot }, refresh, recovering),
      JSON.stringify([snapshot, refresh, recovering]),
    ).toBe(expected);
  }
});
