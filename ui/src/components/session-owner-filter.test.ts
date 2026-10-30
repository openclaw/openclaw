/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import type { SessionListSnapshot } from "../lib/sessions/session-capability.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  loadStoredSidebarSessionOwnerFilter,
  storeSidebarSessionOwnerFilter,
} from "./app-sidebar-session-types.ts";
import { createSessionOwnerFilterQuery, SessionOwnerFilter } from "./session-owner-filter.ts";

beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));
afterEach(() => vi.unstubAllGlobals());

const gatewayUrl = "wss://one.example/ws";
const choice = (ownerId: string | null, involvingMe = false) => ({ ownerId, involvingMe });
const saved = (profile = "profile-ada") => loadStoredSidebarSessionOwnerFilter(gatewayUrl, profile);

function fixture(snapshot: Partial<ApplicationGatewaySnapshot> = {}) {
  const { gateway } = createApplicationGateway();
  Object.assign(gateway.snapshot, {
    phase: "connected",
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    selfUser: { id: "profile-ada" },
    ...snapshot,
  });
  gateway.connection.gatewayUrl = gatewayUrl;
  let facet: SessionListSnapshot | undefined;
  let invalidate = () => {};
  const filter = new SessionOwnerFilter(
    () => gateway,
    () => invalidate(),
  );
  const host = {
    isConnected: false,
    sidebarSessionOwnerFilter: () => {
      const { ownerId, involvingMe } = filter.read();
      return { ownerId, involvingMe };
    },
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
  const update = (patch: Partial<ApplicationGatewaySnapshot> = {}, url?: string) => {
    Object.assign(gateway.snapshot, patch);
    if (url) {
      gateway.connection.gatewayUrl = url;
    }
    invalidate();
    flush();
  };
  connect();
  const setFacet = (value: SessionListSnapshot) => {
    facet = value;
    update();
  };
  return { host, filter, connect, disconnect, gateway, update, facet: setFacet };
}
function ownerFacet(id: string): SessionListSnapshot {
  const result = { ...sessionsResult([], 1), owners: [{ type: "human" as const, id }] };
  return { result, loading: false, error: null, agentId: "main", readSucceeded: true };
}

type Host = ReturnType<typeof fixture>["host"];
function expectOwner(host: Host, ownerId: string | null, involvingMe = false) {
  expect(host.sidebarSessionOwnerFilter()).toEqual(choice(ownerId, involvingMe));
}

function expectReads(host: ReturnType<typeof fixture>["host"], scheduled: number, refreshed = 0) {
  expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledTimes(scheduled);
  expect(host.sessionData.refreshSidebarSessions).toHaveBeenCalledTimes(refreshed);
}

describe("sidebar owner filter", () => {
  it("retains a known profile's filter while reconnect identity is unresolved", () => {
    const { gateway, host, update } = fixture();
    update();
    for (const phase of ["reconnecting", "connected"] as const) {
      update({ phase, selfUser: undefined });
      expectOwner(host, "profile-ada");
      expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledOnce();
      expect(host.sessionData.resetSessionList).not.toHaveBeenCalled();
    }
    update({ selfUser: null });
    expectOwner(host, null);

    update({ selfUser: { id: "profile-ada" } });
    Object.assign(gateway, { connectionRevision: 1 });
    update({ selfUser: undefined }, "wss://two.example/ws");
    expectOwner(host, null);
  });

  it.each(["no query change", "replacement profile", "disconnected host"])(
    "does not carry explicit intent into later automatic work after %s",
    (retirement) => {
      const { connect, disconnect, filter, host, update } = fixture();
      update();
      filter.set(filter.read().ownerId, filter.read().involvingMe);
      if (retirement === "no query change") {
        update();
      } else if (retirement === "disconnected host") {
        disconnect();
        connect();
      }
      update({ selfUser: { id: "replacement-profile" } });
      expectReads(host, 2);
      expectOwner(host, "replacement-profile");
    },
  );

  it.each([choice("owner-bob"), choice(null, true), choice(null)])(
    "restores $ownerId/$involvingMe before initial subscription without another read",
    (savedFilter) => {
      storeSidebarSessionOwnerFilter(gatewayUrl, "profile-ada", savedFilter);
      const { filter, host, update } = fixture();
      expect(filter.read()).toMatchObject(savedFilter);
      update();
      update();
      expectReads(host, 1);
      expect(saved()).toEqual(savedFilter);
      expect(fixture().host.sidebarSessionOwnerFilter()).toEqual(savedFilter);
    },
  );

  describe("guest default", () => {
    const auth = (scopes: string[], sessionCap?: "view" | "write") =>
      ({
        hello: { auth: { role: "operator", scopes, sessionCap } },
      }) as unknown as Partial<ApplicationGatewaySnapshot>;
    const guest = auth(["operator.sessions.write"], "view");

    it("starts a guest without a saved choice on Involving me, then keeps their later choice", () => {
      const { filter, host, update } = fixture(guest);
      update();
      expectOwner(host, null, true);
      expect(localStorage.length).toBe(0);
      filter.set("profile-ada");
      expect(fixture(guest).host.sidebarSessionOwnerFilter()).toEqual(choice("profile-ada"));
    });

    it.each([choice("profile-ada"), choice("owner-bob"), choice(null)])(
      "keeps a guest's saved $ownerId choice",
      (savedFilter) => {
        storeSidebarSessionOwnerFilter(gatewayUrl, "profile-ada", savedFilter);
        expect(fixture(guest).host.sidebarSessionOwnerFilter()).toEqual(savedFilter);
      },
    );

    it.each([
      ["team member", auth(["operator.read", "operator.write"], "view")],
      ["write role", auth(["operator.sessions.write"], "write")],
      ["admin operator", auth(["operator.admin"])],
      ["legacy hello", {}],
    ])("keeps the own-sessions default: %s", (_label, snapshot) => {
      expect(fixture(snapshot).host.sidebarSessionOwnerFilter()).toEqual(choice("profile-ada"));
    });
  });

  it("keeps profiles and gateways isolated, including a temporarily unavailable identity", () => {
    const { filter, update, host } = fixture();
    update();
    filter.set("owner-ada");
    update();
    storeSidebarSessionOwnerFilter(gatewayUrl, "profile-bob", choice(null, true));
    update({ selfUser: null });
    expectOwner(host, null);
    update({ selfUser: { id: "profile-bob" } });
    expectOwner(host, null, true);
    update({}, "wss://two.example/ws");
    expectOwner(host, "profile-bob");
    filter.set("owner-two");
    update();
    update({ selfUser: { id: "profile-ada" } }, gatewayUrl);
    expect(filter.read().ownerId).toBe("owner-ada");
    expect(saved("profile-bob")).toEqual(choice(null, true));
  });

  it("waits for the replacement profile's query before validating its saved owner", async () => {
    const { filter, host, update, facet } = fixture();
    update();
    facet(ownerFacet("owner-ada"));
    storeSidebarSessionOwnerFilter(gatewayUrl, "profile-bob", choice("owner-bob"));
    const pending = createDeferred();
    host.sessionData.scheduleSidebarSessions.mockReturnValueOnce(pending.promise);
    update({ selfUser: { id: "profile-bob" } });
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
    expect(saved()).toEqual(choice(null));
    update();
    expectReads(host, 1, 1);
  });
});
