/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import type { SessionListSnapshot } from "../lib/sessions/session-capability.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  loadStoredSidebarSessionOwnerFilter,
  storeSidebarSessionOwnerFilter,
} from "./app-sidebar-session-types.ts";
import { createSessionOwnerFilterQuery, SessionOwnerFilter } from "./session-owner-filter.ts";

let originalLocalStorage: PropertyDescriptor | undefined;
beforeEach(() => {
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createStorageMock(),
  });
});
afterEach(() => {
  cleanupSolid();
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
  let invalidate = () => {};
  const filter = new SessionOwnerFilter(
    () => context.gateway,
    () => invalidate(),
  );
  const host = {
    isConnected: false,
    sidebarSessionOwnerFilter: () => ({
      ownerId: filter.read().ownerId,
      involvingMe: filter.read().involvingMe,
    }),
    sessionData: {
      resetSessionList: vi.fn(),
      refreshSidebarSessions: vi.fn(() => Promise.resolve()),
      scheduleSidebarSessions: vi.fn(() => Promise.resolve()),
    },
  };
  let mounted: ReturnType<typeof mountSolid> | undefined;
  const connect = () => {
    host.isConnected = false;
    mounted = mountSolid(() => {
      const [revision, setRevision] = createSignal(0);
      invalidate = () => setRevision((value) => value + 1);
      createSessionOwnerFilterQuery(
        filter,
        () => {
          revision();
          return host;
        },
        () => facet,
      );
      return null;
    });
    host.isConnected = true;
  };
  const disconnect = () => {
    host.isConnected = false;
    mounted?.unmount();
  };
  const update = () => {
    invalidate();
    flush();
  };
  return {
    host,
    filter,
    connect,
    disconnect,
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

describe("sidebar owner filter", () => {
  it("schedules the default self filter and immediately refreshes explicit owner choices", () => {
    const { connect, filter, host, update } = fixture();
    connect();
    update();
    expect(host.sidebarSessionOwnerFilter()).toEqual({
      ownerId: "profile-ada",
      involvingMe: false,
    });
    expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledOnce();
    expect(host.sessionData.resetSessionList).not.toHaveBeenCalled();
    expect(host.sessionData.refreshSidebarSessions).not.toHaveBeenCalled();
    filter.set("owner-bob");
    update();
    expect(host.sidebarSessionOwnerFilter()).toEqual({ ownerId: "owner-bob", involvingMe: false });
    expect(host.sessionData.refreshSidebarSessions).toHaveBeenCalledOnce();
    expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledOnce();
  });

  it.each([null, undefined])("uses everyone when self identity is %s", (selfUser) => {
    const { connect, context, host, update } = fixture();
    context.gateway.snapshot.selfUser = selfUser;
    connect();
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
    const { connect, context, host, update } = fixture();
    connect();
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
      const { connect, disconnect, filter, host, context, update } = fixture();
      connect();
      update();
      filter.set(filter.read().ownerId, filter.read().involvingMe);
      if (retirement === "no query change") {
        update();
      } else if (retirement === "disconnected host") {
        disconnect();
        connect();
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
    (savedFilter) => {
      storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada", savedFilter);
      const { connect, filter, host, update } = fixture();
      connect();
      expect(filter.read().ownerId).toBe(savedFilter.ownerId);
      expect(filter.read().involvingMe).toBe(savedFilter.involvingMe);
      update();
      update();
      expect(host.sessionData.refreshSidebarSessions).not.toHaveBeenCalled();
      expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledOnce();
      expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada")).toEqual(
        savedFilter,
      );
      const reloaded = fixture();
      reloaded.connect();
      expect(reloaded.host.sidebarSessionOwnerFilter()).toEqual(savedFilter);
    },
  );

  it("keeps profiles and gateways isolated, including a temporarily unavailable identity", () => {
    const { connect, filter, context, update, host } = fixture();
    connect();
    update();
    filter.set("owner-ada");
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
    filter.set("owner-two");
    update();
    context.gateway.connection.gatewayUrl = "wss://one.example/ws";
    context.gateway.snapshot.selfUser = { id: "profile-ada" };
    update();
    expect(filter.read().ownerId).toBe("owner-ada");
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-bob")).toEqual({
      ownerId: null,
      involvingMe: true,
    });
  });

  it("waits for the replacement profile's query before validating its saved owner", async () => {
    const { connect, filter, host, context, update, facet } = fixture();
    connect();
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
    expect(filter.read().ownerId).toBe("owner-bob");
    expect(host.sessionData.refreshSidebarSessions).not.toHaveBeenCalled();
    expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledTimes(2);
    facet(ownerFacet("owner-bob"));
    pending.resolve();
    await pending.promise;
    update();
    expect(filter.read().ownerId).toBe("owner-bob");
    expect(host.sessionData.refreshSidebarSessions).not.toHaveBeenCalled();
    expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledTimes(2);
  });

  it("clears absent owners only from a settled complete owner facet", async () => {
    const { connect, filter, host, update, facet } = fixture();
    connect();
    filter.set("owner-bob");
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
      expect(filter.read().ownerId).toBe("owner-bob");
    }
    facet(ownerFacet("owner-bob"));
    expect(filter.read().ownerId).toBe("owner-bob");
    facet(ownerFacet("profile-ada"));
    expect(filter.read().ownerId).toBeNull();
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada")).toEqual({
      ownerId: null,
      involvingMe: false,
    });
    update();
    expect(host.sessionData.refreshSidebarSessions).toHaveBeenCalledOnce();
    expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledOnce();
  });
});
