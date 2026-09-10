import type { EnvironmentsListResult } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { ChatPaneActiveResources, type ActiveResourceOwner } from "./chat-pane-active-resources.ts";
import { normalizeSidebarLayout } from "./sidebar-layout-normalize.ts";
import { openSlot, sidebarActivePanel, type SidebarLayout } from "./sidebar-layout.ts";

const key = "agent:main:resource-test";
const session = {
  key,
  sessionId: "session-id",
  kind: "direct",
  updatedAt: 1,
  placement: { state: "active", environmentId: "worker-1" },
} as GatewaySessionRow;
const environment: EnvironmentsListResult["environments"][number] = {
  id: "worker-1",
  type: "worker",
  status: "available",
  desktop: true,
  worker: {
    providerId: "test",
    state: "attached",
    ageMs: 1,
    attachedSessionIds: ["session-id"],
    tunnelStatus: "connected",
  },
};
const selection = {
  tab: { target: "node", node: "browser-node", profile: "session-profile", targetId: "target-1" },
  revision: "call-1",
} as const;
const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

function fixture() {
  let layout: SidebarLayout = normalizeSidebarLayout(undefined);
  let live = true;
  const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async (method) => {
    if (method === "sessions.describe") {
      return { session };
    }
    if (method === "environments.list") {
      return { environments: [environment] };
    }
    if (method === "browser.request") {
      return { running: true, tabs: [{ targetId: "target-1", url: "https://example.com" }] };
    }
    throw new Error("unexpected method");
  });
  const commit = vi.fn((next: SidebarLayout) => {
    layout = next;
  });
  const owner: ActiveResourceOwner = {
    client: { request } as unknown as GatewayBrowserClient,
    sessionKey: key,
    connectionEpoch: 1,
    placement: session.placement,
    desktopAvailable: true,
    browserAvailable: true,
    browserTab: selection,
    layout: () => layout,
    commit,
    requestUpdate: vi.fn(),
    isCurrent: () => live,
  };
  return {
    owner,
    request,
    commit,
    controller: new ChatPaneActiveResources(),
    setLayout: (next: SidebarLayout) => {
      layout = next;
    },
    leave: () => {
      live = false;
    },
    slots: () => layout.columns.flatMap((column) => column.panels.map((panel) => panel.slot)),
  };
}

describe("session active resource discovery", () => {
  it("reveals existing desktop and exact browser targets once without provisioning or focusing", async () => {
    const f = fixture();
    f.controller.sync(f.owner);
    await settle();
    expect(f.slots().toSorted()).toEqual(["browser", "desktop"]);
    const selected = sidebarActivePanel(f.owner.layout())?.slot;
    f.controller.invalidate();
    f.controller.sync(f.owner);
    await settle();
    expect(f.commit).toHaveBeenCalledTimes(2);
    expect(sidebarActivePanel(f.owner.layout())?.slot).toBe(selected);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "sessions.describe",
      "browser.request",
      "environments.list",
      "sessions.describe",
      "browser.request",
      "environments.list",
    ]);
    expect(f.request).toHaveBeenCalledWith("browser.request", {
      method: "GET",
      path: "/tabs",
      target: "node",
      node: "browser-node",
      query: { profile: "session-profile" },
    });
  });

  it("adds tabs without replacing an existing tool selection or layout geometry", async () => {
    const f = fixture();
    f.setLayout({ ...openSlot(f.owner.layout(), "workspace"), dock: "bottom" });
    f.controller.sync(f.owner);
    await settle();
    expect(f.slots()[0]).toBe("workspace");
    expect(f.slots().toSorted()).toEqual(["browser", "desktop", "workspace"]);
    expect(sidebarActivePanel(f.owner.layout())?.slot).toBe("workspace");
    expect(f.owner.layout().dock).toBe("bottom");
  });

  it("respects an older minimized dock even when the newly discovered resource has no tab", async () => {
    const f = fixture();
    f.setLayout({ ...openSlot(f.owner.layout(), "terminal"), open: false });
    f.controller.sync(f.owner);
    await settle();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.slots()).toEqual(["terminal"]);
  });

  it("retires an automatic desktop without falling back to a stale roster or global source", async () => {
    const f = fixture();
    f.owner.browserAvailable = false;
    f.controller.sync(f.owner);
    await settle();
    expect(
      f.controller.desktopSource(f.owner.client, key, f.owner.agentId, f.owner.connectionEpoch),
    ).toBe("worker-1");
    f.request.mockResolvedValueOnce({ session: { ...session, placement: { state: "local" } } });
    f.controller.invalidate();
    f.controller.sync(f.owner);
    await settle();
    expect(
      f.controller.desktopSource(f.owner.client, key, f.owner.agentId, f.owner.connectionEpoch),
    ).toBeNull();
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.owner.requestUpdate).toHaveBeenCalledTimes(2);
  });

  it("does not override a manual desktop open while discovery is pending", async () => {
    const f = fixture();
    f.owner.browserAvailable = false;
    const pending = createDeferred<unknown>();
    f.request.mockImplementationOnce(async () => pending.promise);
    f.controller.sync(f.owner);
    f.setLayout(openSlot(f.owner.layout(), "desktop"));
    pending.resolve({ session });
    await settle();
    expect(f.commit).not.toHaveBeenCalled();
    expect(
      f.controller.desktopSource(f.owner.client, key, f.owner.agentId, f.owner.connectionEpoch),
    ).toBeUndefined();
  });

  it("leaves an already-present minimized panel alone", async () => {
    const f = fixture();
    f.owner.desktopAvailable = false;
    f.setLayout({ ...openSlot(f.owner.layout(), "browser"), open: false });
    f.controller.sync(f.owner);
    await settle();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.owner.layout().open).toBe(false);
  });

  it("respects persisted dismissal on reentry and during a pending inventory read", async () => {
    const f = fixture();
    const pending = createDeferred<unknown>();
    f.request.mockImplementation(async () => pending.promise);
    f.controller.sync(f.owner);
    f.setLayout(normalizeSidebarLayout({ columns: [], resourceAutoOpenDismissed: true }));
    pending.resolve({ session, running: true, tabs: [{ targetId: "target-1" }] });
    await settle();
    expect(f.commit).not.toHaveBeenCalled();
    f.request.mockClear();
    new ChatPaneActiveResources().sync(f.owner);
    await settle();
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["leave", "session", "agent", "connection", "newer-probe"] as const)(
    "rejects stale async responses after %s",
    async (change) => {
      const f = fixture();
      const pending = createDeferred<unknown>();
      f.request.mockImplementation(async () => pending.promise);
      f.controller.sync(f.owner);
      if (change === "leave") {
        f.leave();
        f.controller.sync(null);
      } else {
        const next = { ...f.owner, desktopAvailable: false, browserAvailable: false };
        if (change === "session") {
          next.sessionKey = "agent:main:other";
        }
        if (change === "connection") {
          next.connectionEpoch += 1;
        }
        if (change === "agent") {
          next.agentId = "other";
        }
        if (change === "newer-probe") {
          f.controller.invalidate();
        }
        f.controller.sync(next);
      }
      pending.resolve({ session, running: true, tabs: [{ targetId: "target-1" }] });
      await settle();
      expect(f.commit).not.toHaveBeenCalled();
      expect(
        f.controller.desktopSource(f.owner.client, key, f.owner.agentId, f.owner.connectionEpoch),
      ).toBeUndefined();
    },
  );

  it.each([
    { name: "no session", row: undefined },
    { name: "another session", row: { ...session, key: "agent:main:other" } },
    { name: "global gateway capability", row: { ...session, placement: { state: "local" } } },
    {
      name: "reclaimed placement",
      row: { ...session, placement: { state: "reclaimed", environmentId: "worker-1" } },
    },
    { name: "offline environment", row: session, env: { ...environment, status: "unavailable" } },
    {
      name: "another worker owner",
      row: session,
      env: {
        ...environment,
        worker: { ...environment.worker, attachedSessionIds: ["someone-else"] },
      },
    },
  ])("ignores $name", async ({ row, env }) => {
    const f = fixture();
    f.owner.browserTab = undefined;
    f.request.mockImplementation(async (method) =>
      method === "sessions.describe" ? { session: row } : { environments: [env ?? environment] },
    );
    f.controller.sync(f.owner);
    await settle();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each([
    { running: false, tabs: [{ targetId: "target-1" }] },
    { running: true, tabs: [{ targetId: "other-target" }] },
    { running: true, tabs: [{ targetId: "target-1", urlUnavailableReason: "navigation_blocked" }] },
  ])("does not treat stale or blocked browser history as an active tab (%j)", async (snapshot) => {
    const f = fixture();
    f.owner.desktopAvailable = false;
    f.request.mockResolvedValue(snapshot);
    f.controller.sync(f.owner);
    await settle();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("does not query a default browser without scoped result metadata", async () => {
    const f = fixture();
    f.owner.desktopAvailable = false;
    f.owner.browserTab = undefined;
    f.controller.sync(f.owner);
    await settle();
    expect(f.request).not.toHaveBeenCalled();
    f.owner.browserTab = selection;
    f.controller.sync(f.owner);
    await settle();
    expect(f.slots()).toEqual(["browser"]);
  });

  it("discovers a newly active desktop on invalidation without repeated render probes", async () => {
    const f = fixture();
    f.owner.browserAvailable = false;
    f.request.mockResolvedValueOnce({
      session: { ...session, placement: { state: "local" } },
    });
    f.controller.sync(f.owner);
    await settle();
    expect(f.commit).not.toHaveBeenCalled();
    f.controller.sync(f.owner);
    expect(f.request).toHaveBeenCalledTimes(1);
    f.controller.invalidate();
    f.controller.sync(f.owner);
    await settle();
    expect(f.slots()).toEqual(["desktop"]);
  });
});
