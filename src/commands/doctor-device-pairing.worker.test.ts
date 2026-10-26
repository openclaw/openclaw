import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { loadDeviceAuthTokens } from "../infra/device-auth-store.js";
import { seedDeviceAuthToken } from "../infra/device-auth-store.test-support.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectDevicePairingHealthFindings } from "./doctor-device-pairing.js";

afterEach(() => vi.restoreAllMocks());

async function offHost(run: () => Promise<void>) {
  const sql = observeMainThreadSql({ includeClose: true });
  try {
    await run();
    sql.expectIdle();
  } finally {
    sql.restore();
  }
}

it("reads token inventories off-host without creating storage or retaining mutable selectors", async () => {
  await withOpenClawTestState({ label: "doctor-token-inventory" }, async (state) => {
    await offHost(async () => {
      expect(await loadDeviceAuthTokens({ deviceId: "synthetic-device", env: state.env })).toEqual(
        [],
      );
    });
    await closeOpenClawStateDatabaseAsync();
    await expect(fs.stat(state.statePath("client", "credentials.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const operator = seedDeviceAuthToken({
      deviceId: "synthetic-device",
      role: "operator",
      token: "synthetic-operator-token",
      env: state.env,
    });
    await closeOpenClawStateDatabaseAsync();
    await offHost(async () => {
      const input = { deviceId: "synthetic-device", env: { ...state.env } };
      const inventory = loadDeviceAuthTokens(input);
      input.deviceId = "another-device";
      input.env.OPENCLAW_STATE_DIR = state.path("changed-target");
      expect(await inventory).toEqual([operator]);
      await closeOpenClawStateDatabaseAsync();
      await expect(fs.stat(state.path("changed-target"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

it("detects stale local tokens from the active state view while checking legacy files at the source", async () => {
  await withOpenClawTestState({ label: "doctor-token-active-view" }, async (state) => {
    const identity = loadOrCreateDeviceIdentity();
    const pairing = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      role: "operator",
      scopes: ["operator.read"],
    });
    await approveDevicePairing(pairing.request.requestId, { callerScopes: ["operator.read"] });
    seedDeviceAuthToken({
      deviceId: identity.deviceId,
      role: "operator",
      token: "synthetic-stale-token",
      scopes: ["operator.read"],
      updatedAtMs: 1,
    });
    const sourceDir = state.path("source-state");
    await fs.mkdir(`${sourceDir}/identity`, { recursive: true });
    await fs.writeFile(`${sourceDir}/identity/device-auth.json`, '{"version":1}');
    using prepare = vi.spyOn(DatabaseSync.prototype, "prepare");

    const findings = await collectDevicePairingHealthFindings({
      cfg: { gateway: { mode: "local" } },
      env: { ...state.env, OPENCLAW_STATE_DIR: sourceDir },
    });
    expect(findings.map(({ requirement }) => requirement)).toEqual([
      "device-auth-store-legacy-file",
      "local-token-stale",
    ]);
    expect(JSON.stringify(findings)).not.toContain("synthetic-stale-token");
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('"device_auth_tokens"'))).toEqual([]);
  });
});
