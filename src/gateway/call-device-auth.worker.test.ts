import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGatewayCallDeviceAuth } from "./call-device-auth.js";

afterEach(() => vi.restoreAllMocks());

it("admits call identities off the caller thread without creating them for read-only calls", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    const target = {
      url: "wss://gateway.example.test",
      authMode: "token" as const,
      isImplicitLocalTarget: false,
    };
    expect(
      (await resolveGatewayCallDeviceAuth({ ...target, opts: { sharedStateMode: "read-only" } }))
        .deviceIdentity,
    ).toBeNull();
    const created = await resolveGatewayCallDeviceAuth({ ...target, opts: {} });
    expect(created.deviceIdentity?.deviceId).toMatch(/^[a-f0-9]{64}$/);
    const existing = await resolveGatewayCallDeviceAuth({
      ...target,
      opts: { sharedStateMode: "read-only" },
    });
    expect(existing.deviceIdentity).toEqual(created.deviceIdentity);
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
