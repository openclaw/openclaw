import { beforeEach, describe, expect, it } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { persistRoute, readStoredRoute, shouldRestore } from "./native-route-memory.ts";

let storage: Storage;

beforeEach(() => {
  storage = createStorageMock();
});

describe("native route memory", () => {
  it("persists and reads known routes", () => {
    persistRoute("usage", "?agent=main", storage, true);
    expect(readStoredRoute(storage, true)).toEqual({ routeId: "usage", search: "?agent=main" });
  });

  it("drops corrupt and invalid entries", () => {
    storage.setItem("openclaw.native.lastRoute", "{");
    expect(readStoredRoute(storage, true)).toBeNull();
    expect(storage.getItem("openclaw.native.lastRoute")).toBeNull();

    storage.setItem(
      "openclaw.native.lastRoute",
      JSON.stringify({ routeId: "retired", search: "" }),
    );
    expect(readStoredRoute(storage, true)).toBeNull();
    expect(storage.getItem("openclaw.native.lastRoute")).toBeNull();
  });

  it("does nothing outside the native host", () => {
    storage.setItem("openclaw.native.lastRoute", JSON.stringify({ routeId: "usage", search: "" }));
    persistRoute("chat", "", storage, false);
    expect(readStoredRoute(storage, false)).toBeNull();
    expect(JSON.parse(storage.getItem("openclaw.native.lastRoute") ?? "{}")).toEqual({
      routeId: "usage",
      search: "",
    });
    expect(shouldRestore("chat", "", false)).toBe(false);
  });

  it("restores only the default route without explicit search", () => {
    expect(shouldRestore("chat", "", true)).toBe(true);
    expect(shouldRestore("chat", "?approval=123", true)).toBe(false);
    expect(shouldRestore("chat", "?session=abc", true)).toBe(false);
    expect(shouldRestore("usage", "", true)).toBe(false);
  });
});
