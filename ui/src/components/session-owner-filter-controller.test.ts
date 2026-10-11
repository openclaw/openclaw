/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import type { SessionListSnapshot } from "../lib/sessions/session-capability.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
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

function fixture() {
  const { gateway } = createApplicationGateway({
    client: null,
    phase: "connected",
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
    selfUser: { id: "profile-ada" },
  });
  gateway.connection.gatewayUrl = "wss://one.example/ws";
  const context = {
    gateway,
  };
  let facet: SessionListSnapshot | undefined;
  const host = {
    isConnected: true,
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
    sidebarSessionOwnerFilter: () => ({
      ownerId: controller.ownerId,
      involvingMe: controller.involvingMe,
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
    () => facet,
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
  it("schedules the default self filter and immediately refreshes explicit owner choices", () => {
    const { controller, host, update } = fixture();
    controller.hostConnected();
    update();
    expect(host.sidebarSessionOwnerFilter()).toEqual({
      ownerId: "profile-ada",
      involvingMe: false,
    });
    expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledOnce();
    expect(host.sessionData.resetSessionList).not.toHaveBeenCalled();
    expect(host.sessionData.refreshSidebarSessions).not.toHaveBeenCalled();
    controller.set("owner-bob");
    update();
    expect(host.sidebarSessionOwnerFilter()).toEqual({ ownerId: "owner-bob", involvingMe: false });
    expect(host.sessionData.refreshSidebarSessions).toHaveBeenCalledOnce();
    expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledOnce();
  });

  it.each([null, undefined])("uses everyone when self identity is %s", (selfUser) => {
    const { controller, context, host, update } = fixture();
    context.gateway.snapshot.selfUser = selfUser;
    controller.hostConnected();
    update();
    expect(host.sidebarSessionOwnerFilter()).toEqual({ ownerId: null, involvingMe: false });
    context.gateway.snapshot.selfUser = { id: "profile-ada" };
    update();
    expect(host.sidebarSessionOwnerFilter()).toEqual({
      ownerId: "profile-ada",
      involvingMe: false,
    });
  });

  it("retains a known profile's filter while reconnect identity is unresolved", () => {
    const { controller, context, host, update } = fixture();
    controller.hostConnected();
    update();
    for (const phase of ["reconnecting", "connected"] as const) {
      context.gateway.snapshot.phase = phase;
      context.gateway.snapshot.selfUser = undefined;
      update();
      expect(host.sidebarSessionOwnerFilter()).toEqual({
        ownerId: "profile-ada",
        involvingMe: false,
      });
      expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledOnce();
      expect(host.sessionData.resetSessionList).not.toHaveBeenCalled();
    }
    context.gateway.snapshot.selfUser = null;
    update();
    expect(host.sidebarSessionOwnerFilter()).toEqual({ ownerId: null, involvingMe: false });

    context.gateway.snapshot.selfUser = { id: "profile-ada" };
    update();
    context.gateway.connection.gatewayUrl = "wss://two.example/ws";
    Object.assign(context.gateway, { connectionRevision: 1 });
    context.gateway.snapshot.selfUser = undefined;
    update();
    expect(host.sidebarSessionOwnerFilter()).toEqual({ ownerId: null, involvingMe: false });
  });

  it.each(["no query change", "replacement profile", "disconnected host"])(
    "does not carry explicit intent into later automatic work after %s",
    (retirement) => {
      const { controller, host, context, update } = fixture();
      controller.hostConnected();
      update();
      controller.set(controller.ownerId, controller.involvingMe);
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
    { ownerId: null, involvingMe: false },
  ])(
    "restores $ownerId/$involvingMe before initial subscription without another read",
    (filter) => {
      storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada", filter);
      const { controller, host, update } = fixture();
      controller.hostConnected();
      expect(controller.ownerId).toBe(filter.ownerId);
      expect(controller.involvingMe).toBe(filter.involvingMe);
      update();
      update();
      expect(host.sessionData.refreshSidebarSessions).not.toHaveBeenCalled();
      expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledOnce();
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
    expect(host.sidebarSessionOwnerFilter()).toEqual({
      ownerId: "profile-bob",
      involvingMe: false,
    });
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

  it("waits for the replacement profile's query before validating its saved owner", async () => {
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

  it("clears absent owners only from a settled complete owner facet", async () => {
    const { controller, host, update, facet } = fixture();
    controller.hostConnected();
    controller.set("owner-bob");
    update();
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
    expect(host.sessionData.refreshSidebarSessions).toHaveBeenCalledOnce();
    expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledOnce();
  });
});
