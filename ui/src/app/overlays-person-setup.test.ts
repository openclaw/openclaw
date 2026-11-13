// @vitest-environment node
import { expect, it, vi } from "vitest";
import { client, createGatewayHarness, type RequestFn } from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

it("requires explicit authenticated admin scopes for personal setup, not legacy maintenance access", async () => {
  const request = vi.fn<RequestFn>(async (method) =>
    method === "device.pair.setupCode"
      ? {
          setupId: "synthetic",
          setupCode: "synthetic-not-a-credential",
          expiresAtMs: Date.now() + 60_000,
        }
      : { pending: [] },
  );
  const harness = createGatewayHarness(client(request));
  const overlays = createApplicationOverlays(harness.gateway);
  try {
    expect(await overlays.openDevicePairSetup()).toBe(true);
    await overlays.refreshDevicePairSetup({ profileId: "person-existing" });
    expect(
      request.mock.calls.filter(([method]) => method === "device.pair.setupCode"),
    ).toHaveLength(0);
    harness.setScopes(["operator.admin"]);
    await overlays.openDevicePairSetup();
    await overlays.setDevicePairSetupAccess("limited");
    await overlays.refreshDevicePairSetup({ profileId: "person-existing" });
    expect(request.mock.calls.find(([method]) => method === "device.pair.setupCode")?.[1]).toEqual({
      bootstrapProfile: "limited",
      profileId: "person-existing",
    });
    expect(overlays.snapshot.devicePairSetupPerson).toEqual({ profileId: "person-existing" });
    harness.setScopes(["operator.read"]);
    expect(overlays.snapshot.devicePairSetupOpen).toBe(false);
    expect(overlays.snapshot.devicePairSetupPerson).toBeNull();
  } finally {
    overlays.dispose();
  }
});
