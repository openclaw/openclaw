import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { prepareCliGatewayStateAccess } from "../cli/gateway-rpc.runtime.js";
import { getDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "../infra/database-engine/context.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGatewayCallDeviceAuth } from "./call-device-auth.js";

afterEach(() => {
  resetDatabaseEngineSelectionForTest();
  vi.restoreAllMocks();
});

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

it("selects CLI storage only when authentication needs local device state", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await state.writeConfig({
      database: {
        engine: "postgres",
        postgres: {
          connection: { source: "env", provider: "default", id: "OPENCLAW_TEST_MISSING_DSN" },
        },
      },
      plugins: { enabled: false },
    });
    delete process.env.OPENCLAW_TEST_MISSING_DSN;
    const opts = {
      clientName: "cli" as const,
      mode: "cli" as const,
      sharedStateMode: "read-only" as const,
      beforeDeviceIdentityLoad: prepareCliGatewayStateAccess,
    };
    expect(
      (
        await resolveGatewayCallDeviceAuth({
          opts,
          url: "ws://127.0.0.1:19083",
          authMode: "token",
          isImplicitLocalTarget: true,
          token: "synthetic-gateway-token",
        })
      ).deviceIdentity,
    ).toBeNull();
    expect(getDatabaseEngineSelection()).toBeUndefined();
    await expect(
      resolveGatewayCallDeviceAuth({
        opts,
        url: "wss://gateway.example.test",
        authMode: "token",
        isImplicitLocalTarget: false,
      }),
    ).rejects.toThrow("SecretRef is unresolved");
    await expect(fs.access(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
