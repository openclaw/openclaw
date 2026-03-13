import { describe, expect, it, vi } from "vitest";
import {
  clearDeviceAuthTokenFromStore,
  loadDeviceAuthTokenFromStore,
  storeDeviceAuthTokenInStore,
  type DeviceAuthStoreAdapter,
} from "./device-auth-store.js";

function createAdapter(initialStore: ReturnType<DeviceAuthStoreAdapter["readStore"]> = null) {
  let store = initialStore;
  const writes: unknown[] = [];
  const adapter: DeviceAuthStoreAdapter = {
    readStore: () => store,
    writeStore: (next) => {
      store = next;
      writes.push(next);
    },
  };
  return { adapter, writes, readStore: () => store };
}

describe("device-auth-store", () => {
  it("loads only matching device ids and normalized roles", () => {
    const { adapter } = createAdapter({
      version: 1,
      deviceId: "device-1",
      tokens: {
        operator: {
          token: "secret",
          role: "operator",
          scopes: ["operator.read"],
          updatedAtMs: 1,
        },
      },
    });

    expect(
      loadDeviceAuthTokenFromStore({
        adapter,
        deviceId: "device-1",
        role: "  operator  ",
      }),
    ).toMatchObject({ token: "secret" });
    expect(
      loadDeviceAuthTokenFromStore({
        adapter,
        deviceId: "device-2",
        role: "operator",
      }),
    ).toBeNull();
  });

  it("stores normalized roles and deduped sorted scopes while preserving same-device tokens", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const { adapter, writes, readStore } = createAdapter({
      version: 1,
      deviceId: "device-1",
      tokens: {
        node: {
          token: "node-token",
          role: "node",
          scopes: ["node.invoke"],
          updatedAtMs: 10,
        },
      },
    });

    const entry = storeDeviceAuthTokenInStore({
      adapter,
      deviceId: "device-1",
      role: "  operator ",
      token: "operator-token",
      scopes: [" operator.write ", "operator.read", "operator.read", ""],
    });

    expect(entry).toEqual({
      token: "operator-token",
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      updatedAtMs: 1234,
    });
    expect(writes).toHaveLength(1);
    expect(readStore()).toEqual({
      version: 1,
      deviceId: "device-1",
      tokens: {
        node: {
          token: "node-token",
          role: "node",
          scopes: ["node.invoke"],
          updatedAtMs: 10,
        },
        operator: entry,
      },
    });
  });

  it("replaces stale stores from other devices instead of merging them", () => {
    const { adapter, readStore } = createAdapter({
      version: 1,
      deviceId: "device-2",
      tokens: {
        operator: {
          token: "old-token",
          role: "operator",
          scopes: [],
          updatedAtMs: 1,
        },
      },
    });

    storeDeviceAuthTokenInStore({
      adapter,
      deviceId: "device-1",
      role: "node",
      token: "node-token",
    });

    expect(readStore()).toEqual({
      version: 1,
      deviceId: "device-1",
      tokens: {
        node: {
          token: "node-token",
          role: "node",
          scopes: [],
          updatedAtMs: expect.any(Number),
        },
      },
    });
  });

  it("avoids writes when clearing missing roles or mismatched devices", () => {
    const missingRole = createAdapter({
      version: 1,
      deviceId: "device-1",
      tokens: {},
    });
    clearDeviceAuthTokenFromStore({
      adapter: missingRole.adapter,
      deviceId: "device-1",
      role: "operator",
    });
    expect(missingRole.writes).toHaveLength(0);

    const otherDevice = createAdapter({
      version: 1,
      deviceId: "device-2",
      tokens: {
        operator: {
          token: "secret",
          role: "operator",
          scopes: [],
          updatedAtMs: 1,
        },
      },
    });
    clearDeviceAuthTokenFromStore({
      adapter: otherDevice.adapter,
      deviceId: "device-1",
      role: "operator",
    });
    expect(otherDevice.writes).toHaveLength(0);
  });

  it("removes normalized roles when clearing stored tokens", () => {
    const { adapter, writes, readStore } = createAdapter({
      version: 1,
      deviceId: "device-1",
      tokens: {
        operator: {
          token: "secret",
          role: "operator",
          scopes: ["operator.read"],
          updatedAtMs: 1,
        },
        node: {
          token: "node-token",
          role: "node",
          scopes: [],
          updatedAtMs: 2,
        },
      },
    });

    clearDeviceAuthTokenFromStore({
      adapter,
      deviceId: "device-1",
      role: " operator ",
    });

    expect(writes).toHaveLength(1);
    expect(readStore()).toEqual({
      version: 1,
      deviceId: "device-1",
      tokens: {
        node: {
          token: "node-token",
          role: "node",
          scopes: [],
          updatedAtMs: 2,
        },
      },
    });
  });
});
