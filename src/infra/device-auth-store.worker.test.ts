import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { clearOpenClawStateDatabaseOpenFailure } from "../state/openclaw-state-db-cache.js";
import { withExistingOpenClawStateSchema } from "../state/openclaw-state-db-schema-policy.js";
import {
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import * as workerStore from "../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as tokens from "./device-auth-store.js";
import { storeDeviceAuthTokenInDatabase } from "./device-auth-store.kernel.js";
import { observeDeviceAuthHostSql } from "./device-auth-store.sql.test-support.js";
import { holdDeviceAuthWriterForTest } from "./device-auth-store.test-support.js";
import * as mutationAdmission from "./sqlite-worker-operation-admission.js";

afterEach(() => vi.restoreAllMocks());

it("keeps cold, warm, read-only, ordered token-data operations and cleanup off the host SQLite thread", async () => {
  await withOpenClawTestState({ label: "device-token-worker" }, async (state) => {
    const lookup = { deviceId: "synthetic-device", role: "operator", env: state.env };
    const origin = { ...lookup, gatewayScope: "wss://synthetic.example/rpc" };
    const sql = observeDeviceAuthHostSql(state.statePath("state", "openclaw.sqlite"));
    try {
      expect(await tokens.loadDeviceAuthTokenReadOnly(lookup)).toBeNull();
      expect(await tokens.loadOriginDeviceTokenReadOnly(origin)).toBeNull();
      await expect(fs.stat(state.statePath("state", "openclaw.sqlite"))).rejects.toMatchObject({
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
      const stored = await tokens.storeOriginDeviceToken({ ...origin, token: "synthetic-origin" });
      expect(await tokens.loadOriginDeviceToken(origin)).toEqual(stored);
      expect(
        await tokens.loadOriginDeviceToken({ ...origin, gatewayScope: "wss://other.example" }),
      ).toBeNull();
      await closeOpenClawStateDatabaseAsync();
      const artifacts = (await fs.readdir(state.statePath("state"))).toSorted();
      expect(await tokens.loadOriginDeviceTokenReadOnly(origin)).toEqual(stored);
      await closeOpenClawStateDatabaseAsync();
      expect((await fs.readdir(state.statePath("state"))).toSorted()).toEqual(artifacts);
      expect(await tokens.clearOriginDeviceToken(origin)).toBe(true);
      await closeOpenClawStateDatabaseAsync();
      expect(Object.values(sql.counts().data)).toEqual(Array(7).fill(0));
      expect(Object.values(sql.counts().coordinator)).toEqual(Array(7).fill(0));
      expect(Object.values(sql.counts().runtimeInitialization)).toEqual(Array(7).fill(0));
      expect(Object.values(sql.counts().unknown)).toEqual(Array(7).fill(0));
      await expect(fs.stat(state.path("changed-state"))).rejects.toMatchObject({ code: "ENOENT" });
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
    const release = await holdDeviceAuthWriterForTest(state.statePath("state", "openclaw.sqlite"));
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

it.each(
  ["ordinary", "origin", "prepare"].flatMap((kind) =>
    ["cancel", "retire"].map((action) => ({ kind, action })),
  ),
)("does not settle absent worker $kind after $action", async ({ kind, action }) => {
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
        : kind === "origin"
          ? tokens.loadOriginDeviceTokenReadOnly({
              ...input,
              gatewayScope: "wss://synthetic.example",
            })
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
      (admit) =>
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
        }),
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

it.each([false, true])(
  "does not deliver a token observation after source retirement (origin: %s)",
  async (origin) => {
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
      const reading = origin
        ? tokens.loadOriginDeviceTokenReadOnly({
            ...input,
            gatewayScope: "wss://synthetic.example",
          })
        : tokens.loadDeviceAuthTokenReadOnly(input);
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
  },
);
