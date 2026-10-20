/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { SidebarEmptyGroupsPreference } from "./sidebar-empty-groups.ts";

let storage: Storage;
beforeEach(() => {
  storage = createStorageMock();
  vi.stubGlobal("localStorage", storage);
});
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const gateway = {
    connection: { gatewayUrl: "wss://one.example/ws" },
    connectionRevision: 0,
    snapshot: { phase: "connected", selfUser: { id: "ada" } as { id: string } | null },
  };
  const controller = new SidebarEmptyGroupsPreference(() => ({ gateway }));
  controller.reconcile();
  const reconcile = (snapshot: Partial<typeof gateway.snapshot>) => {
    Object.assign(gateway.snapshot, snapshot);
    return controller.reconcile();
  };
  return { controller, gateway, reconcile };
}

describe("personal empty-group preference", () => {
  it("keeps anonymous browser choices separate from signed-in users", () => {
    const { controller, reconcile } = fixture();
    controller.set("always");
    reconcile({ selfUser: null });
    expect(controller.mode).toBe("filtering");
    controller.set("never");
    reconcile({ selfUser: { id: "ada" } });
    expect(controller.mode).toBe("always");
    reconcile({ selfUser: null });
    expect(controller.mode).toBe("never");
  });

  it.each([
    ["true", "always"],
    ["false", "filtering"],
  ] as const)("migrates legacy %s once without copying it to a second user", (legacy, expected) => {
    storage.setItem("openclaw:sidebar:sessions:hide-empty-groups", legacy);
    const { controller, reconcile } = fixture();
    expect(controller.mode).toBe(expected);
    expect(storage.getItem("openclaw:sidebar:sessions:hide-empty-groups")).toBeNull();
    reconcile({ selfUser: { id: "lin" } });
    expect(controller.mode).toBe("filtering");
    reconcile({ selfUser: { id: "ada" } });
    expect(controller.mode).toBe(expected);
  });

  it("does not persist effective visibility during rerenders or an identified reconnect", () => {
    const { controller, reconcile } = fixture();
    controller.set("never");
    const writes = vi.spyOn(storage, "setItem");
    writes.mockClear();
    reconcile({ phase: "reconnecting", selfUser: null });
    expect(controller.mode).toBe("never");
    reconcile({ phase: "connected", selfUser: { id: "ada" } });
    expect(controller.mode).toBe("never");
    expect(writes).not.toHaveBeenCalled();
  });

  it("retires stopped or replaced connections and rejects an old menu action", () => {
    const { controller, gateway, reconcile } = fixture();
    controller.set("never");
    gateway.snapshot.selfUser = { id: "lin" };
    controller.set("always");
    expect(controller.mode).toBe("filtering");
    controller.set("always");
    expect(controller.mode).toBe("always");
    gateway.connectionRevision += 1;
    expect(reconcile({ phase: "reconnecting", selfUser: null })).toBe(true);
    expect(controller.mode).toBe("filtering");
    reconcile({ phase: "connected", selfUser: { id: "ada" } });
    expect(controller.mode).toBe("never");
    reconcile({ phase: "stopped", selfUser: null });
    expect(controller.mode).toBe("filtering");
  });

  it("keeps the view usable when browser persistence is denied", () => {
    const denied = () => {
      throw new Error("denied");
    };
    vi.spyOn(storage, "getItem").mockImplementation(denied);
    vi.spyOn(storage, "setItem").mockImplementation(denied);
    const { controller } = fixture();
    expect(controller.mode).toBe("filtering");
    controller.set("never");
    controller.reconcile();
    expect(controller.mode).toBe("never");
  });
});
