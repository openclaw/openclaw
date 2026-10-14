import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../test/helpers/sqlite-parent-observer.js";
import { readDeviceAuthTokenForTest } from "../infra/device-auth-store.test-support.js";
import { loadDeviceIdentityIfPresentAsync } from "../infra/device-identity-async.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { READ_SCOPE } from "./operator-scopes.js";
import { ensureStartupLocalCliPairing } from "./startup-local-cli-pairing.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("startup local CLI pairing", () => {
  it("creates and reuses a local CLI pairing off the main thread with canonical Windows metadata", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    await withStateDirEnv("openclaw-startup-local-cli-pairing-", async () => {
      const observer = observeParentSqlite();
      try {
        await expect(ensureStartupLocalCliPairing()).resolves.toBe("created");
        await expect(ensureStartupLocalCliPairing()).resolves.toBe("reused");
        expect(observer.counts).toEqual(emptySqliteCounts());
      } finally {
        observer.restore();
      }
      const identity = await loadDeviceIdentityIfPresentAsync();
      expect(identity).not.toBeNull();
      const paired = await getPairedDevice(identity!.deviceId);
      expect(paired).toMatchObject({
        platform: "windows",
        deviceFamily: "Windows",
        tokens: { operator: { token: expect.any(String) } },
      });
      platform.mockRestore();
      expect(
        readDeviceAuthTokenForTest({ deviceId: identity!.deviceId, role: "operator" }),
      ).toMatchObject({
        token: paired?.tokens?.operator?.token,
      });
    });
  });

  it("does not report a limited existing operator token as admin-ready", async () => {
    await withStateDirEnv("openclaw-startup-local-cli-pairing-", async () => {
      const identity = loadOrCreateDeviceIdentity();
      const request = await requestDevicePairing({
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        clientId: "openclaw-cli",
        clientMode: "cli",
        role: "operator",
        scopes: [READ_SCOPE],
        silent: true,
      });
      const approved = await approveDevicePairing(request.request.requestId, {
        callerScopes: [READ_SCOPE],
        approvedVia: "silent",
      });
      expect(approved?.status).toBe("approved");

      await expect(ensureStartupLocalCliPairing()).resolves.toBe("unavailable");
      expect(
        readDeviceAuthTokenForTest({ deviceId: identity.deviceId, role: "operator" }),
      ).toBeNull();
      await expect(getPairedDevice(identity.deviceId)).resolves.toMatchObject({
        approvedScopes: [READ_SCOPE],
      });
    });
  });
});
