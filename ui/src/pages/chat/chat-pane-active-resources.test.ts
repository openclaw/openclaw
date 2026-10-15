import type { EnvironmentsListResult } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionRowObservation } from "../../lib/sessions/session-capability.ts";
import { ChatPaneActiveResources, type ActiveResourceOwner } from "./chat-pane-active-resources.ts";
import { normalizeSidebarLayout } from "./sidebar-layout-normalize.ts";
import {
  closeSlot,
  ensureSidebarConversation,
  isSidebarSlotVisible,
  openSlot,
  promoteSidebarPanel,
  sidebarActivePanel,
  type SidebarLayout,
} from "./sidebar-layout.ts";

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
  let observed: GatewaySessionRow | null = session;
  const observation: SessionRowObservation = {
    get row() {
      return observed;
    },
    get sessionId() {
      return observed?.sessionId ?? null;
    },
    hasObserved: true,
    isCurrent: () => live,
    dispose: () => {},
    captureReconcile: () => (row) => {
      observed = row ?? null;
      return { status: "current", row: observed };
    },
  };
  const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async (method) => {
    if (method === "sessions.describe") {
      return {
        session: {
          ...session,
          sessionId: owner.sessionId,
          placement: owner.placement,
          execNode: owner.execNode,
          archived: owner.archived,
        },
      };
    }
    if (method === "environments.status") {
      return environment;
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
    sessions: {
      describe: (params) => owner.client.request("sessions.describe", params),
    },
    observation,
    sessionKey: key,
    sessionId: session.sessionId,
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
  const controller = new ChatPaneActiveResources();
  return {
    owner,
    request,
    commit,
    controller,
    desktopSource: () =>
      controller.desktopSource(owner.client, key, owner.agentId, owner.connectionEpoch, owner),
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
  it("retains a visible verified Desktop when another resource is dismissed", async () => {
    const f = fixture();
    f.controller.sync(f.owner);
    await settle();
    f.setLayout({
      ...closeSlot(promoteSidebarPanel(f.owner.layout(), "desktop"), "browser"),
      resourceAutoOpenDismissed: true,
    });
    f.controller.sync(f.owner);
    await settle();
    expect(f.desktopSource()).toBe("worker-1");
    expect(f.slots()).not.toContain("browser");
  });

  it.each(["binding"])("discovers resources after the %s identity changes", async () => {
    const f = fixture();
    f.owner.browserAvailable = false;
    const pending = createDeferred<unknown>();
    f.request.mockImplementationOnce(async () => pending.promise);
    f.controller.sync(f.owner);
    await settle();
    f.owner.observation.isCurrent = () => false;
    f.controller.sync({
      ...f.owner,
      observation: { ...f.owner.observation, isCurrent: () => true },
    });
    await settle();
    expect(f.slots()).toEqual(["desktop"]);
    pending.resolve({ session });
    await settle();
    expect(f.slots()).toEqual(["desktop"]);
    expect(f.commit).toHaveBeenCalledOnce();
  });

  it.each(["after-resource-swap", "focused-workspace"])(
    "discovers resources while preserving the %s layout",
    async (kind) => {
      const f = fixture();
      const workspace = kind.endsWith("workspace");
      let layout = workspace
        ? openSlot(f.owner.layout(), "workspace")
        : ensureSidebarConversation(f.owner.layout());
      if (kind === "after-resource-swap") {
        layout = closeSlot(promoteSidebarPanel(openSlot(layout, "desktop"), "desktop"), "desktop");
      }
      f.setLayout(
        workspace
          ? { ...layout, expanded: true, expandedSide: true }
          : normalizeSidebarLayout({ ...layout, open: false }),
      );
      f.controller.sync(f.owner);
      await settle();
      expect(f.slots().toSorted()).toEqual([
        "browser",
        ...(workspace ? ["desktop", "workspace"] : ["conversation", "desktop"]),
      ]);
      if (kind === "focused-workspace") {
        expect(isSidebarSlotVisible(f.owner.layout(), "workspace")).toBe(true);
        expect(isSidebarSlotVisible(f.owner.layout(), "conversation")).toBe(false);
      } else {
        expect(f.owner.layout().open).toBe(true);
      }
    },
  );

  it.each(["environment", "reclaimed", "session instance"])(
    "fences a published desktop immediately when its %s changes",
    async (change) => {
      const f = fixture();
      f.owner.browserAvailable = false;
      f.owner.placement = activePlacement;
      f.owner.sessionId = "session-id";
      const source = f.desktopSource;
      f.controller.sync(f.owner);
      await settle();
      expect(source()).toBe("worker-1");
      f.owner.placement = { ...activePlacement, updatedAtMs: 99, lastTranscriptAckCursor: 10 };
      expect(source()).toBe("worker-1");
      const pending = createDeferred<unknown>();
      f.request.mockImplementationOnce(async () => pending.promise);
      if (change === "session instance") {
        f.owner.sessionId = "replacement-session";
      } else if (change === "reclaimed") {
        f.owner.placement = { ...activePlacement, state: "reclaimed" };
      } else {
        f.owner.placement = { ...activePlacement, environmentId: "worker-2" };
      }
      // Rendering precedes the next sync() call; it must not reuse the old target.
      expect(source()).toBeNull();
      f.controller.sync(f.owner);
      await settle();
      expect(source()).toBeNull();
      pending.resolve({ session: undefined });
      await settle();
      expect(source()).toBeNull();
    },
  );

  it.each(["sessions.describe"])(
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
    {
      name: "device",
      placement: {
        ...activePlacement,
        runner: { kind: "device" as const, deviceId: "node-2", status: "available" as const },
      },
    },
  ])(
    "does not reveal an unconfirmed desktop when $name changes during discovery",
    async (change) => {
      const f = fixture();
      f.owner.browserAvailable = false;
      f.owner.placement = {
        ...activePlacement,
        runner: { kind: "device", deviceId: "node-1", status: "available" },
      };
      const pending = createDeferred<unknown>();
      const described = {
        ...session,
        sessionId: f.owner.sessionId,
        execNode: f.owner.execNode,
        placement: f.owner.placement,
        archived: f.owner.archived,
      };
      f.request.mockImplementationOnce(async () => pending.promise);
      f.controller.sync(f.owner);
      f.owner.placement = change.placement;
      f.request.mockResolvedValueOnce({ session: undefined });
      f.controller.sync(f.owner);
      await settle();
      pending.resolve({ session: described });
      await settle();
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.desktopSource()).not.toBe("worker-1");
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
      "environments.status",
      "sessions.describe",
      "browser.request",
      "environments.status",
    ]);
    expect(f.request).toHaveBeenCalledWith("environments.status", { environmentId: "worker-1" });
    expect(f.request).toHaveBeenCalledWith("browser.request", {
      method: "GET",
      path: "/tabs",
      target: "node",
      node: "browser-node",
      query: { profile: "session-profile" },
    });
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
    expect(f.desktopSource()).toBe("worker-1");
    f.owner.placement = { ...activePlacement, state: "local" };
    f.request.mockResolvedValueOnce({ session: { ...session, placement: f.owner.placement } });
    f.controller.invalidate();
    f.controller.sync(f.owner);
    await settle();
    expect(f.desktopSource()).toBeNull();
    expect(f.commit).toHaveBeenCalledTimes(1);
  });

  it.each(["before discovery", "during discovery"])(
    "leaves a manual desktop opened %s with its presentation owner",
    async (when) => {
      const f = fixture();
      f.owner.browserAvailable = false;
      if (when === "before discovery") {
        f.setLayout(openSlot(openSlot(f.owner.layout(), "desktop"), "workspace"));
        f.controller.sync(f.owner);
        await settle();
        f.controller.reconcileObservation({ requestUpdate: () => {}, updated: async () => {} });
        await settle();
        expect(f.request).not.toHaveBeenCalled();
        expect(sidebarActivePanel(f.owner.layout())?.slot).toBe("workspace");
      } else {
        const pending = createDeferred<unknown>();
        f.request.mockImplementationOnce(async () => pending.promise);
        f.controller.sync(f.owner);
        f.setLayout(openSlot(f.owner.layout(), "desktop"));
        pending.resolve({ session });
        await settle();
        expect(f.commit).not.toHaveBeenCalled();
        expect(f.desktopSource()).toBeUndefined();
      }
    },
  );

  it("respects persisted dismissal on reentry and during a pending target-status read", async () => {
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

  it.each(["leave"] as const)("rejects stale async responses after %s", async () => {
    const f = fixture();
    const pending = createDeferred<unknown>();
    f.request.mockImplementation(async () => pending.promise);
    f.controller.sync(f.owner);
    f.leave();
    f.controller.sync(null);
    pending.resolve({ session, running: true, tabs: [{ targetId: "target-1" }] });
    await settle();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.desktopSource()).toBeUndefined();
  });

  it.each([
    { name: "missing attachment identity", row: { ...session, sessionId: undefined } },
    { name: "another session", row: { ...session, key: "agent:main:other" } },
    { name: "offline environment", row: session, env: { ...environment, status: "unavailable" } },
    {
      name: "another worker owner",
      row: session,
      env: {
        ...environment,
        worker: { ...environment.worker, attachedSessionIds: ["someone-else"] },
      },
    },
  ])("ignores $name", async ({ name, row, env }) => {
    const f = fixture();
    f.owner.browserTab = undefined;
    if (name === "missing attachment identity") {
      f.owner.browserAvailable = false;
    }
    f.request.mockImplementation(async (method) =>
      method === "sessions.describe" ? { session: row } : (env ?? environment),
    );
    f.controller.sync(f.owner);
    await settle();
    if (name === "missing attachment identity") {
      expect(f.request.mock.calls.map(([method]) => method)).toEqual(["sessions.describe"]);
    }
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each([
    { running: true, tabs: [{ targetId: "target-1", urlUnavailableReason: "navigation_blocked" }] },
  ])("does not treat stale or blocked browser history as an active tab (%j)", async (snapshot) => {
    const f = fixture();
    f.owner.desktopAvailable = false;
    f.request.mockImplementation(async (method) =>
      method === "sessions.describe" ? { session } : snapshot,
    );
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
