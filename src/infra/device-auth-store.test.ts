import { describe, expect, it, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  clearDeviceAuthToken,
  loadDeviceAuthStore,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from "./device-auth-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

function createEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  };
}

type DeviceAuthTestDatabase = Pick<OpenClawStateKyselyDatabase, "device_auth_tokens">;

describe("infra/device-auth-store", () => {
  it("stores and loads device auth tokens under the configured state dir", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      vi.spyOn(Date, "now").mockReturnValue(1234);

      const entry = storeDeviceAuthToken({
        deviceId: "device-1",
        role: " operator ",
        token: "secret",
        scopes: [" operator.write ", "operator.read", "operator.read"],
        env: createEnv(stateDir),
      });

      expect(entry).toEqual({
        token: "secret",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        updatedAtMs: 1234,
      });
      expect(
        loadDeviceAuthToken({
          deviceId: "device-1",
          role: "operator",
          env: createEnv(stateDir),
        }),
      ).toEqual(entry);

      expect(loadDeviceAuthStore({ env: createEnv(stateDir) })).toEqual({
        version: 1,
        deviceId: "device-1",
        tokens: {
          operator: entry,
        },
      });
    });
  });

  it("returns null for missing or mismatched token rows", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();

      const database = openOpenClawStateDatabase({ env });
      const db = getNodeSqliteKysely<DeviceAuthTestDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db.insertInto("device_auth_tokens").values({
          device_id: "device-2",
          role: "operator",
          token: "x",
          scopes_json: "[]",
          updated_at_ms: 1,
        }),
      );
      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();
    });
  });

  it("stores one device token without deleting other devices", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);

      storeDeviceAuthToken({
        deviceId: "device-2",
        role: "operator",
        token: "device-2-token",
        env,
      });
      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "device-1-token",
        env,
      });

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toMatchObject({
        token: "device-1-token",
      });
      expect(loadDeviceAuthToken({ deviceId: "device-2", role: "operator", env })).toMatchObject({
        token: "device-2-token",
      });
    });
  });

  it("clears only the requested role and leaves unrelated tokens intact", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);

      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "operator-token",
        env,
      });
      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "node",
        token: "node-token",
        env,
      });

      clearDeviceAuthToken({
        deviceId: "device-1",
        role: " operator ",
        env,
      });

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();
      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "node", env })?.token).toBe(
        "node-token",
      );
    });
  });

  it("updates retained token rows while pruning removed roles", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);

      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "operator-token",
        env,
      });
      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "node",
        token: "node-token",
        env,
      });

      clearDeviceAuthToken({
        deviceId: "device-1",
        role: "node",
        env,
      });
      storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "operator-token-2",
        env,
      });

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "node", env })).toBeNull();
      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toMatchObject({
        token: "operator-token-2",
      });
    });
  });
});
