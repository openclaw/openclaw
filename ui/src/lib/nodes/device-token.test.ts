/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  clearDeviceAuthToken,
  loadCurrentDeviceAuthToken,
  loadDeviceAuthToken,
  peekStoredDeviceIdentityId,
  storeDeviceAuthToken,
} from "./index.ts";
import { createInitialDevicesState, rotateDeviceToken } from "./page-operations.ts";

function createState(request: (method: string, params?: unknown) => Promise<unknown>) {
  return {
    ...createInitialDevicesState({
      client: {
        request: request as <T = unknown>(method: string, params?: unknown) => Promise<T>,
      },
      connected: true,
    }),
    requestGeneration: 1,
  };
}

function storeIdentity(deviceId = "00") {
  localStorage.setItem(
    "openclaw-device-identity-v1",
    JSON.stringify({ version: 1, deviceId, publicKey: "AA", privateKey: "AA", createdAtMs: 1 }),
  );
}

function deferIdentityFingerprint() {
  const digest = deferred<ArrayBuffer>();
  const digestMock = vi.fn(() => digest.promise);
  vi.stubGlobal("crypto", { subtle: { digest: digestMock } });
  return { digest, digestMock };
}

const tokenParams = { deviceId: "00", gatewayUrl: "wss://gateway.test", role: "operator" };

// Keep all required fields so malformed cases fail at the intended validation boundary.
const grant = {
  deviceId: tokenParams.deviceId,
  role: tokenParams.role,
  scopes: [],
  rotatedAtMs: 1_700_000_000_000,
};

function seedTokenStore(tokens: unknown) {
  const key = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index),
  ).find((candidate) => candidate?.startsWith("openclaw.device.auth.v1:"));
  if (!key) {
    throw new Error("missing device-auth test storage key");
  }
  localStorage.setItem(key, JSON.stringify({ version: 1, deviceId: "00", tokens }));
}

function storeToken(overrides: Partial<Parameters<typeof storeDeviceAuthToken>[0]> = {}) {
  return storeDeviceAuthToken({
    ...tokenParams,
    token: "current-token",
    scopes: ["operator.read"],
    ...overrides,
  });
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("current browser device token", () => {
  it("keeps credentials scoped to the requested Gateway route", () => {
    storeIdentity();
    const gatewayUrl = `${tokenParams.gatewayUrl}/first`;
    storeToken({ gatewayUrl, token: "first-token" });
    expect(loadCurrentDeviceAuthToken(`${tokenParams.gatewayUrl}/second`)).toBeNull();
    expect(loadCurrentDeviceAuthToken(gatewayUrl)).toBe("first-token");
  });

  it.each([
    [null, ["operator.read"]],
    ["another-device", ["operator.read"]],
    ["00", ["operator.approvals"]],
  ] as const)("rejects unreadable credentials for identity %s with scopes %j", (id, scopes) => {
    if (id) {
      storeIdentity(id);
    }
    storeToken({ scopes: [...scopes] });
    expect(loadCurrentDeviceAuthToken(tokenParams.gatewayUrl)).toBeNull();
  });
});

it("reads the stored device id without minting or fingerprint-verifying an identity", () => {
  // A hanging digest catches accidental verification on the synchronous render path.
  const { digestMock } = deferIdentityFingerprint();
  storeIdentity();
  expect(peekStoredDeviceIdentityId()).toBe("00");
  expect(digestMock).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(1);
});

it.each([
  { name: "no stored identity", raw: null },
  { name: "malformed JSON", raw: "{not-json" },
  { name: "unsupported version", raw: JSON.stringify({ version: 2, deviceId: "00" }) },
  { name: "missing device id", raw: JSON.stringify({ version: 1 }) },
])("returns no stored identity for $name without creating one", ({ raw }) => {
  if (raw !== null) {
    localStorage.setItem("openclaw-device-identity-v1", raw);
  }
  const before = localStorage.length;
  expect(peekStoredDeviceIdentityId()).toBeNull();
  expect(localStorage.length).toBe(before);
});
describe("device token request lifecycle", () => {
  // Rotation kills the previous token, so reconnects must not discard its replacement.
  it.each(["before RPC success", "during fingerprinting"])(
    "persists rotation retired %s",
    async (stage) => {
      storeIdentity();
      const { digest, digestMock } = deferIdentityFingerprint();
      const response = deferred<unknown>();
      const state = createState(() => response.promise);
      const operation = rotateDeviceToken(state, tokenParams);
      if (stage === "before RPC success") {
        state.requestGeneration += 1;
      }
      response.resolve({
        token: "rotated-token",
        ...(stage === "before RPC success" ? { tokenDelivery: "in-band" } : {}),
        ...grant,
      });
      await vi.waitFor(() => expect(digestMock).toHaveBeenCalledOnce());
      if (stage === "during fingerprinting") {
        state.requestGeneration += 1;
      }
      digest.resolve(new Uint8Array([0]).buffer);
      expect(await operation).toEqual({ delivery: "in-band", token: "rotated-token" });
      expect(loadDeviceAuthToken(tokenParams)?.token).toBe("rotated-token");
    },
  );
  it.each(["withheld-cross-device", undefined])(
    "reports a withheld token with delivery %s",
    async (tokenDelivery) => {
      const state = createState(async () => ({
        ...grant,
        deviceId: " 00 ",
        role: "operator ",
        ...(tokenDelivery === undefined ? {} : { tokenDelivery }),
      }));
      expect(await rotateDeviceToken(state, tokenParams)).toEqual({
        delivery: "withheld-cross-device",
      });
      expect(loadDeviceAuthToken(tokenParams)).toBeNull();
    },
  );

  // Reject contradictory delivery and malformed/mismatched grants before reporting success.
  it.each([
    ["in-band without a token", { ...grant, tokenDelivery: "in-band" }],
    [
      "withheld with a token",
      { ...grant, tokenDelivery: "withheld-cross-device", token: "unexpected" },
    ],
    ["unknown delivery", { ...grant, tokenDelivery: "out-of-band", token: "rotated-token" }],
    ["withheld blank token", { ...grant, tokenDelivery: "withheld-cross-device", token: "" }],
    ["a blank token with no delivery field", { ...grant, token: "" }],
    ["a null payload", null],
    ["a scalar payload", "rotated"],
    ["an empty object", {}],
    ["an array payload", []],
    ["a payload naming no role", { deviceId: "00" }],
    ["a payload omitting scopes", { deviceId: "00", role: "operator", rotatedAtMs: 1 }],
    ["a payload omitting rotatedAtMs", { deviceId: "00", role: "operator", scopes: [] }],
    ["a fractional timestamp", { ...grant, rotatedAtMs: 1.5 }],
    ["a payload carrying a blank scope", { ...grant, scopes: [""] }],
    ["a payload naming a different device", { ...grant, deviceId: "01" }],
    ["a payload naming a different role", { ...grant, role: "viewer" }],
  ])("refuses %s", async (_label, response) => {
    const state = createState(async () => response);
    expect(await rotateDeviceToken(state, tokenParams)).toBeNull();
    expect(state.devicesError).toContain("unusable result");
    expect(loadDeviceAuthToken(tokenParams)).toBeNull();
  });

  it("normalizes malformed persisted scopes without breaking token loading", () => {
    seedTokenStore({ operator: { ...storeToken({ scopes: [] }), scopes: "not-an-array" } });
    expect(loadDeviceAuthToken(tokenParams)).toMatchObject({
      token: "current-token",
      scopes: [],
    });
  });

  it("canonicalizes persisted role aliases before storing another token", () => {
    seedTokenStore({ " operator ": storeToken({ token: "operator-token", scopes: [] }) });
    storeToken({ role: "node", token: "node-token", scopes: ["node.invoke"] });
    expect(loadDeviceAuthToken(tokenParams)?.token).toBe("operator-token");
  });

  it("removes persisted role aliases when clearing a token", () => {
    const token = storeToken({ token: "operator-token", scopes: [] });
    seedTokenStore({ operator: token, " operator ": token });
    clearDeviceAuthToken(tokenParams);
    expect(loadDeviceAuthToken(tokenParams)).toBeNull();
  });
});
