import { expect, it } from "vitest";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../test-helpers/application-context-fixtures.ts";
import { sidebarOnlineOrder } from "./sidebar-online-state.ts";

it("retains people across transient identity resolution and retires them with the viewer scope", () => {
  const { gateway } = createApplicationGateway(
    createApplicationGatewaySnapshot({
      phase: "connected",
      selfUser: { id: "riley", name: "Riley" },
    }),
  );
  const host = {
    hostElement: document.createElement("div"),
    sessionDataContext: { gateway },
    sidebarSnapshot: null,
  };
  const original = sidebarOnlineOrder(host);
  original.restore(
    [{ id: "riley", name: "Riley", watchedSessions: [] }],
    new Map([["riley", { open: 3, running: 1 }]]),
  );
  gateway.snapshot.phase = "reconnecting";
  gateway.snapshot.selfUser = undefined;
  expect(sidebarOnlineOrder(host)).toBe(original);
  expect(sidebarOnlineOrder(host).users).toHaveLength(1);
  gateway.snapshot.phase = "connected";
  gateway.snapshot.selfUser = { id: "morgan", name: "Morgan" };
  expect(sidebarOnlineOrder(host)).not.toBe(original);
  expect(sidebarOnlineOrder(host).users).toEqual([]);
  const second = sidebarOnlineOrder(host);
  Object.assign(gateway, { connectionRevision: 1 });
  gateway.snapshot.selfUser = undefined;
  expect(sidebarOnlineOrder(host)).not.toBe(second);
  gateway.snapshot.selfUser = { id: "morgan", name: "Morgan" };
  sidebarOnlineOrder(host);
  gateway.snapshot.selfUser = null;
  expect(sidebarOnlineOrder(host).users).toEqual([]);
});
