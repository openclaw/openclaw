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
const activePlacement = {
  state: "active",
  generation: 1,
  createdAtMs: 1,
  updatedAtMs: 1,
  stateChangedAtMs: 1,
  environmentId: "worker-1",
  activeOwnerEpoch: 1,
  workerBundleHash: "a".repeat(64),
  workspaceBaseManifestRef: "base",
  remoteWorkspaceDir: "/workspace",
} satisfies NonNullable<GatewaySessionRow["placement"]>;
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
  it.each([false, true])(
    "retains a probe when the superseded reconciliation fails (latest completes first: %s)",
    async (latestCompletesFirst) => {
      const f = fixture();
      f.owner.browserAvailable = false;
      f.owner.placement = activePlacement;
      const inventoryRead = createDeferred<unknown>();
      const first = createDeferred<boolean>();
      const latest = createDeferred<boolean>();
      const respond = f.request.getMockImplementation()!;
      f.request.mockImplementation((method, params) =>
        method === "environments.list" ? inventoryRead.promise : respond(method, params),
      );
      f.controller.sync(f.owner);
      await settle();
      f.controller.reconcile(() => first.promise);
      inventoryRead.resolve({ environments: [environment] });
      await settle();
      f.controller.reconcile(() => latest.promise);
      if (latestCompletesFirst) {
        latest.resolve(true);
        await settle();
      }
      first.resolve(false);
      await settle();
      if (!latestCompletesFirst) {
        expect(f.commit).not.toHaveBeenCalled();
        latest.resolve(true);
      }
      await settle();
      expect(f.slots()).toEqual(["desktop"]);
      expect(f.request).toHaveBeenCalledTimes(2);
      expect(f.commit).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["metadata", "owner", "failed", "failed-before-result"])(
    "holds completed discovery behind %s reconciliation",
    async (change) => {
      const f = fixture();
      f.owner.browserAvailable = false;
      f.owner.placement = activePlacement;
      f.owner.requestUpdate = vi.fn(() => f.controller.sync(f.owner));
      const inventoryRead = createDeferred<unknown>();
      const reconciled = createDeferred<boolean>();
      const respond = f.request.getMockImplementation()!;
      f.request.mockImplementation((method, params) =>
        method === "environments.list" ? inventoryRead.promise : respond(method, params),
      );
      f.controller.sync(f.owner);
      await settle();
      f.controller.reconcile(async () => {
        const ok = await reconciled.promise;
        f.owner.placement =
          change === "owner"
            ? { ...activePlacement, generation: 2 }
            : { ...activePlacement, updatedAtMs: 10, lastTranscriptAckCursor: 99 };
        f.controller.sync(f.owner);
        return ok;
      });
      if (change === "failed-before-result") {
        reconciled.resolve(false);
        await settle();
      }
      inventoryRead.resolve({ environments: [environment] });
      await settle();
      expect(f.commit).not.toHaveBeenCalled();
      f.request.mockResolvedValue({ session: undefined });
      reconciled.resolve(!change.startsWith("failed"));
      await settle();
      expect(f.slots()).toEqual(change === "metadata" ? ["desktop"] : []);
      expect(f.request).toHaveBeenCalledTimes(change === "owner" ? 3 : 2);
      if (change === "failed-before-result") {
        f.request.mockImplementation(respond);
        f.controller.reconcile(async () => {
          f.owner.placement = { ...activePlacement, updatedAtMs: 20 };
          f.controller.sync(f.owner);
          return true;
        });
        await settle();
        expect(f.slots()).toEqual(["desktop"]);
        expect(f.request).toHaveBeenCalledTimes(4);
      }
    },
  );

  it.each(["sessions.describe", "environments.list", "browser.request"])(
    "keeps metadata-only placement updates out of discovery while %s is pending and after completion",
    async (heldMethod) => {
      const f = fixture();
      f.owner.placement = activePlacement;
      const pending = createDeferred<unknown>();
      const respond = f.request.getMockImplementation()!;
      f.request.mockImplementation((method, params) =>
        method === heldMethod ? pending.promise : respond(method, params),
      );
      f.controller.sync(f.owner);
      await settle();
      const initialCalls = [...f.request.mock.calls];
      for (const cursor of [1, 2, 3]) {
        f.owner.placement = {
          ...activePlacement,
          updatedAtMs: cursor + 10,
          lastTranscriptAckCursor: cursor,
          lastLiveEventAckCursor: cursor * 2,
          diskSpace: {
            status: "ok",
            availableBytes: 100 - cursor,
            totalBytes: 100,
            observedAtMs: cursor + 10,
          },
        };
        f.controller.sync(f.owner);
        await settle();
        expect(f.request.mock.calls).toEqual(initialCalls);
      }
      pending.resolve(await respond(heldMethod));
      await settle();
      expect(f.slots().toSorted()).toEqual(["browser", "desktop"]);
      expect(f.request).toHaveBeenCalledTimes(3);
      f.owner.placement = { ...activePlacement, updatedAtMs: 100, lastTranscriptAckCursor: 99 };
      f.controller.sync(f.owner);
      await settle();
      expect(f.request).toHaveBeenCalledTimes(3);
      expect(f.commit).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { name: "lifecycle state", placement: { ...activePlacement, state: "reclaimed" as const } },
    { name: "generation", placement: { ...activePlacement, generation: 2 } },
    { name: "environment", placement: { ...activePlacement, environmentId: "worker-2" } },
    { name: "owner epoch", placement: { ...activePlacement, activeOwnerEpoch: 2 } },
    {
      name: "device",
      placement: {
        ...activePlacement,
        runner: { kind: "device" as const, deviceId: "node-2", status: "available" as const },
      },
    },
    {
      name: "device availability",
      placement: {
        ...activePlacement,
        runner: { kind: "device" as const, deviceId: "node-1", status: "offline" as const },
      },
    },
  ])("re-probes and fences the pending old owner when $name changes", async ({ placement }) => {
    const f = fixture();
    f.owner.browserAvailable = false;
    f.owner.placement =
      "runner" in placement
        ? {
            ...activePlacement,
            runner: { kind: "device", deviceId: "node-1", status: "available" },
          }
        : activePlacement;
    const pending = createDeferred<unknown>();
    f.request.mockImplementationOnce(async () => pending.promise);
    f.controller.sync(f.owner);
    f.request.mockResolvedValue({ session: undefined });
    f.owner.placement = placement;
    f.controller.sync(f.owner);
    await settle();
    expect(f.request).toHaveBeenCalledTimes(2);
    pending.resolve({ session });
    await settle();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each(["sessionId", "execNode", "archived"] as const)(
    "re-probes and fences a changed %s",
    async (field) => {
      const f = fixture();
      f.owner.browserAvailable = false;
      f.owner.sessionId = "session-id";
      f.owner.execNode = "node-1";
      f.owner.placement = {
        state: "local",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
      };
      const pending = createDeferred<unknown>();
      f.request.mockImplementationOnce(async () => pending.promise);
      f.controller.sync(f.owner);
      f.request.mockResolvedValue({ session: undefined });
      if (field === "archived") {
        f.owner.archived = true;
      } else {
        f.owner[field] = "replacement";
      }
      f.controller.sync(f.owner);
      await settle();
      pending.resolve({ session });
      await settle();
      expect(f.request).toHaveBeenCalledTimes(2);
      expect(f.commit).not.toHaveBeenCalled();
    },
  );

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
