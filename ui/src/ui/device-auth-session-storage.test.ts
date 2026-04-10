import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { clearDeviceAuthToken, loadDeviceAuthToken, storeDeviceAuthToken } from "./device-auth.ts";
import { loadOrCreateDeviceIdentity } from "./device-identity.ts";

describe("device auth browser storage", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("window", {
      localStorage,
      sessionStorage,
      location: { href: "http://127.0.0.1:18789/" },
    });
    vi.stubGlobal("crypto", crypto);
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores device auth tokens in sessionStorage", () => {
    storeDeviceAuthToken({
      deviceId: "device-1",
      role: "operator",
      token: "tab-token",
      scopes: ["operator.read"],
    });

    expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator" })).toMatchObject({
      token: "tab-token",
      scopes: ["operator.read"],
    });
    expect(sessionStorage.getItem("openclaw.device.auth.v1")).toContain("tab-token");
    expect(localStorage.getItem("openclaw.device.auth.v1")).toBeNull();
  });

  it("migrates legacy device auth out of localStorage on read", () => {
    localStorage.setItem(
      "openclaw.device.auth.v1",
      JSON.stringify({
        version: 1,
        deviceId: "device-1",
        tokens: {
          operator: {
            token: "legacy-token",
            role: "operator",
            scopes: ["operator.read"],
            updatedAtMs: 1,
          },
        },
      }),
    );

    expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator" })?.token).toBe(
      "legacy-token",
    );
    expect(sessionStorage.getItem("openclaw.device.auth.v1")).toContain("legacy-token");
    expect(localStorage.getItem("openclaw.device.auth.v1")).toBeNull();
  });

  it("clears legacy localStorage state when removing a token", () => {
    localStorage.setItem(
      "openclaw.device.auth.v1",
      JSON.stringify({
        version: 1,
        deviceId: "device-1",
        tokens: { operator: { token: "legacy-token", role: "operator", updatedAtMs: 1 } },
      }),
    );
    storeDeviceAuthToken({ deviceId: "device-1", role: "operator", token: "tab-token" });

    clearDeviceAuthToken({ deviceId: "device-1", role: "operator" });

    expect(loadDeviceAuthToken({ deviceId: "device-1", role: "operator" })).toBeNull();
    expect(localStorage.getItem("openclaw.device.auth.v1")).toBeNull();
  });

  it("stores device identity in sessionStorage and scrubs legacy localStorage", async () => {
    const identity = await loadOrCreateDeviceIdentity();

    expect(identity.deviceId).toBeTruthy();
    expect(sessionStorage.getItem("openclaw-device-identity-v1")).toContain(identity.deviceId);
    expect(localStorage.getItem("openclaw-device-identity-v1")).toBeNull();
  });

  it("migrates legacy device identity out of localStorage", async () => {
    const legacy = {
      version: 1,
      deviceId: "wrong-device-id",
      publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      privateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      createdAtMs: 1,
    };
    localStorage.setItem("openclaw-device-identity-v1", JSON.stringify(legacy));

    const identity = await loadOrCreateDeviceIdentity();

    expect(identity.publicKey).toBe(legacy.publicKey);
    expect(identity.privateKey).toBe(legacy.privateKey);
    expect(sessionStorage.getItem("openclaw-device-identity-v1")).toContain(identity.deviceId);
    expect(localStorage.getItem("openclaw-device-identity-v1")).toBeNull();
  });
});
