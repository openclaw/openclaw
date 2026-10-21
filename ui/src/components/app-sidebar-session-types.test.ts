/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  loadStoredCollapsedSessionSections,
  loadStoredHiddenSessionCatalogIds,
  loadStoredSidebarSessionSortMode,
  loadStoredSidebarSessionStatusFilter,
  loadStoredSidebarSessionOwnerFilter,
  loadStoredSidebarSessionsShowPreview,
  setStoredSessionCatalogHidden,
  storeSidebarSessionSortMode,
  storeSidebarSessionStatusFilter,
  storeSidebarSessionOwnerFilter,
  storeSidebarSessionsShowPreview,
} from "./app-sidebar-session-types.ts";

// getSafeLocalStorage only accepts an own value property under Vitest, so the
// jsdom getter-backed localStorage must be replaced with a plain mock.
let originalLocalStorage: PropertyDescriptor | undefined;
const gateway = "wss://one.example/ws";
const ownerFilter = (ownerId: string | null, involvingMe = false) => ({ ownerId, involvingMe });
const loadOwner = (user = "profile-ada", url = gateway) =>
  loadStoredSidebarSessionOwnerFilter(url, user);
const storeOwner = (ownerId: string | null, involvingMe = false, user = "profile-ada") =>
  storeSidebarSessionOwnerFilter(gateway, user, ownerFilter(ownerId, involvingMe));

beforeEach(() => {
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createStorageMock(),
  });
});

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

describe("sidebar session preferences", () => {
  it("defaults unknown stored values to active", () => {
    expect(loadStoredSidebarSessionStatusFilter()).toBe("active");
    localStorage.setItem("openclaw:sidebar:sessions:status-filter", "unexpected");
    expect(loadStoredSidebarSessionStatusFilter()).toBe("active");
  });

  it.each(["snoozed", "archived", "all"] as const)("stores the %s filter", (filter) => {
    storeSidebarSessionStatusFilter(filter);
    expect(loadStoredSidebarSessionStatusFilter()).toBe(filter);
  });

  it("isolates owner and involving-me filters by gateway and authenticated user", () => {
    storeOwner("profile-bob");
    storeOwner(null, true, "profile-grace");
    expect(loadOwner()).toEqual(ownerFilter("profile-bob"));
    expect(loadOwner("profile-grace")).toEqual(ownerFilter(null, true));
    expect(loadOwner("profile-ada", "wss://two.example/ws")).toEqual(ownerFilter("profile-ada"));
  });

  it("stores an explicit all-owner choice and rejects malformed stored values", () => {
    storeOwner("profile-bob");
    const key = localStorage.key(0);
    expect(key).not.toBeNull();
    localStorage.setItem(key ?? "", "owner:");
    expect(loadOwner()).toEqual(ownerFilter(null));
    storeOwner(null);
    expect(loadOwner()).toEqual(ownerFilter(null));
    expect(localStorage.getItem(key ?? "")).toBe("all");
  });

  it("keeps rendering when browser storage rejects access", () => {
    localStorage.getItem = () => {
      throw new Error("storage disabled");
    };
    localStorage.setItem = () => {
      throw new Error("storage disabled");
    };

    expect(loadOwner()).toEqual(ownerFilter("profile-ada"));
    expect(() => storeOwner(null, true)).not.toThrow();
  });

  it.each([
    ["updated", undefined, "updated"],
    ["people", true, "people"],
    ["people", false, "created"],
  ] as const)("persists %s with people capability %s as %s", (mode, capability, expected) => {
    expect(storeSidebarSessionSortMode(mode, capability)).toBe(expected);
    expect(loadStoredSidebarSessionSortMode()).toBe(expected);
  });

  it("defaults Coding to compact while Online remains expanded", () => {
    expect([...loadStoredCollapsedSessionSections()]).toEqual(["work"]);
  });

  it("defaults to hiding previews and round-trips the stored choice", () => {
    expect(loadStoredSidebarSessionsShowPreview()).toBe(false);

    storeSidebarSessionsShowPreview(false);
    expect(loadStoredSidebarSessionsShowPreview()).toBe(false);

    storeSidebarSessionsShowPreview(true);
    expect(loadStoredSidebarSessionsShowPreview()).toBe(true);
  });

  it("round-trips catalog ids and reverses one hide at a time", () => {
    setStoredSessionCatalogHidden("codex", true);
    setStoredSessionCatalogHidden("claude", true);
    expect([...loadStoredHiddenSessionCatalogIds()]).toEqual(["codex", "claude"]);

    setStoredSessionCatalogHidden("codex", false);
    expect([...loadStoredHiddenSessionCatalogIds()]).toEqual(["claude"]);
  });

  it.each(["not-json", JSON.stringify({ catalog: "codex" })])(
    "treats malformed storage as empty: %s",
    (stored) => {
      localStorage.setItem("openclaw:sidebar:sessions:hidden-catalogs", stored);
      expect(loadStoredHiddenSessionCatalogIds().size).toBe(0);
    },
  );
});
