/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { SidebarEmptyGroupsPreference } from "./sidebar-empty-groups.ts";

beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const gateway = {
    connection: { gatewayUrl: "wss://one.example/ws" },
    connectionRevision: 0,
    snapshot: { phase: "connected", selfUser: { id: "ada" } as { id: string } | null },
  };
  const controller = new SidebarEmptyGroupsPreference(() => ({ gateway }));
  controller.reconcile();
  const reconcile = (snapshot: Partial<typeof gateway.snapshot>, mode: typeof controller.mode) => {
    Object.assign(gateway.snapshot, snapshot);
    const changed = controller.reconcile();
    expect(controller.mode).toBe(mode);
    return changed;
  };
  return { controller, gateway, reconcile };
}

it("keeps anonymous browser choices separate from signed-in users", () => {
  const { controller, reconcile } = fixture();
  controller.set("always");
  reconcile({ selfUser: null }, "filtering");
  controller.set("never");
  reconcile({ selfUser: { id: "ada" } }, "always");
  reconcile({ selfUser: null }, "never");
});

it.each([
  ["true", "always"],
  ["false", "filtering"],
] as const)("migrates legacy %s once without copying it to a second user", (legacy, expected) => {
  localStorage.setItem("openclaw:sidebar:sessions:hide-empty-groups", legacy);
  const { controller, reconcile } = fixture();
  expect(controller.mode).toBe(expected);
  expect(localStorage.getItem("openclaw:sidebar:sessions:hide-empty-groups")).toBeNull();
  reconcile({ selfUser: { id: "lin" } }, "filtering");
  reconcile({ selfUser: { id: "ada" } }, expected);
});

it("does not persist effective visibility during rerenders or an identified reconnect", () => {
  const { controller, reconcile } = fixture();
  controller.set("never");
  const writes = vi.spyOn(localStorage, "setItem");
  reconcile({ phase: "reconnecting", selfUser: null }, "never");
  reconcile({ phase: "connected", selfUser: { id: "ada" } }, "never");
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
  expect(reconcile({ phase: "reconnecting", selfUser: null }, "filtering")).toBe(true);
  reconcile({ phase: "connected", selfUser: { id: "ada" } }, "never");
  reconcile({ phase: "stopped", selfUser: null }, "filtering");
});

it("keeps the view usable when browser persistence is denied", () => {
  const denied = () => {
    throw new Error("denied");
  };
  vi.spyOn(localStorage, "getItem").mockImplementation(denied);
  vi.spyOn(localStorage, "setItem").mockImplementation(denied);
  const { controller } = fixture();
  expect(controller.mode).toBe("filtering");
  controller.set("never");
  controller.reconcile();
  expect(controller.mode).toBe("never");
});
