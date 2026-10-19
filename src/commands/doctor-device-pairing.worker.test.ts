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
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectDevicePairingHealthFindings } from "./doctor-device-pairing.js";

afterEach(() => vi.restoreAllMocks());

it("creates and reads the token inventory off the host, preserving role order and valid rows", async () => {
  await withOpenClawTestState({ label: "doctor-token-inventory" }, async (state) => {
    const coldSql = observeMainThreadSql({ includeClose: true });
    try {
      expect(await loadDeviceAuthTokens({ deviceId: "synthetic-device", env: state.env })).toEqual(
        [],
      );
      coldSql.expectIdle();
    } finally {
      coldSql.restore();
      await closeOpenClawStateDatabaseAsync();
    }
    expect((await fs.stat(state.statePath("state", "openclaw.sqlite"))).isFile()).toBe(true);
    const operator = seedDeviceAuthToken({
      deviceId: "synthetic-device",
      role: " operator ",
      token: "synthetic-operator-token",
      scopes: ["operator.write", " operator.read ", "operator.read"],
      updatedAtMs: 20,
      env: state.env,
    });
    const node = seedDeviceAuthToken({
      deviceId: "synthetic-device",
      role: "node",
      token: "synthetic-node-token",
      updatedAtMs: 10,
      env: state.env,
    });
    seedDeviceAuthToken({
      deviceId: "another-device",
      role: "operator",
      token: "synthetic-other-token",
      env: state.env,
    });
    openOpenClawStateDatabase({ env: state.env })
      .db.prepare(
        "INSERT INTO device_auth_tokens (device_id, role, token, scopes_json, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
      )
      .run("synthetic-device", "malformed", "synthetic-malformed-token", "not-json", 1);
    await closeOpenClawStateDatabaseAsync();
    const reopenedSql = observeMainThreadSql({ includeClose: true });
    try {
      const input = { deviceId: "synthetic-device", env: { ...state.env } };
      const inventory = loadDeviceAuthTokens(input);
      input.deviceId = "another-device";
      input.env.OPENCLAW_STATE_DIR = state.path("changed-target");
      expect(await inventory).toEqual([node, operator]);
      await closeOpenClawStateDatabaseAsync();
      reopenedSql.expectIdle();
      await expect(fs.stat(state.path("changed-target"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      reopenedSql.restore();
    }
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
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      const findings = await collectDevicePairingHealthFindings({
        cfg: { gateway: { mode: "local" } },
        env: { ...state.env, OPENCLAW_STATE_DIR: sourceDir },
      });
      expect(findings.map(({ requirement }) => requirement)).toEqual([
        "device-auth-store-legacy-file",
        "local-token-stale",
      ]);
      expect(JSON.stringify(findings)).not.toContain("synthetic-stale-token");
      expect(prepare.mock.calls.filter(([sql]) => sql.includes('"device_auth_tokens"'))).toEqual(
        [],
      );
    } finally {
      prepare.mockRestore();
    }
  });
});
