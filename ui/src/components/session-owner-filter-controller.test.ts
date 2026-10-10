/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import type { SessionListSnapshot } from "../lib/sessions/session-capability.ts";
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

function fixture(initialMine = false) {
  const context = {
    gateway: {
      connection: { gatewayUrl: "wss://one.example/ws" },
      snapshot: { selfUser: { id: "profile-ada" } as { id: string } | null },
    },
  };
  let mine = initialMine;
  let facet: SessionListSnapshot | undefined;
  const host = {
    isConnected: true,
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
    sidebarSessionOwnerFilter: () => ({
      ownerId: mine ? (context.gateway.snapshot.selfUser?.id ?? null) : controller.ownerId,
      involvingMe: !mine && controller.involvingMe,
    }),
    sessionData: {
      resetSessionList: vi.fn(),
      refreshSidebarSessions: vi.fn(() => Promise.resolve()),
      scheduleSidebarSessions: vi.fn(() => Promise.resolve()),
    },
  };
  const controller = new SessionOwnerFilterController(
    host,
    () => context,
    () => (mine ? undefined : facet),
  );
  const update = () => {
    controller.hostUpdate();
    controller.hostUpdated();
  };
  return {
    host,
    controller,
    context,
    update,
    mine: (value: boolean, userIntent = true) => {
      mine = value;
      if (userIntent) {
        controller.markUserIntent();
      }
      update();
    },
    facet: (value: SessionListSnapshot) => {
      facet = value;
      update();
    },
  };
}
function ownerFacet(id: string): SessionListSnapshot {
  return {
    result: { ...sessionsResult([], 1), owners: [{ type: "human", id }] },
    loading: false,
    error: null,
    agentId: "main",
    readSucceeded: true,
  };
}

describe("SessionOwnerFilterController", () => {
  it("schedules initial Mine and programmatic scope changes but immediately refreshes explicit changes", () => {
    const { controller, host, update, mine } = fixture(true);
    controller.hostConnected();
    update();
    expect(host.sidebarSessionOwnerFilter()).toEqual({
      ownerId: "profile-ada",
      involvingMe: false,
    });
    expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledOnce();
    expect(host.sessionData.resetSessionList).not.toHaveBeenCalled();
    expect(host.sessionData.refreshSidebarSessions).not.toHaveBeenCalled();

    mine(false, false);
    expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledTimes(2);
    expect(host.sessionData.refreshSidebarSessions).not.toHaveBeenCalled();
    mine(true);
    expect(host.sessionData.refreshSidebarSessions).toHaveBeenCalledOnce();
    mine(false, false);
    expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledTimes(3);
    expect(host.sessionData.refreshSidebarSessions).toHaveBeenCalledOnce();
  });

  it.each(["no query change", "replacement profile", "disconnected host"])(
    "does not carry explicit intent into later automatic work after %s",
    (retirement) => {
      const { controller, host, context, update } = fixture(true);
      controller.hostConnected();
      update();
      controller.markUserIntent();
      if (retirement === "no query change") {
        update();
      } else if (retirement === "disconnected host") {
        controller.hostDisconnected();
        controller.hostConnected();
      }
      context.gateway.snapshot.selfUser = { id: "replacement-profile" };
      update();
      expect(host.sessionData.refreshSidebarSessions).not.toHaveBeenCalled();
      expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledTimes(2);
      expect(host.sidebarSessionOwnerFilter()).toEqual({
        ownerId: "replacement-profile",
        involvingMe: false,
      });
    },
  );

  it.each([
    { ownerId: "owner-bob", involvingMe: false },
    { ownerId: null, involvingMe: true },
  ])(
    "restores $ownerId/$involvingMe before initial subscription without another read",
    (filter) => {
      storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada", filter);
      const { controller, host, update, mine } = fixture();
      controller.hostConnected();
      expect(controller.ownerId).toBe(filter.ownerId);
      expect(controller.involvingMe).toBe(filter.involvingMe);
      update();
      update();
      expect(host.sessionData.refreshSidebarSessions).not.toHaveBeenCalled();
      expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledOnce();
      mine(true);
      expect(host.sidebarSessionOwnerFilter()).toEqual({
        ownerId: "profile-ada",
        involvingMe: false,
      });
      expect(host.sessionData.refreshSidebarSessions).toHaveBeenCalledOnce();
      mine(false);
      expect(host.sidebarSessionOwnerFilter()).toEqual(filter);
      expect(host.sessionData.refreshSidebarSessions).toHaveBeenCalledTimes(2);
      expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada")).toEqual(
        filter,
      );
      const reloaded = fixture();
      reloaded.controller.hostConnected();
      expect(reloaded.host.sidebarSessionOwnerFilter()).toEqual(filter);
    },
  );

  it("keeps profiles and gateways isolated, including a temporarily unavailable identity", () => {
    const { controller, context, update, host } = fixture();
    controller.hostConnected();
    update();
    controller.set("owner-ada");
    update();
    storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-bob", {
      ownerId: null,
      involvingMe: true,
    });
    context.gateway.snapshot.selfUser = null;
    update();
    expect(host.sidebarSessionOwnerFilter()).toEqual({ ownerId: null, involvingMe: false });
    context.gateway.snapshot.selfUser = { id: "profile-bob" };
    update();
    expect(host.sidebarSessionOwnerFilter()).toEqual({ ownerId: null, involvingMe: true });
    context.gateway.connection.gatewayUrl = "wss://two.example/ws";
    update();
    expect(host.sidebarSessionOwnerFilter()).toEqual({ ownerId: null, involvingMe: false });
    controller.set("owner-two");
    update();
    context.gateway.connection.gatewayUrl = "wss://one.example/ws";
    context.gateway.snapshot.selfUser = { id: "profile-ada" };
    update();
    expect(controller.ownerId).toBe("owner-ada");
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-bob")).toEqual({
      ownerId: null,
      involvingMe: true,
    });
  });

  it("waits for the replacement profile's query before validating its saved All owner", async () => {
    const { controller, host, context, update, facet } = fixture();
    controller.hostConnected();
    update();
    facet(ownerFacet("owner-ada"));
    storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-bob", {
      ownerId: "owner-bob",
      involvingMe: false,
    });
    const pending = createDeferred();
    host.sessionData.scheduleSidebarSessions.mockReturnValueOnce(pending.promise);
    context.gateway.snapshot.selfUser = { id: "profile-bob" };
    update();
    facet(ownerFacet("owner-ada"));
    expect(controller.ownerId).toBe("owner-bob");
    expect(host.sessionData.refreshSidebarSessions).not.toHaveBeenCalled();
    expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledTimes(2);
    facet(ownerFacet("owner-bob"));
    pending.resolve();
    await pending.promise;
    update();
    expect(controller.ownerId).toBe("owner-bob");
    expect(host.sessionData.refreshSidebarSessions).not.toHaveBeenCalled();
    expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledTimes(2);
  });

  it("clears only from a settled complete All facet, never a Mine or failed snapshot", async () => {
    const { controller, host, update, mine, facet } = fixture();
    controller.hostConnected();
    controller.set("owner-bob");
    update();
    mine(true);
    await Promise.resolve();
    facet(ownerFacet("profile-ada"));
    expect(controller.ownerId).toBe("owner-bob");
    mine(false);
    await Promise.resolve();
    for (const patch of [
      { loading: true },
      { startupPending: true },
      { error: "offline" },
      { readSucceeded: false },
      { result: sessionsResult([], 1) },
    ]) {
      facet({ ...ownerFacet("profile-ada"), ...patch });
      expect(controller.ownerId).toBe("owner-bob");
    }
    facet(ownerFacet("owner-bob"));
    expect(controller.ownerId).toBe("owner-bob");
    facet(ownerFacet("profile-ada"));
    expect(controller.ownerId).toBeNull();
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada")).toEqual({
      ownerId: null,
      involvingMe: false,
    });
    update();
    expect(host.sessionData.refreshSidebarSessions).toHaveBeenCalledTimes(3);
    expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledOnce();
  });
});
