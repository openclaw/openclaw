// Covers SQLite-backed device auth token storage and clearing.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  clearDeviceAuthToken,
  clearOriginDeviceToken,
  loadDeviceAuthToken,
  loadDeviceAuthTokenReadOnly,
  loadDeviceAuthTokens,
  loadOriginDeviceToken,
  loadOriginDeviceTokenReadOnly,
  storeDeviceAuthToken,
  storeOriginDeviceToken,
} from "./device-auth-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

function createEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  };
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
});

describe("infra/device-auth-store", () => {
  it("reads no device auth and creates no database when shared state is absent", async () => {
    await withTempDir("openclaw-device-auth-readonly-missing-", async (stateDir) => {
      const env = createEnv(stateDir);
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");

      expect(
        await loadDeviceAuthTokenReadOnly({ deviceId: "device-1", role: "operator", env }),
      ).toBeNull();
      expect(
        await loadOriginDeviceTokenReadOnly({
          gatewayScope: "wss://one.example",
          deviceId: "device-1",
          role: "operator",
          env,
        }),
      ).toBeNull();
      expect(fs.existsSync(databasePath)).toBe(false);
    });
  });

  it("reads existing device auth without opening writable shared state", async () => {
    await withTempDir("openclaw-device-auth-readonly-", async (stateDir) => {
      const env = createEnv(stateDir);
      await storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "local-token",
        env,
      });
      await storeOriginDeviceToken({
        gatewayScope: "wss://one.example",
        deviceId: "device-1",
        role: "operator",
        token: "origin-token",
        env,
      });
      await closeOpenClawStateDatabaseAsync();
      const databaseDirectory = path.dirname(path.join(stateDir, "state", "openclaw.sqlite"));
      const artifactsBeforeRead = fs.readdirSync(databaseDirectory).toSorted();

      expect(
        (await loadDeviceAuthTokenReadOnly({ deviceId: "device-1", role: "operator", env }))?.token,
      ).toBe("local-token");
      expect(
        (
          await loadOriginDeviceTokenReadOnly({
            gatewayScope: "wss://one.example",
            deviceId: "device-1",
            role: "operator",
            env,
          })
        )?.token,
      ).toBe("origin-token");
      expect(fs.readdirSync(databaseDirectory).toSorted()).toEqual(artifactsBeforeRead);
    });
  });

  it("never exposes a device token to a different gateway origin", async () => {
    await withTempDir("openclaw-device-auth-origin-", async (stateDir) => {
      const env = createEnv(stateDir);
      await storeOriginDeviceToken({
        gatewayScope: "wss://one.example/rpc",
        deviceId: "device-1",
        role: "operator",
        token: "origin-one-token",
        env,
      });

      expect(
        await loadOriginDeviceToken({
          gatewayScope: "wss://two.example/rpc",
          deviceId: "device-1",
          role: "operator",
          env,
        }),
      ).toBeNull();
      await clearOriginDeviceToken({
        gatewayScope: "wss://two.example/rpc",
        deviceId: "device-1",
        role: "operator",
        env,
      });
      expect(
        (
          await loadOriginDeviceToken({
            gatewayScope: "wss://one.example/rpc",
            deviceId: "device-1",
            role: "operator",
            env,
          })
        )?.token,
      ).toBe("origin-one-token");
    });
  });

  it("upserts and clears only the exact origin, device, and normalized role", async () => {
    await withTempDir("openclaw-device-auth-origin-", async (stateDir) => {
      const env = createEnv(stateDir);
      await storeOriginDeviceToken({
        gatewayScope: "wss://one.example",
        deviceId: "device-1",
        role: " operator ",
        token: "old-token",
        scopes: [" operator.write ", "operator.read", "operator.read"],
        env,
      });
      const replacement = await storeOriginDeviceToken({
        gatewayScope: "wss://one.example",
        deviceId: "device-1",
        role: "operator",
        token: "new-token",
        scopes: ["operator.pairing"],
        env,
      });
      await storeOriginDeviceToken({
        gatewayScope: "wss://two.example",
        deviceId: "device-1",
        role: "operator",
        token: "other-origin-token",
        env,
      });

      expect(replacement).toEqual({
        token: "new-token",
        role: "operator",
        scopes: ["operator.pairing"],
        updatedAtMs: expect.any(Number),
      });
      await clearOriginDeviceToken({
        gatewayScope: "wss://one.example",
        deviceId: "device-1",
        role: " operator ",
        env,
      });
      expect(
        await loadOriginDeviceToken({
          gatewayScope: "wss://one.example",
          deviceId: "device-1",
          role: "operator",
          env,
        }),
      ).toBeNull();
      expect(
        (
          await loadOriginDeviceToken({
            gatewayScope: "wss://two.example",
            deviceId: "device-1",
            role: "operator",
            env,
          })
        )?.token,
      ).toBe("other-origin-token");
    });
  });

  it("stores and loads normalized device auth tokens in SQLite", async () => {
    await withOpenClawTestState({ label: "device-auth" }, async ({ stateDir, env }) => {
      vi.spyOn(Date, "now").mockReturnValue(1234);

      const entry = await storeDeviceAuthToken({
        deviceId: "device-1",
        role: " operator ",
        token: "secret",
        scopes: [" operator.write ", "operator.read", "operator.read"],
        env,
      });

      expect(entry).toEqual({
        token: "secret",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        updatedAtMs: 1234,
      });
      expect(await loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toEqual(
        entry,
      );
      expect(await loadDeviceAuthTokens({ deviceId: "device-1", env })).toEqual([entry]);
      expect(fs.existsSync(path.join(stateDir, "identity", "device-auth.json"))).toBe(false);
    });
  });

  it("isolates device ids and overwrites only the normalized role", async () => {
    await withOpenClawTestState({ label: "device-auth" }, async ({ env }) => {
      vi.spyOn(Date, "now").mockReturnValueOnce(1).mockReturnValueOnce(2).mockReturnValueOnce(3);

      await storeDeviceAuthToken({ deviceId: "device-1", role: "node", token: "node", env });
      await storeDeviceAuthToken({ deviceId: "device-2", role: "operator", token: "other", env });
      const replacement = await storeDeviceAuthToken({
        deviceId: "device-1",
        role: " operator ",
        token: "replacement",
        scopes: ["operator.admin"],
        env,
      });

      expect(await loadDeviceAuthTokens({ deviceId: "device-1", env })).toEqual([
        { token: "node", role: "node", scopes: [], updatedAtMs: 1 },
        replacement,
      ]);
      expect(
        (await loadDeviceAuthToken({ deviceId: "device-2", role: "operator", env }))?.token,
      ).toBe("other");
    });
  });

  it("fails closed for malformed canonical scope metadata", async () => {
    await withOpenClawTestState({ label: "device-auth" }, async ({ env }) => {
      const { db } = openOpenClawStateDatabase({ env });
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<{
          device_auth_tokens: {
            device_id: string;
            role: string;
            token: string;
            scopes_json: string;
            updated_at_ms: number;
          };
        }>(db)
          .insertInto("device_auth_tokens")
          .values({
            device_id: "device-1",
            role: "operator",
            token: "secret",
            scopes_json: "not-json",
            updated_at_ms: 1,
          }),
      );

      expect(await loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();
      expect(await loadDeviceAuthTokens({ deviceId: "device-1", env })).toEqual([]);
    });
  });

  it("fails closed with repair guidance while retired JSON remains", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);
      const legacyPath = path.join(stateDir, "identity", "device-auth.json");
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(legacyPath, '{"version":1}');
      openOpenClawStateDatabase({ env })
        .db.prepare(
          "INSERT INTO device_auth_tokens (device_id, role, token, scopes_json, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
        )
        .run("device-1", "operator", "sqlite-token", "[]", 1);
      openOpenClawStateDatabase({ env }).db.exec("DROP TABLE gateway_origin_device_tokens;");

      await expect(
        async () => await loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env }),
      ).rejects.toThrow("openclaw doctor --fix");
      await expect(
        async () =>
          await storeDeviceAuthToken({
            deviceId: "device-1",
            role: "operator",
            token: "replacement",
            env,
          }),
      ).rejects.toThrow("openclaw doctor --fix");
      await expect(
        async () =>
          await loadOriginDeviceToken({
            gatewayScope: "wss://one.example",
            deviceId: "device-1",
            role: "operator",
            env,
          }),
      ).rejects.toThrow("openclaw doctor --fix");
      await expect(
        async () =>
          await storeOriginDeviceToken({
            gatewayScope: "wss://one.example",
            deviceId: "device-1",
            role: "operator",
            token: "origin-token",
            env,
          }),
      ).rejects.toThrow("openclaw doctor --fix");
      await expect(
        async () =>
          await clearOriginDeviceToken({
            gatewayScope: "wss://one.example",
            deviceId: "device-1",
            role: "operator",
            env,
          }),
      ).rejects.toThrow("openclaw doctor --fix");
      expect(
        openOpenClawStateDatabase({ env })
          .db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get("gateway_origin_device_tokens"),
      ).toBeUndefined();
    });
  });

  it("clears only the requested role and device", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);
      await storeDeviceAuthToken({
        deviceId: "device-1",
        role: "operator",
        token: "operator",
        env,
      });
      await storeDeviceAuthToken({ deviceId: "device-1", role: "node", token: "node", env });
      await storeDeviceAuthToken({ deviceId: "device-2", role: "operator", token: "other", env });

      await clearDeviceAuthToken({ deviceId: "device-1", role: " operator ", env });

      expect(await loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();
      expect((await loadDeviceAuthToken({ deviceId: "device-1", role: "node", env }))?.token).toBe(
        "node",
      );
      expect(
        (await loadDeviceAuthToken({ deviceId: "device-2", role: "operator", env }))?.token,
      ).toBe("other");
    });
  });

  it("keeps credentials rotated after a stale request snapshot", async () => {
    await withTempDir("openclaw-device-auth-rotation-", async (stateDir) => {
      const env = createEnv(stateDir);
      const targets = [
        {
          name: "device",
          load: async () =>
            await loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env }),
          store: async (token: string, expectedToken?: string | null) =>
            await storeDeviceAuthToken({
              deviceId: "device-1",
              role: "operator",
              token,
              scopes: ["operator.read"],
              env,
              ...(expectedToken === undefined ? {} : { expectedToken }),
            }),
          clear: async (expectedToken: string) =>
            await clearDeviceAuthToken({
              deviceId: "device-1",
              role: "operator",
              env,
              expectedToken,
            }),
        },
        {
          name: "origin",
          load: async () =>
            await loadOriginDeviceToken({
              gatewayScope: "wss://one.example",
              deviceId: "device-1",
              role: "operator",
              env,
            }),
          store: async (token: string, expectedToken?: string | null) =>
            await storeOriginDeviceToken({
              gatewayScope: "wss://one.example",
              deviceId: "device-1",
              role: "operator",
              token,
              scopes: ["operator.read"],
              env,
              ...(expectedToken === undefined ? {} : { expectedToken }),
            }),
          clear: async (expectedToken: string) =>
            await clearOriginDeviceToken({
              gatewayScope: "wss://one.example",
              deviceId: "device-1",
              role: "operator",
              env,
              expectedToken,
            }),
        },
      ];

      for (const target of targets) {
        const prepared = await target.store(`${target.name}-prepared`, null);
        expect(prepared).not.toBeNull();
        expect(await target.store(`${target.name}-stale-insert`, null)).toBeNull();
        expect(await target.load()).toEqual(prepared);
        const rotated = await target.store(`${target.name}-rotated`);
        expect(rotated).not.toBeNull();

        expect(await target.store(`${target.name}-stale-replacement`, prepared!.token)).toBeNull();
        expect(await target.clear(prepared!.token)).toBe(false);
        expect(await target.load()).toEqual(rotated);
      }
    });
  });
});
