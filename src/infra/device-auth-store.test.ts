import { describe, expect, it, vi } from "vitest";
import { writeOpenClawStateKvJson } from "../state/openclaw-state-kv.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  clearDeviceAuthToken,
  loadDeviceAuthStore,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from "./device-auth-store.js";

function createEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  };
}

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

  it("returns null for missing, invalid, or mismatched stores", async () => {
    await withTempDir("openclaw-device-auth-", async (stateDir) => {
      const env = createEnv(stateDir);

      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();

      writeOpenClawStateKvJson(
        "identity.device-auth",
        "default",
        { version: 2, deviceId: "device-1" },
        { env },
      );
      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();

      writeOpenClawStateKvJson(
        "identity.device-auth",
        "default",
        {
          version: 1,
          deviceId: "device-2",
          tokens: {
            operator: {
              token: "x",
              role: "operator",
              scopes: [],
              updatedAtMs: 1,
            },
          },
        },
        { env },
      );
      expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator", env })).toBeNull();
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
});
