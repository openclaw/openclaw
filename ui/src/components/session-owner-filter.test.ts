/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
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

beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));
afterEach(() => {
  cleanupSolid();
  vi.unstubAllGlobals();
});

function fixture(snapshot: Partial<ApplicationGatewaySnapshot> = {}) {
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
    ...snapshot,
  });
  gateway.connection.gatewayUrl = "wss://one.example/ws";
  let facet: SessionListSnapshot | undefined;
  let invalidate = () => {};
  const filter = new SessionOwnerFilter(
    () => gateway,
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
  connect();
  return {
    host,
    filter,
    connect,
    disconnect,
    gateway,
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

function expectOwner(
  host: ReturnType<typeof fixture>["host"],
  ownerId: string | null,
  involvingMe = false,
) {
  expect(host.sidebarSessionOwnerFilter()).toEqual({ ownerId, involvingMe });
}

function expectReads(host: ReturnType<typeof fixture>["host"], scheduled: number, refreshed = 0) {
  expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledTimes(scheduled);
  expect(host.sessionData.refreshSidebarSessions).toHaveBeenCalledTimes(refreshed);
}

describe("sidebar owner filter", () => {
  it("schedules the default self filter and immediately refreshes explicit owner choices", () => {
    const { filter, host, update } = fixture();
    update();
    expectOwner(host, "profile-ada");
    expectReads(host, 1);
    expect(host.sessionData.resetSessionList).not.toHaveBeenCalled();
    filter.set("owner-bob");
    update();
    expectOwner(host, "owner-bob");
    expectReads(host, 1, 1);
  });

  it.each([null, undefined])("uses everyone when self identity is %s", (selfUser) => {
    const { gateway, host, update } = fixture({ selfUser });
    update();
    expectOwner(host, null);
    gateway.snapshot.selfUser = { id: "profile-ada" };
    update();
    expectOwner(host, "profile-ada");
  });

  it("retains a known profile's filter while reconnect identity is unresolved", () => {
    const { gateway, host, update } = fixture();
    update();
    for (const phase of ["reconnecting", "connected"] as const) {
      gateway.snapshot.phase = phase;
      gateway.snapshot.selfUser = undefined;
      update();
      expectOwner(host, "profile-ada");
      expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledOnce();
      expect(host.sessionData.resetSessionList).not.toHaveBeenCalled();
    }
    gateway.snapshot.selfUser = null;
    update();
    expectOwner(host, null);

    gateway.snapshot.selfUser = { id: "profile-ada" };
    update();
    gateway.connection.gatewayUrl = "wss://two.example/ws";
    Object.assign(gateway, { connectionRevision: 1 });
    gateway.snapshot.selfUser = undefined;
    update();
    expectOwner(host, null);
  });

  it.each(["no query change", "replacement profile", "disconnected host"])(
    "does not carry explicit intent into later automatic work after %s",
    (retirement) => {
      const { connect, disconnect, filter, host, gateway, update } = fixture();
      update();
      filter.set(filter.read().ownerId, filter.read().involvingMe);
      if (retirement === "no query change") {
        update();
      } else if (retirement === "disconnected host") {
        disconnect();
        connect();
      }
      gateway.snapshot.selfUser = { id: "replacement-profile" };
      update();
      expectReads(host, 2);
      expectOwner(host, "replacement-profile");
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
      const { filter, host, update } = fixture();
      expect(filter.read()).toMatchObject(savedFilter);
      update();
      update();
      expectReads(host, 1);
      expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada")).toEqual(
        savedFilter,
      );
      const reloaded = fixture();
      expect(reloaded.host.sidebarSessionOwnerFilter()).toEqual(savedFilter);
    },
  );

  it("keeps profiles and gateways isolated, including a temporarily unavailable identity", () => {
    const { filter, gateway, update, host } = fixture();
    update();
    filter.set("owner-ada");
    update();
    storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-bob", {
      ownerId: null,
      involvingMe: true,
    });
    gateway.snapshot.selfUser = null;
    update();
    expectOwner(host, null);
    gateway.snapshot.selfUser = { id: "profile-bob" };
    update();
    expectOwner(host, null, true);
    gateway.connection.gatewayUrl = "wss://two.example/ws";
    update();
    expectOwner(host, "profile-bob");
    filter.set("owner-two");
    update();
    gateway.connection.gatewayUrl = "wss://one.example/ws";
    gateway.snapshot.selfUser = { id: "profile-ada" };
    update();
    expect(filter.read().ownerId).toBe("owner-ada");
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-bob")).toEqual({
      ownerId: null,
      involvingMe: true,
    });
  });

  it("waits for the replacement profile's query before validating its saved owner", async () => {
    const { filter, host, gateway, update, facet } = fixture();
    update();
    facet(ownerFacet("owner-ada"));
    storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-bob", {
      ownerId: "owner-bob",
      involvingMe: false,
    });
    const pending = createDeferred();
    host.sessionData.scheduleSidebarSessions.mockReturnValueOnce(pending.promise);
    gateway.snapshot.selfUser = { id: "profile-bob" };
    update();
    facet(ownerFacet("owner-ada"));
    expect(filter.read().ownerId).toBe("owner-bob");
    expectReads(host, 2);
    facet(ownerFacet("owner-bob"));
    pending.resolve();
    await pending.promise;
    update();
    expect(filter.read().ownerId).toBe("owner-bob");
    expectReads(host, 2);
  });

  it("clears absent owners only from a settled complete owner facet", async () => {
    const { filter, host, update, facet } = fixture();
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
    expectReads(host, 1, 1);
  });
});
