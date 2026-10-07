import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearOpenClawStateDatabaseOpenFailure } from "../state/openclaw-state-db-cache.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import * as workerStore from "../state/openclaw-state-worker-store.js";
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
import * as tokens from "./device-auth-store.js";
import { storeDeviceAuthTokenInDatabase } from "./device-auth-store.kernel.js";
import { observeDeviceAuthHostSql } from "./device-auth-store.sql.test-support.js";
import { holdDeviceAuthWriterForTest } from "./device-auth-store.test-support.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import * as mutationAdmission from "./sqlite-worker-operation-admission.js";

const deviceTarget = { deviceId: "device-1", role: "operator" };

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
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const bytesBeforeRead = fs.readFileSync(databasePath);

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
      expect(fs.readFileSync(databasePath)).toEqual(bytesBeforeRead);
      expect(fs.statSync(`${databasePath}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0);
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
        ...deviceTarget,
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

  it("keeps cold, warm, read-only, ordered token-data operations and cleanup off the host SQLite thread", async () => {
    await withOpenClawTestState({ label: "device-token-worker" }, async (state) => {
      const lookup = { deviceId: "synthetic-device", role: "operator", env: state.env };
      const origin = { ...lookup, gatewayScope: "wss://synthetic.example/rpc" };
      const sql = observeDeviceAuthHostSql(state.statePath("state", "openclaw.sqlite"));
      try {
        expect(await tokens.loadDeviceAuthTokenReadOnly(lookup)).toBeNull();
        expect(await tokens.loadOriginDeviceTokenReadOnly(origin)).toBeNull();
        await expect(fsp.stat(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        const input = {
          ...lookup,
          env: { ...state.env },
          token: "synthetic-first",
          scopes: [" operator.read ", "operator.read"],
        };
        const first = tokens.storeDeviceAuthToken(input);
        input.deviceId = "changed-device";
        input.env.OPENCLAW_STATE_DIR = state.path("changed-state");
        input.scopes.push("operator.admin");
        expect(await first).toMatchObject({ token: "synthetic-first", scopes: ["operator.read"] });
        const operations = [
          tokens.storeDeviceAuthToken({
            ...lookup,
            token: "synthetic-second",
            expectedToken: "synthetic-first",
          }),
          tokens.loadDeviceAuthToken(lookup),
          tokens.clearDeviceAuthToken({ ...lookup, expectedToken: "synthetic-second" }),
          tokens.loadDeviceAuthToken(lookup),
        ];
        expect(await Promise.all(operations)).toEqual([
          expect.objectContaining({ token: "synthetic-second" }),
          expect.objectContaining({ token: "synthetic-second" }),
          true,
          null,
        ]);
        const stored = await tokens.storeOriginDeviceToken({
          ...origin,
          token: "synthetic-origin",
        });
        expect(await tokens.loadOriginDeviceToken(origin)).toEqual(stored);
        expect(
          await tokens.loadOriginDeviceToken({ ...origin, gatewayScope: "wss://other.example" }),
        ).toBeNull();
        await closeOpenClawStateDatabaseAsync();
        const artifacts = (await fsp.readdir(state.statePath("state"))).toSorted();
        expect(await tokens.loadOriginDeviceTokenReadOnly(origin)).toEqual(stored);
        await closeOpenClawStateDatabaseAsync();
        expect((await fsp.readdir(state.statePath("state"))).toSorted()).toEqual(artifacts);
        expect(await tokens.clearOriginDeviceToken(origin)).toBe(true);
        await closeOpenClawStateDatabaseAsync();
        expect(Object.values(sql.counts().data)).toEqual(Array(7).fill(0));
        expect(Object.values(sql.counts().unknown)).toEqual(Array(7).fill(0));
        await expect(fsp.stat(state.path("changed-state"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        sql.restore();
        await closeOpenClawStateDatabaseAsync();
      }
    });
  });

  it("rejects canceled loads, retired sources and expired schema scopes without publishing observations", async () => {
    await withOpenClawTestState({ label: "device-token-admission" }, async (state) => {
      const lookup = { deviceId: "synthetic-device", role: "operator", env: state.env };
      await tokens.storeDeviceAuthToken({ ...lookup, token: "synthetic-stored" });
      const onSnapshot = vi.fn();
      const controller = new AbortController();
      const canceled = tokens.loadDeviceAuthToken({
        ...lookup,
        onSnapshot,
        signal: controller.signal,
      });
      controller.abort(new Error("synthetic-cancel"));
      await expect(canceled).rejects.toThrow("synthetic-cancel");
      const retired = tokens.loadDeviceAuthToken({ ...lookup, onSnapshot });
      clearOpenClawStateDatabaseOpenFailure(state.statePath("state", "openclaw.sqlite"));
      await expect(retired).rejects.toThrow();
      await closeOpenClawStateDatabaseAsync();
      let expired: Promise<unknown> | undefined;
      withExistingOpenClawStateSchema({ path: state.statePath("state", "openclaw.sqlite") }, () => {
        expired = tokens.loadDeviceAuthToken({ ...lookup, onSnapshot });
      });
      assert(expired);
      await expect(expired).rejects.toThrow("admission has ended");
      expect(onSnapshot).not.toHaveBeenCalled();
    });
  });

  it("remains responsive and rechecks token mutation authority after waiting for a SQLite writer", async () => {
    await withOpenClawTestState({ label: "device-token-lock" }, async (state) => {
      const lookup = { deviceId: "synthetic-device", role: "operator", env: state.env };
      const stored = await tokens.storeDeviceAuthToken({ ...lookup, token: "synthetic-stored" });
      const release = await holdDeviceAuthWriterForTest(
        state.statePath("state", "openclaw.sqlite"),
      );
      try {
        let current = true;
        const guard = vi.fn(() => {
          if (!current) {
            throw new Error("synthetic-owner-retired");
          }
        });
        const mutation = tokens.storeDeviceAuthToken({
          ...lookup,
          token: "synthetic-replacement",
          assertCurrent: guard,
        });
        const result = expect(mutation).rejects.toThrow("synthetic-owner-retired");
        await vi.waitFor(() => expect(guard).toHaveBeenCalled());
        await delay(20);
        current = false;
        await release();
        await result;
        expect(await tokens.loadDeviceAuthToken(lookup)).toEqual(stored);
      } finally {
        await release();
      }
    });
  });

  it.each([
    { kind: "ordinary", action: "cancel" },
    { kind: "prepare", action: "retire" },
  ])("does not settle absent worker $kind after $action", async ({ kind, action }) => {
    await withOpenClawTestState({ label: "device-token-absent-admission" }, async (state) => {
      // An existing-only open can settle without dispatching the operation callback.
      vi.spyOn(workerStore, "runOpenClawStateWorkerOperation").mockResolvedValueOnce(undefined);
      const controller = new AbortController();
      let current = true;
      const onSnapshot = vi.fn();
      const input = {
        deviceId: "synthetic-device",
        role: "operator",
        env: state.env,
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("synthetic-retired");
          }
        },
        onSnapshot,
      };
      const reading =
        kind === "prepare"
          ? tokens.prepareDeviceAuthStore({ ...input, readOnly: true })
          : tokens.loadDeviceAuthTokenReadOnly(input);
      if (action === "cancel") {
        controller.abort(new Error("synthetic-canceled"));
      } else {
        current = false;
      }
      await expect(reading).rejects.toThrow(
        action === "cancel" ? "synthetic-canceled" : "synthetic-retired",
      );
      expect(onSnapshot).not.toHaveBeenCalled();
    });
  });

  it("retains host lifecycle custody while a native writer overlaps a token commit", async () => {
    await withOpenClawTestState({ label: "device-token-native-writer" }, async (state) => {
      const lookup = { deviceId: "synthetic-device", role: "operator", env: state.env };
      await tokens.storeDeviceAuthToken({ ...lookup, token: "synthetic-before" });
      const originalAdmission = mutationAdmission.createSqliteWorkerOperationAdmission;
      let nativeWriteStarted = false;
      vi.spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (admit, attachment) =>
          originalAdmission((request, grant) => {
            admit(request, grant);
            if (request.stage === "transaction" && !nativeWriteStarted) {
              nativeWriteStarted = true;
              runOpenClawStateWriteTransaction(
                ({ db }) => {
                  storeDeviceAuthTokenInDatabase(db, {
                    deviceId: "synthetic-native-device",
                    role: "operator",
                    token: "synthetic-native-token",
                  });
                },
                { env: state.env },
              );
            }
          }, attachment),
      );
      await expect(
        tokens.storeDeviceAuthToken({
          ...lookup,
          token: "synthetic-after",
          expectedToken: "synthetic-before",
        }),
      ).resolves.toMatchObject({ token: "synthetic-after" });
      expect(nativeWriteStarted).toBe(true);
      expect(await tokens.loadDeviceAuthToken(lookup)).toMatchObject({ token: "synthetic-after" });
      expect(
        await tokens.loadDeviceAuthToken({ ...lookup, deviceId: "synthetic-native-device" }),
      ).toMatchObject({ token: "synthetic-native-token" });
    });
  });

  it("does not deliver a token observation after source retirement", async () => {
    await withOpenClawTestState({ label: "device-token-observation-retirement" }, async (state) => {
      let retired = false;
      vi.spyOn(workerStore, "runOpenClawStateWorkerOperation").mockImplementationOnce(async () => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            clearOpenClawStateDatabaseOpenFailure(state.statePath("state", "openclaw.sqlite"));
            retired = true;
          });
        });
        return undefined;
      });
      const onSnapshot = vi.fn(() => retired);
      const input = {
        deviceId: "synthetic-device",
        role: "operator",
        env: state.env,
        onSnapshot,
      };
      const reading = tokens.loadOriginDeviceTokenReadOnly({
        ...input,
        gatewayScope: "wss://synthetic.example",
      });
      let rejection: unknown;
      await reading.catch((error: unknown) => {
        rejection = error;
      });
      expect(retired).toBe(true);
      expect(onSnapshot.mock.results.some((result) => result.value === true)).toBe(false);
      if (rejection === undefined) {
        expect(onSnapshot).toHaveBeenCalledOnce();
      } else {
        expect(rejection).toMatchObject({
          message: expect.stringContaining("read admission changed"),
        });
        expect(onSnapshot).not.toHaveBeenCalled();
      }
    });
  });
});
