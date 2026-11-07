/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
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
      createSessionOwnerFilterQuery(filter, () => {
        revision();
        return host;
      });
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
  return { host, filter, connect, disconnect, gateway, update };
}

function expectOwner(
  host: ReturnType<typeof fixture>["host"],
  ownerId: string | null,
  involvingMe = false,
) {
  expect(host.sidebarSessionOwnerFilter()).toEqual(choice(ownerId, involvingMe));
}

function expectReads(host: ReturnType<typeof fixture>["host"], scheduled: number, refreshed = 0) {
  expect(host.sessionData.scheduleSidebarSessions).toHaveBeenCalledTimes(scheduled);
  expect(host.sessionData.refreshSidebarSessions).toHaveBeenCalledTimes(refreshed);
}

describe("sidebar owner filter", () => {
  it("retains a known profile's filter while reconnect identity is unresolved", () => {
    storeSidebarSessionOwnerFilter(gatewayUrl, "profile-ada", choice("profile-ada"));
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
      expectOwner(host, null);
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
    ])("shows all authorized owners by default: %s", (_label, snapshot) => {
      expect(fixture(snapshot).host.sidebarSessionOwnerFilter()).toEqual(choice(null));
    });
  });

  describe("authenticated person-timeline admission", () => {
    const hello = (viewerId?: string | null, sessionCap = "view") =>
      ({
        auth: {
          role: "operator",
          scopes: ["operator.sessions.write"],
          roleAllowsAdmin: false,
          sessionCap,
          ...(viewerId !== undefined ? { profileActivityViewerId: viewerId } : {}),
        },
      }) as NonNullable<ApplicationGatewaySnapshot["hello"]>;

    it.each(["write", "suggest", "view", "invited", "none"])(
      "admits a restored owner before a %s role's first query",
      (sessionCap) => {
        storeSidebarSessionOwnerFilter(gatewayUrl, "profile-ada", choice("owner-bob"));
        const { host, update } = fixture({ hello: hello("profile-ada", sessionCap) });
        expectOwner(host, null, true);
        update();
        expectReads(host, 1);
        expect(saved()).toEqual(choice(null, true));
      },
    );

    it("keeps a saved choice when a delivered hello has no auth projection", () => {
      storeSidebarSessionOwnerFilter(gatewayUrl, "profile-ada", choice("owner-bob"));
      const { filter, host, update } = fixture({
        // Shipped hellos without auth remain review-only; absence grants no viewer authority.
        hello: { type: "hello-ok", protocol: 4 } as NonNullable<
          ApplicationGatewaySnapshot["hello"]
        >,
      });
      update();
      expectOwner(host, "owner-bob");
      expect(filter.selfUserId).toBe("profile-ada");
      expect(saved()).toEqual(choice("owner-bob"));
    });

    it.each([false, true])(
      "retires prior intent and facets when an equal choice changes profile (new hello=%s)",
      (replaceHello) => {
        storeSidebarSessionOwnerFilter(gatewayUrl, "profile-ada", choice(null));
        storeSidebarSessionOwnerFilter(gatewayUrl, "profile-bob", choice(null));
        const { filter, gateway } = fixture({ hello: hello() });
        const previous = filter.read();
        filter.observeOwnerFacet("main", [{ type: "human", id: "owner-foreign" }]);
        filter.set(null);
        expect(filter.hasMultipleOwners("main")).toBe(true);
        gateway.snapshot.selfUser = { id: "profile-bob" };
        if (replaceHello) {
          gateway.snapshot.hello = hello();
        }
        expect(filter.read()).toMatchObject(choice(null));
        expect(filter.read().scope).not.toBe(previous.scope);
        expect(filter.takeUserIntent()).toBe(false);
        expect(filter.hasMultipleOwners("main")).toBe(false);
        expect(saved("profile-ada")).toEqual(choice(null));
        expect(saved("profile-bob")).toEqual(choice(null));
      },
    );

    it("keeps a broad role's foreign choice despite a reduced socket grant", () => {
      storeSidebarSessionOwnerFilter(gatewayUrl, "profile-ada", choice("owner-bob"));
      const { host, update } = fixture({ hello: hello() });
      update();
      expectOwner(host, "owner-bob");
      expect(saved()).toEqual(choice("owner-bob"));
    });

    it("reconciles a new hello for the same profile but preserves explicit same-hello denial", () => {
      const { filter, host, update } = fixture({ hello: hello() });
      update();
      filter.set("owner-bob");
      update();
      update({ hello: hello("profile-ada") });
      expectOwner(host, null, true);
      expect(saved()).toEqual(choice(null, true));
      filter.set("owner-bob");
      update();
      update();
      expectOwner(host, "owner-bob");
      expect(saved()).toEqual(choice("owner-bob"));
    });

    it("binds replacement admission to the hello identity while old display identity is retained", () => {
      storeSidebarSessionOwnerFilter(gatewayUrl, "profile-ada", choice("owner-before"));
      storeSidebarSessionOwnerFilter(gatewayUrl, "profile-bob", choice("owner-foreign"));
      const { filter, host, update } = fixture({ hello: hello() });
      update();
      update({ phase: "reconnecting", selfUser: undefined });
      expectOwner(host, "owner-before");
      update({ phase: "connected", selfUser: undefined, hello: hello("profile-bob") });
      expectOwner(host, null, true);
      expect(filter.selfUserId).toBe("profile-bob");
      expect(saved("profile-ada")).toEqual(choice("owner-before"));
      expect(saved("profile-bob")).toEqual(choice(null, true));
    });

    it("does not overwrite a retained profile preference for an unidentified restricted hello", () => {
      storeSidebarSessionOwnerFilter(gatewayUrl, "profile-ada", choice("owner-before"));
      const { filter, host, update } = fixture({ hello: hello() });
      update();
      update({ phase: "connected", selfUser: undefined, hello: hello(null) });
      expectOwner(host, null);
      expect(filter.selfUserId).toBeUndefined();
      expect(saved()).toEqual(choice("owner-before"));
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
    expectOwner(host, null);
    filter.set("owner-two");
    update();
    update({ selfUser: { id: "profile-ada" } }, gatewayUrl);
    expect(filter.read().ownerId).toBe("owner-ada");
    expect(saved("profile-bob")).toEqual(choice(null, true));
  });

  it("preserves an explicit owner through settled refreshes and profile replacement", async () => {
    const { filter, host, update } = fixture();
    filter.set("owner-ada");
    update();
    await Promise.resolve();
    update();
    expect(filter.read().ownerId).toBe("owner-ada");
    expect(saved()).toEqual(choice("owner-ada"));
    storeSidebarSessionOwnerFilter(gatewayUrl, "profile-bob", choice("owner-bob"));
    update({ selfUser: { id: "profile-bob" } });
    await Promise.resolve();
    update();
    expect(filter.read().ownerId).toBe("owner-bob");
    expect(saved("profile-bob")).toEqual(choice("owner-bob"));
    expectReads(host, 1, 1);
  });
});
