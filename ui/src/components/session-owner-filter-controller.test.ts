/* @vitest-environment jsdom */

import type { ReactiveController } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createConnectionBootstrapCoordinator } from "../app/connection-bootstrap.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  loadStoredSidebarSessionOwnerFilter,
  storeSidebarSessionOwnerFilter,
} from "./app-sidebar-session-types.ts";
import { SessionOwnerFilterController } from "./session-owner-filter-controller.ts";

let originalLocalStorage: PropertyDescriptor | undefined;

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

describe("SessionOwnerFilterController", () => {
  it.each([
    { ownerId: "restored-owner", involvingMe: false },
    { ownerId: null, involvingMe: true },
  ])("defers restoring $ownerId/$involvingMe until the selected chat is ready", async (filter) => {
    const bootstrap = createConnectionBootstrapCoordinator();
    const client = {};
    bootstrap.setForegroundRoute("agent:main:current");
    bootstrap.synchronize({ client, connected: true });
    const refreshed = createDeferred();
    const refresh = vi.fn(() => refreshed.promise);
    let scheduled: Promise<void> | undefined;
    const host = {
      addController: vi.fn(),
      removeController: vi.fn(),
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
      sessionData: {
        resetSessionList: vi.fn(),
        refreshSidebarSessions: refresh,
        scheduleSidebarSessions: () =>
          (scheduled = bootstrap.run(host, refresh, { background: true })),
      },
    };
    const gatewayUrl = "wss://filter.example";
    storeSidebarSessionOwnerFilter(gatewayUrl, "profile", filter);
    const controller = new SessionOwnerFilterController(host, () => ({
      gateway: { connection: { gatewayUrl }, snapshot: { selfUser: { id: "profile" } } },
    }));
    try {
      controller.hostUpdated();
      expect(controller.ownerId).toBe(filter.ownerId);
      expect(controller.involvingMe).toBe(filter.involvingMe);
      expect(refresh).not.toHaveBeenCalled();

      bootstrap.setForegroundPane({}, { sessionKey: "agent:main:current", client, ready: true });
      expect(refresh).toHaveBeenCalledOnce();
      controller.observeOwnerFacet(true, []);
      controller.hostUpdated();
      expect(controller.ownerId).toBe(filter.ownerId);
      refreshed.resolve();
      await refreshed.promise;
      await scheduled;
      await Promise.resolve();
      controller.observeOwnerFacet(true, filter.ownerId ? [{ id: filter.ownerId }] : []);
      controller.hostUpdated();
      expect(controller.ownerId).toBe(filter.ownerId);
      expect(controller.involvingMe).toBe(filter.involvingMe);
      bootstrap.setForegroundRoute("agent:main:next");
      controller.set("explicit-owner");
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(controller.ownerId).toBe("explicit-owner");
    } finally {
      refreshed.resolve();
      bootstrap.reset();
    }
  });

  it("waits for the new identity roster before validating its stored owner", async () => {
    let controller: ReactiveController | undefined;
    const host = {
      addController: (value: ReactiveController) => {
        controller = value;
      },
      removeController: vi.fn(),
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
      sessionData: {
        resetSessionList: vi.fn(),
        refreshSidebarSessions: () => refresh(),
        scheduleSidebarSessions: () => refresh(),
      },
    };
    let selfUserId = "profile-ada";
    let finishRefresh!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const ownerFilter = new SessionOwnerFilterController(host, () => ({
      gateway: {
        connection: { gatewayUrl: "wss://one.example/ws" },
        snapshot: { selfUser: { id: selfUserId } },
      },
    }));
    expect(controller).toBe(ownerFilter);
    ownerFilter.hostUpdated();
    ownerFilter.observeOwnerFacet(true, [{ id: "owner-ada" }]);
    storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-bob", {
      ownerId: "owner-bob",
      involvingMe: false,
    });

    selfUserId = "profile-bob";
    ownerFilter.hostUpdated();
    await Promise.resolve();
    ownerFilter.observeOwnerFacet(true, [{ id: "owner-ada" }]);
    ownerFilter.hostUpdated();

    expect(ownerFilter.ownerId).toBe("owner-bob");
    expect(refresh).toHaveBeenCalledOnce();
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-bob")).toEqual({
      ownerId: "owner-bob",
      involvingMe: false,
    });

    finishRefresh();
    await Promise.resolve();
    ownerFilter.hostUpdated();
    ownerFilter.observeOwnerFacet(true, [{ id: "owner-bob" }]);
    ownerFilter.hostUpdated();
    expect(ownerFilter.ownerId).toBe("owner-bob");
    expect(refresh).toHaveBeenCalledOnce();
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-bob")).toEqual({
      ownerId: "owner-bob",
      involvingMe: false,
    });
  });
});
