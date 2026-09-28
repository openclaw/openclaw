/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { SidebarEmptyGroupsController } from "./sidebar-empty-groups-controller.ts";

let originalStorage: PropertyDescriptor | undefined;
let storage: Storage;
beforeEach(() => {
  originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  storage = createStorageMock();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
});
afterEach(() => {
  if (originalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

function fixture() {
  const gateway = {
    connection: { gatewayUrl: "wss://one.example/ws" },
    connectionRevision: 0,
    snapshot: { phase: "connected", selfUser: { id: "ada" } as { id: string } | null },
  };
  const host = {
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  };
  const controller = new SidebarEmptyGroupsController(host, () => ({ gateway }));
  controller.reconcile();
  return { controller, gateway, host };
}

describe("personal empty-group preference", () => {
  it("isolates users and Gateways and restores each explicit choice", () => {
    const { controller, gateway } = fixture();
    controller.set("never");
    gateway.snapshot.selfUser = { id: "lin" };
    controller.reconcile();
    expect(controller.mode).toBe("filtering");
    controller.set("always");
    gateway.snapshot.selfUser = { id: "ada" };
    controller.reconcile();
    expect(controller.mode).toBe("never");
    gateway.connection.gatewayUrl = "wss://two.example/ws";
    controller.reconcile();
    expect(controller.mode).toBe("filtering");
    gateway.connection.gatewayUrl = "wss://one.example/ws";
    controller.reconcile();
    expect(controller.mode).toBe("never");
    expect(fixture().controller.mode).toBe("never");
  });

  it("keeps anonymous browser choices separate from signed-in users", () => {
    const { controller, gateway } = fixture();
    controller.set("always");
    gateway.snapshot.selfUser = null;
    controller.reconcile();
    expect(controller.mode).toBe("filtering");
    controller.set("never");
    gateway.snapshot.selfUser = { id: "ada" };
    controller.reconcile();
    expect(controller.mode).toBe("always");
    gateway.snapshot.selfUser = null;
    controller.reconcile();
    expect(controller.mode).toBe("never");
  });

  it.each([
    ["true", "always"],
    ["false", "filtering"],
  ] as const)("migrates legacy %s once without copying it to a second user", (legacy, expected) => {
    storage.setItem("openclaw:sidebar:sessions:hide-empty-groups", legacy);
    const { controller, gateway } = fixture();
    expect(controller.mode).toBe(expected);
    expect(storage.getItem("openclaw:sidebar:sessions:hide-empty-groups")).toBeNull();
    gateway.snapshot.selfUser = { id: "lin" };
    controller.reconcile();
    expect(controller.mode).toBe("filtering");
    gateway.snapshot.selfUser = { id: "ada" };
    controller.reconcile();
    expect(controller.mode).toBe(expected);
  });

  it("does not persist effective visibility during rerenders or an identified reconnect", () => {
    const { controller, gateway } = fixture();
    controller.set("never");
    const writes = vi.spyOn(storage, "setItem");
    writes.mockClear();
    gateway.snapshot.phase = "reconnecting";
    gateway.snapshot.selfUser = null;
    controller.reconcile();
    expect(controller.mode).toBe("never");
    gateway.snapshot.selfUser = { id: "ada" };
    gateway.snapshot.phase = "connected";
    controller.reconcile();
    expect(controller.mode).toBe("never");
    expect(writes).not.toHaveBeenCalled();
  });

  it("retires stopped or replaced connections and rejects an old menu action", () => {
    const { controller, gateway } = fixture();
    controller.set("never");
    gateway.snapshot.selfUser = { id: "lin" };
    controller.set("always");
    expect(controller.mode).toBe("filtering");
    controller.set("always");
    expect(controller.mode).toBe("always");
    gateway.snapshot.phase = "reconnecting";
    gateway.snapshot.selfUser = null;
    gateway.connectionRevision += 1;
    expect(controller.reconcile()).toBe(true);
    expect(controller.mode).toBe("filtering");
    gateway.snapshot.phase = "connected";
    gateway.snapshot.selfUser = { id: "ada" };
    controller.reconcile();
    expect(controller.mode).toBe("never");
    gateway.snapshot.phase = "stopped";
    gateway.snapshot.selfUser = null;
    controller.reconcile();
    expect(controller.mode).toBe("filtering");
  });

  it("keeps the view usable when browser persistence is denied", () => {
    vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { controller, host } = fixture();
    expect(controller.mode).toBe("filtering");
    controller.set("never");
    controller.reconcile();
    expect(controller.mode).toBe("never");
    expect(host.requestUpdate).toHaveBeenCalled();
  });
});
