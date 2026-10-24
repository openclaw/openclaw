import type { EnvironmentsListResult } from "@openclaw/gateway-protocol";
import { createEffect, createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
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
    layout: () => layout,
    commit,
    isCurrent: () => live,
  };
  const controller = new ChatPaneActiveResources();
  return {
    owner,
    request,
    commit,
    controller,
    sync: async () => {
      controller.sync(owner);
      await settle();
    },
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
  it("projects verified desktop changes and releases the view on disposal", async () => {
    const f = fixture();
    const sources: Array<string | null | undefined> = [];
    let refreshBinding: () => void = () => {};
    const dispose = createRoot((release) => {
      const [binding, setBinding] = createSignal(0);
      refreshBinding = () => setBinding((value) => value + 1);
      const resources = projectOwner(f.controller, (owner) =>
        owner.desktopSource(f.owner.client, key, f.owner.agentId, f.owner.connectionEpoch, f.owner),
      );
      createEffect(
        () => {
          binding();
          return resources.read();
        },
        (source) => {
          sources.push(source);
        },
      );
      return release;
    });
    try {
      flush();
      expect(sources).toEqual([undefined]);
      await f.sync();
      flush();
      expect(sources).toEqual([undefined, "worker-1"]);

      f.owner.observation.isCurrent = () => false;
      refreshBinding();
      flush();
      expect(sources).toEqual([undefined, "worker-1", null]);
      f.controller.sync({
        ...f.owner,
        observation: { ...f.owner.observation, isCurrent: () => true },
      });
      await settle();
      flush();
      expect(sources).toEqual([undefined, "worker-1", null, "worker-1"]);

      const respond = f.request.getMockImplementation()!;
      f.request.mockImplementation((method, params) =>
        method === "environments.status"
          ? Promise.resolve({ ...environment, status: "unavailable" })
          : respond(method, params),
      );
      // Revalidation discovers retirement without a renderer scheduling another sync.
      f.controller.reconcileObservation();
      await settle();
      flush();
      expect(sources).toEqual([undefined, "worker-1", null, "worker-1", null]);

      dispose();
      f.request.mockImplementation(respond);
      f.controller.invalidate();
      f.controller.sync({
        ...f.owner,
        observation: { ...f.owner.observation, isCurrent: () => true },
      });
      await settle();
      flush();
      expect(f.desktopSource()).toBe("worker-1");
      expect(sources).toEqual([undefined, "worker-1", null, "worker-1", null]);
    } finally {
      dispose();
    }
  });

  it("retains a visible verified Desktop when another resource is dismissed", async () => {
    const f = fixture();
    await f.sync();
    f.setLayout({
      ...closeSlot(promoteSidebarPanel(f.owner.layout(), "desktop"), "browser"),
      resourceAutoOpenDismissed: true,
    });
    await f.sync();
    expect(f.desktopSource()).toBe("worker-1");
    expect(f.slots()).not.toContain("browser");
  });

  it("discovers resources after the binding identity changes", async () => {
    const f = fixture();
    const pending = createDeferred<unknown>();
    f.request.mockImplementationOnce(async () => pending.promise);
    await f.sync();
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
      await f.sync();
      expect(f.slots().toSorted()).toEqual(
        workspace ? ["desktop", "workspace"] : ["conversation", "desktop"],
      );
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
      f.owner.placement = activePlacement;
      f.owner.sessionId = "session-id";
      const source = f.desktopSource;
      await f.sync();
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
      await f.sync();
      expect(source()).toBeNull();
      pending.resolve({ session: undefined });
      await settle();
      expect(source()).toBeNull();
    },
  );

  it("keeps metadata-only placement updates out of discovery while the descriptor is pending and after completion", async () => {
    const f = fixture();
    f.owner.placement = activePlacement;
    const pending = createDeferred<unknown>();
    const respond = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params) =>
      method === "sessions.describe" ? pending.promise : respond(method, params),
    );
    await f.sync();
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
      await f.sync();
      expect(f.request.mock.calls).toEqual(initialCalls);
    }
    pending.resolve(await respond("sessions.describe"));
    await settle();
    expect(f.slots().toSorted()).toEqual(["desktop"]);
    expect(f.request).toHaveBeenCalledTimes(2);
    f.owner.placement = { ...activePlacement, updatedAtMs: 100, lastTranscriptAckCursor: 99 };
    await f.sync();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.commit).toHaveBeenCalledTimes(1);
  });

  it("does not reveal an unconfirmed desktop when its device changes during discovery", async () => {
    const f = fixture();
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
    f.owner.placement = {
      ...activePlacement,
      runner: { kind: "device", deviceId: "node-2", status: "available" },
    };
    f.request.mockResolvedValueOnce({ session: undefined });
    await f.sync();
    pending.resolve({ session: described });
    await settle();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.desktopSource()).not.toBe("worker-1");
  });

  it("reveals the existing desktop once without provisioning", async () => {
    const f = fixture();
    await f.sync();
    expect(f.slots().toSorted()).toEqual(["desktop"]);
    const selected = sidebarActivePanel(f.owner.layout())?.slot;
    f.controller.invalidate();
    await f.sync();
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(sidebarActivePanel(f.owner.layout())?.slot).toBe(selected);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "sessions.describe",
      "environments.status",
      "sessions.describe",
      "environments.status",
    ]);
    expect(f.request).toHaveBeenCalledWith("environments.status", { environmentId: "worker-1" });
  });

  it("respects an older minimized dock even when the newly discovered resource has no tab", async () => {
    const f = fixture();
    f.setLayout({ ...openSlot(f.owner.layout(), "terminal"), open: false });
    await f.sync();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.slots()).toEqual(["terminal"]);
  });

  it("clears a discovered desktop source without falling back to a stale roster or global source", async () => {
    const f = fixture();
    await f.sync();
    expect(f.desktopSource()).toBe("worker-1");
    f.owner.placement = { ...activePlacement, state: "local" };
    f.request.mockResolvedValueOnce({ session: { ...session, placement: f.owner.placement } });
    f.controller.invalidate();
    await f.sync();
    expect(f.desktopSource()).toBeNull();
  });

  it.each(["before discovery", "during discovery"])(
    "leaves a manual desktop opened %s with its presentation owner",
    async (when) => {
      const f = fixture();
      if (when === "before discovery") {
        f.setLayout(openSlot(openSlot(f.owner.layout(), "desktop"), "workspace"));
        await f.sync();
        f.controller.reconcileObservation();
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

  it("rejects stale async responses after leaving", async () => {
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
    f.request.mockImplementation(async (method) =>
      method === "sessions.describe" ? { session: row } : (env ?? environment),
    );
    await f.sync();
    if (name === "missing attachment identity") {
      expect(f.request.mock.calls.map(([method]) => method)).toEqual(["sessions.describe"]);
    }
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("discovers a newly active desktop on invalidation without repeated render probes", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({
      session: { ...session, placement: { state: "local" } },
    });
    await f.sync();
    expect(f.commit).not.toHaveBeenCalled();
    f.controller.sync(f.owner);
    expect(f.request).toHaveBeenCalledTimes(1);
    f.controller.invalidate();
    await f.sync();
    expect(f.slots()).toEqual(["desktop"]);
  });
});
