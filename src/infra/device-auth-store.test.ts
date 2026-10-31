import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withClientCredentialStore } from "./client-credential-store.test-support.js";
import * as tokens from "./device-auth-store.js";
import { observeDeviceAuthHostSql } from "./device-auth-store.sql.test-support.js";
import { holdDeviceAuthWriterForTest } from "./device-auth-store.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("local device token cache", () => {
  it("isolates device, role, and Gateway origin even with a surplus scope on unscoped calls", async () => {
    await withOpenClawTestState({ label: "credential-token-scopes" }, async ({ env }) => {
      const lookup = {
        env,
        deviceId: "device-one",
        role: " operator ",
        gatewayScope: "wss://two.example",
      };
      const stored = await tokens.storeDeviceAuthToken({
        ...lookup,
        token: "local",
        scopes: [" operator.read ", "operator.read"],
      });
      await tokens.storeDeviceAuthToken({
        ...lookup,
        deviceId: "device-two",
        token: "other-device",
      });
      await tokens.storeDeviceAuthToken({ ...lookup, role: "node", token: "node" });
      await tokens.storeOriginDeviceToken({
        ...lookup,
        gatewayScope: "wss://one.example",
        token: "one",
      });
      await tokens.storeOriginDeviceToken({
        ...lookup,
        gatewayScope: "wss://two.example",
        token: "two",
      });
      expect(stored).toMatchObject({ role: "operator", scopes: ["operator.read"] });
      expect(await tokens.loadDeviceAuthToken(lookup)).toEqual(stored);
      expect(
        await tokens.loadDeviceAuthToken({ env, deviceId: "device-one", role: "operator" }),
      ).toEqual(stored);
      expect((await tokens.loadDeviceAuthTokens(lookup)).map((entry) => entry.role)).toEqual([
        "node",
        "operator",
      ]);
      expect(
        await tokens.clearOriginDeviceToken({ ...lookup, gatewayScope: "wss://one.example" }),
      ).toBe(true);
      expect(
        await tokens.loadOriginDeviceToken({ ...lookup, gatewayScope: "wss://one.example" }),
      ).toBeNull();
      expect(
        await tokens.loadOriginDeviceToken({ ...lookup, gatewayScope: "wss://two.example" }),
      ).toMatchObject({ token: "two" });
      expect(await tokens.clearDeviceAuthToken(lookup)).toBe(true);
      expect(
        await tokens.loadOriginDeviceToken({ ...lookup, gatewayScope: "wss://two.example" }),
      ).toMatchObject({ token: "two" });
      expect(await tokens.loadDeviceAuthToken({ ...lookup, deviceId: "device-two" })).toMatchObject(
        { token: "other-device" },
      );
      expect(await tokens.loadDeviceAuthToken({ ...lookup, role: "node" })).toMatchObject({
        token: "node",
      });
    });
  });

  it.each([false, true])(
    "does not overwrite or remove a newer observed token (origin=%s)",
    async (origin) => {
      await withOpenClawTestState({ label: "credential-token-cas" }, async ({ env }) => {
        const lookup = {
          env,
          deviceId: "device",
          role: "operator",
          gatewayScope: "wss://one.example",
        };
        const store = (token: string, expectedToken?: string | null) =>
          origin
            ? tokens.storeOriginDeviceToken({ ...lookup, token, expectedToken })
            : tokens.storeDeviceAuthToken({ ...lookup, token, expectedToken });
        const load = () =>
          origin ? tokens.loadOriginDeviceToken(lookup) : tokens.loadDeviceAuthToken(lookup);
        const clear = (expectedToken: string) =>
          origin
            ? tokens.clearOriginDeviceToken({ ...lookup, expectedToken })
            : tokens.clearDeviceAuthToken({ ...lookup, expectedToken });
        await store("first", null);
        expect(await store("unexpected", null)).toBeNull();
        await store("rotated", "first");
        expect(await store("stale", "first")).toBeNull();
        expect(await clear("first")).toBe(false);
        expect(await load()).toMatchObject({ token: "rotated" });
        expect(await clear("rotated")).toBe(true);
        expect(await load()).toBeNull();
      });
    },
  );

  it("fails closed on malformed scope metadata while retaining the raw token observation", async () => {
    await withOpenClawTestState({ label: "credential-token-malformed" }, async ({ env }) => {
      await tokens.storeDeviceAuthToken({
        env,
        deviceId: "device",
        role: "operator",
        token: "raw-token",
      });
      withClientCredentialStore(env, false, (db) =>
        db
          .prepare("UPDATE device_auth_tokens SET scopes_json = ? WHERE device_id = ? AND role = ?")
          .run("not-json", "device", "operator"),
      );
      const onSnapshot = vi.fn();
      expect(
        await tokens.loadDeviceAuthToken({ env, deviceId: "device", role: "operator", onSnapshot }),
      ).toBeNull();
      expect(onSnapshot).toHaveBeenCalledWith({ entry: null, expectedToken: "raw-token" });
      expect(await tokens.loadDeviceAuthTokens({ env, deviceId: "device" })).toEqual([]);
    });
  });

  it("keeps token work off the main thread and never opens selected shared state", async () => {
    await withOpenClawTestState({ label: "credential-token-worker" }, async (state) => {
      const lookup = { env: state.env, deviceId: "device", role: "operator" };
      const databasePath = state.statePath("client", "credentials.sqlite");
      const sql = observeDeviceAuthHostSql(databasePath);
      try {
        expect(await tokens.loadDeviceAuthTokenReadOnly(lookup)).toBeNull();
        expect(fs.existsSync(databasePath)).toBe(false);
        await tokens.storeDeviceAuthToken({ ...lookup, token: "one" });
        await tokens.storeDeviceAuthToken({ ...lookup, token: "two", expectedToken: "one" });
        expect(await tokens.loadDeviceAuthToken(lookup)).toMatchObject({ token: "two" });
        expect(await tokens.clearDeviceAuthToken(lookup)).toBe(true);
        expect(await tokens.loadDeviceAuthToken(lookup)).toBeNull();
        expect(fs.existsSync(state.statePath("state", "openclaw.sqlite"))).toBe(false);
        expect(Object.values(sql.counts().data)).toEqual(Array(7).fill(0));
        expect(Object.values(sql.counts().unknown)).toEqual(Array(7).fill(0));
      } finally {
        sql.restore();
      }
    });
  });

  it("rechecks live mutation authority after waiting for another local owner", async () => {
    await withOpenClawTestState({ label: "credential-token-authority" }, async (state) => {
      const lookup = { env: state.env, deviceId: "device", role: "operator" };
      const original = await tokens.storeDeviceAuthToken({ ...lookup, token: "original" });
      const release = await holdDeviceAuthWriterForTest(
        state.statePath("client", "credentials.sqlite"),
      );
      let current = true;
      const assertCurrent = vi.fn(() => {
        if (!current) {
          throw new Error("retired credential operation");
        }
      });
      try {
        const mutation = tokens.storeDeviceAuthToken({
          ...lookup,
          token: "replacement",
          assertCurrent,
        });
        const rejected = expect(mutation).rejects.toThrow("retired credential operation");
        await vi.waitFor(() => expect(assertCurrent).toHaveBeenCalled());
        await delay(20);
        current = false;
        await release();
        await rejected;
        expect(await tokens.loadDeviceAuthToken(lookup)).toEqual(original);
      } finally {
        await release();
      }
    });
  });

  it("does not publish a token snapshot after caller cancellation", async () => {
    await withOpenClawTestState({ label: "credential-token-cancel" }, async ({ env }) => {
      const controller = new AbortController();
      const onSnapshot = vi.fn();
      const reading = tokens.loadDeviceAuthToken({
        env,
        deviceId: "device",
        role: "operator",
        signal: controller.signal,
        onSnapshot,
      });
      controller.abort(new Error("credential read canceled"));
      await expect(reading).rejects.toThrow("credential read canceled");
      expect(onSnapshot).not.toHaveBeenCalled();
    });
  });
});
