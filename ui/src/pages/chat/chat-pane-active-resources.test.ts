import type { EnvironmentsListResult } from "@openclaw/gateway-protocol";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionRowObservation } from "../../lib/sessions/session-capability.ts";
import { createActiveSessionPlacement } from "../../test-helpers/session-placement.ts";
import { ChatPaneActiveResources, type ActiveResourceOwner } from "./chat-pane-active-resources.ts";
import { normalizeSidebarLayout } from "./sidebar-layout-normalize.ts";
import {
  closeSlot,
  ensureSidebarConversation,
  isSidebarSlotVisible,
  openSlot,
  promoteSidebarPanel,
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
const activePlacement = createActiveSessionPlacement({
  environmentId: "worker-1",
  workspaceBaseManifestRef: "base",
}) satisfies NonNullable<GatewaySessionRow["placement"]>;
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
  const describedSession = () => ({
    ...session,
    sessionId: owner.sessionId,
    placement: owner.placement,
    execNode: owner.execNode,
    archived: owner.archived,
  });
  const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async (method) => {
    if (method === "sessions.describe") {
      return { session: describedSession() };
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
    describedSession,
    holdDescriptor: () => {
      const pending = createDeferred<unknown>();
      request.mockImplementationOnce(() => pending.promise);
      return pending;
    },
    sync: async (next = owner) => {
      controller.sync(next);
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
  let f: ReturnType<typeof fixture>;
  beforeEach(() => {
    f = fixture();
  });

  it("publishes verified desktop changes until its subscriber leaves", async () => {
    const sources: Array<string | null | undefined> = [];
    const dispose = f.controller.subscribe(() => sources.push(f.desktopSource()));
    onTestFinished(dispose);
    expect(f.desktopSource()).toBeUndefined();
    await f.sync();
    expect(sources).toEqual(["worker-1"]);

    f.owner.observation.isCurrent = () => false;
    expect(f.desktopSource()).toBeNull();
    await f.sync({
      ...f.owner,
      observation: { ...f.owner.observation, isCurrent: () => true },
    });
    expect(sources).toEqual(["worker-1", "worker-1"]);

    const respond = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params) =>
      method === "environments.status"
        ? Promise.resolve({ ...environment, status: "unavailable" })
        : respond(method, params),
    );
    // Revalidation discovers retirement without a renderer scheduling another sync.
    f.controller.reconcileObservation();
    await settle();
    expect(sources).toEqual(["worker-1", "worker-1", null]);

    dispose();
    f.request.mockImplementation(respond);
    f.controller.invalidate();
    await f.sync({
      ...f.owner,
      observation: { ...f.owner.observation, isCurrent: () => true },
    });
    expect(f.desktopSource()).toBe("worker-1");
    expect(sources).toEqual(["worker-1", "worker-1", null]);
  });

  it("discovers resources after the binding identity changes", async () => {
    const pending = f.holdDescriptor();
    await f.sync();
    f.owner.observation.isCurrent = () => false;
    await f.sync({
      ...f.owner,
      observation: { ...f.owner.observation, isCurrent: () => true },
    });
    expect(f.slots()).toEqual(["desktop"]);
    pending.resolve({ session });
    await settle();
    expect(f.slots()).toEqual(["desktop"]);
  });

  it.each(["after-resource-swap", "focused-workspace"])(
    "discovers resources while preserving the %s layout",
    async (kind) => {
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
      f.owner.placement = activePlacement;
      f.owner.sessionId = "session-id";
      const source = f.desktopSource;
      await f.sync();
      expect(source()).toBe("worker-1");
      f.owner.placement = { ...activePlacement, updatedAtMs: 99, lastTranscriptAckCursor: 10 };
      expect(source()).toBe("worker-1");
      const pending = f.holdDescriptor();
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
    f.owner.placement = activePlacement;
    const pending = f.holdDescriptor();
    await f.sync();
    f.owner.placement = {
      ...activePlacement,
      updatedAtMs: 11,
      lastTranscriptAckCursor: 1,
      lastLiveEventAckCursor: 2,
      diskSpace: { status: "ok", availableBytes: 99, totalBytes: 100, observedAtMs: 11 },
    };
    await f.sync();
    expect(f.request).toHaveBeenCalledTimes(1);
    pending.resolve({ session: f.describedSession() });
    await settle();
    expect(f.slots().toSorted()).toEqual(["desktop"]);
    expect(f.request).toHaveBeenCalledTimes(2);
    f.owner.placement = { ...activePlacement, updatedAtMs: 100, lastTranscriptAckCursor: 99 };
    await f.sync();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.commit).toHaveBeenCalledTimes(1);
  });

  it("does not reveal an unconfirmed desktop when its device changes during discovery", async () => {
    f.owner.placement = {
      ...activePlacement,
      runner: { kind: "device", deviceId: "node-1", status: "available" },
    };
    const pending = f.holdDescriptor();
    const described = f.describedSession();
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

  it("respects an older minimized dock even when the newly discovered resource has no tab", async () => {
    f.setLayout({ ...openSlot(f.owner.layout(), "terminal"), open: false });
    await f.sync();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.slots()).toEqual(["terminal"]);
  });

  it("leaves a manual desktop opened during discovery with its presentation owner", async () => {
    const pending = f.holdDescriptor();
    f.controller.sync(f.owner);
    f.setLayout(openSlot(f.owner.layout(), "desktop"));
    pending.resolve({ session });
    await settle();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.desktopSource()).toBeUndefined();
  });

  it("respects dismissal during a pending target-status read", async () => {
    const pending = createDeferred<unknown>();
    f.request.mockImplementation(async () => pending.promise);
    f.controller.sync(f.owner);
    f.setLayout(normalizeSidebarLayout({ columns: [], resourceAutoOpenDismissed: true }));
    pending.resolve({ session, running: true, tabs: [{ targetId: "target-1" }] });
    await settle();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("rejects stale async responses after leaving", async () => {
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
  ])("ignores $name", async ({ row, env }) => {
    f.request.mockImplementation(async (method) =>
      method === "sessions.describe" ? { session: row } : (env ?? environment),
    );
    await f.sync();
    expect(f.commit).not.toHaveBeenCalled();
  });
});
