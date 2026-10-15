/* @vitest-environment jsdom */

import type { JSX } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { SessionsListResult } from "../api/types.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { createTestSessionCapability } from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createContext,
  createGateway,
  createGatewayHarness,
  createSessions,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { renderAppSidebarOnline } from "./app-sidebar-online.tsx";
import { renderSidebarAgentCard } from "./app-sidebar-render.tsx";
import { projectSidebarSession } from "./app-sidebar-session-navigation.test-support.ts";
import { renderRecentSession } from "./app-sidebar-session-row-render.tsx";
import { AppSidebarOwner, type AppSidebarElement } from "./app-sidebar.tsx";
import { resolveSidebarSessionRowSubtitle } from "./session-row-subtitle.ts";
import {
  parseSidebarSnapshot,
  restoreSnapshotSession,
  snapshotSessions,
  type SidebarSnapshotModel,
} from "./sidebar-snapshot-model.ts";
import { installTitleTooltips } from "./tooltip-title.ts";

const emptySnapshot: SidebarSnapshotModel = {
  routingDefaults: { mainKey: "main", scope: "per-sender" },
  roster: null,
  mode: "chip",
  navigationView: "sessions",
  pages: [],
  pageScopeId: null,
  pinnedSessions: [],
  entries: [],
  sessions: [],
  sections: [],
  cards: [],
  collapsedAgentIds: [],
  collapsedSections: [],
  plugins: [],
  onlineUsers: [],
  onlineCounts: [],
  peopleSortMode: "presence",
  peopleStatusFilter: "all",
  peoplePresenceFilter: "online",
  offlineUsers: [],
  ownerId: null,
  involvingMe: false,
  footer: null,
  brand: { name: "Harbor", avatar: null, icon: "claw", environment: null },
};

function createHost(mode: "chip" | "roster" = "roster") {
  const context = createContext(
    createGateway(createTestGatewayClient(async () => ({}))),
    createSessions("main", []),
  );
  const container = document.createElement("div");
  const props = document.createElement("openclaw-app-sidebar") as AppSidebarElement;
  props.sidebarAgentsMode = mode;
  const host = new AppSidebarOwner(props, context, props);
  host.sessionOwnershipVisibility = { filters: true, avatars: true };
  document.body.append(container);
  return { host, container, context };
}

function mountObservedHost(
  host: AppSidebarOwner,
  container: HTMLElement,
  view: (host: AppSidebarOwner) => JSX.Element,
) {
  const [revision, setRevision] = createSignal(0);
  const observedHost = new Proxy(host, {
    get(target, key, receiver) {
      revision();
      return Reflect.get(target, key, receiver);
    },
  });
  mountSolid(() => view(observedHost), { container });
  return () => {
    setRevision((value) => value + 1);
    flush();
  };
}

it("hides archived pages in the restored sidebar before live data arrives", async () => {
  const gateway = createGatewayHarness(createTestGatewayClient(async () => ({})));
  gateway.publish({ client: null, phase: "connecting", hello: null });
  const context = createContext(gateway.gateway, createSessions("main", []));
  const { sidebar: host } = await mountSidebarContext(context);
  host.restoreSidebarSnapshot({
    ...emptySnapshot,
    mode: "roster",
    navigationView: "pages",
    pageScopeId: context.agentSelection.state.scopeId,
    pages: snapshotSessions([
      projectSidebarSession({
        key: "agent:main:active",
        label: "Active dashboard",
        hasBoard: true,
      }),
      projectSidebarSession({
        key: "agent:main:archived",
        label: "Archived dashboard",
        hasBoard: true,
        archived: true,
      }),
    ]),
  });
  host.requestUpdate();
  await host.updateComplete;

  expect(
    host.querySelector('.sidebar-pages [data-session-key="agent:main:active"]'),
  ).not.toBeNull();
  expect(host.querySelector('.sidebar-pages [data-session-key="agent:main:archived"]')).toBeNull();
  expect(host.querySelector(".sidebar-pages .sidebar-session-sort")).toBeNull();
});

it("paints the restored roster and workspace in the first sidebar update", async () => {
  const gateway = createGatewayHarness(createTestGatewayClient(async () => ({})));
  gateway.publish({ client: null, phase: "connecting", hello: null });
  const context = createContext(gateway.gateway, createSessions("main", []));
  const { sidebar: host } = await mountSidebarContext(context);
  host.sidebarAgentsMode = "chip";
  host.sidebarLiveActivity = false;

  host.restoreSidebarSnapshot({
    ...emptySnapshot,
    mode: "roster",
    cards: [{ id: "main", name: "Harbor", mainKey: "agent:main:main", textAvatar: "⚓" }],
  });
  host.requestUpdate();
  await host.updateComplete;

  expect(host.querySelector('aside[data-snapshot-state="cached"]')).not.toBeNull();
  expect(host.querySelector("openclaw-sidebar-agent-roster")).not.toBeNull();
  await waitForSolid(() =>
    expect(host.querySelector('[data-agent-group="main"]')?.textContent).toContain("Harbor"),
  );
  expect(host.querySelector('[data-avatar="⚓"]')).not.toBeNull();
});

it("keeps cached session rows while the live roster settles", async () => {
  const key = "agent:main:dashboard:cedar";
  const list = createDeferred<SessionsListResult>();
  const requested = createDeferred();
  const gateway = createGatewayHarness(
    createTestGatewayClient(async (method, params) => {
      if (method === "sessions.list") {
        if ((params as { archived?: string }).archived === "all") {
          requested.resolve();
          return list.promise;
        }
        return { ts: 1, path: "", count: 0, defaults: {}, sessions: [] };
      }
      if (method === "sessions.groups.list") {
        return { names: [], sectionOrder: [] };
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    }),
  );
  const sessions = createTestSessionCapability(gateway.gateway);
  const context = createContext(gateway.gateway, sessions, {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "main", name: "Harbor", identity: { emoji: "⚓" } }],
  });
  const store = rosterActivityStore(context);
  const { sidebar: host } = await mountSidebarContext(context);
  host.sidebarAgentsMode = "roster";
  host.connected = true;
  host.sidebarLiveActivity = false;
  await requested.promise;
  await host.updateComplete;
  const saved = snapshotSessions([projectSidebarSession({ key, label: "Cedar" })]);
  host.restoreSidebarSnapshot({
    ...emptySnapshot,
    mode: "roster",
    sessions: saved,
    sections: [
      {
        id: "agent:main:recent",
        rows: saved,
        totalRowCount: 1,
        visibleRowCount: 1,
        visibleLimit: 10,
        collapsedVisibleRowCount: 1,
        renderHeader: false,
      },
    ],
    cards: [{ id: "main", name: "Harbor", mainKey: "agent:main:main", textAvatar: "⚓" }],
  });
  host.requestUpdate();
  await host.updateComplete;
  const rowIds = () =>
    [...host.querySelectorAll(".sidebar-session-content [data-session-key]")].map((row) =>
      row.getAttribute("data-session-key"),
    );
  await waitForSolid(() => expect(rowIds()).toEqual([key]));
  const samples: Array<Array<string | null>> = [];
  const sample = () => samples.push(rowIds());
  const observer = new MutationObserver(sample);
  observer.observe(host.hostElement, { childList: true, subtree: true });
  onTestFinished(() => observer.disconnect());
  sample();
  list.resolve({
    ts: 1,
    path: "",
    count: 1,
    defaults: { model: null, modelProvider: null, contextTokens: null },
    sessions: [{ key, kind: "direct", label: "Cedar", updatedAt: 1 }],
  });
  await store.refresh();
  await waitForSolid(() =>
    expect(host.querySelector('aside[data-snapshot-state="live"]')).not.toBeNull(),
  );
  observer.disconnect();
  sample();
  expect(host.querySelector('aside[data-snapshot-state="live"]')).not.toBeNull();
  for (const rows of samples) {
    expect(rows).toEqual([key]);
  }
});

it("keeps the unread badge on an idle child with an icon", () => {
  const { host, container } = createHost("chip");
  const session = {
    ...projectSidebarSession({ key: "agent:main:child", icon: "🦞", unread: true, status: "done" }),
    isChild: true,
  };
  mountSolid(() => renderRecentSession({ host, session }), { container });
  expect(container.querySelector(".session-glyph__emoji")?.textContent).toBe("🦞");
  expect(container.querySelector('.session-glyph__badge[aria-label="Unread"]')).not.toBeNull();
});

it("materializes the archive hint on hover without changing the action name", () => {
  vi.useFakeTimers();
  onTestFinished(installTitleTooltips(document));
  const { host, container } = createHost();
  const session = projectSidebarSession({ key: "agent:main:thread", label: "Research" });
  mountSolid(() => renderRecentSession({ host, session }), { container });
  const archive = container.querySelector<HTMLButtonElement>("[data-sidebar-session-archive]")!;
  const name = archive.getAttribute("aria-label");
  const hint = archive.title;
  expect(hint).not.toBe("");
  expect(container.querySelector("openclaw-tooltip")).toBeNull();

  archive.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  const tooltip = document.querySelector("openclaw-tooltip");
  expect(tooltip?.content).toBe(hint);
  expect(archive.getAttribute("aria-label")).toBe(name);
});

it("renders the saved chip identity before agent discovery without reviving another agent's chip", async () => {
  const { host, container, context } = createHost();
  host.sidebarAgentsMode = "chip";
  host.sessionKey = "agent:main:thread";
  expect(host.activeChipAgent().agent).toBeUndefined();
  host.restoreSidebarSnapshot({
    ...emptySnapshot,
    brand: { ...emptySnapshot.brand, agentId: "main", name: "Harbor", textAvatar: "⚓" },
  });
  const update = mountObservedHost(host, container, renderSidebarAgentCard);
  const card = container.querySelector("openclaw-sidebar-agent-card");
  expect(card).not.toBeNull();
  await waitForSolid(() => {
    expect(container.querySelector(".sidebar-workspace-header")).toBeNull();
    expect(card!.querySelector(".sidebar-agent-card__main")?.getAttribute("aria-label")).toContain(
      "Harbor",
    );
    expect(card!.querySelector("[data-avatar='⚓']")).not.toBeNull();
  });
  host.sessionKey = "agent:other:thread";
  context.agentSelection.set("other");
  update();
  expect(container.querySelector("openclaw-sidebar-agent-card")).toBeNull();
  expect(container.querySelector(".sidebar-workspace-header")).not.toBeNull();
});

it("keeps the rendered preview slot after caching without restoring live run authority", () => {
  const { host, container } = createHost();
  host.sidebarAgentsMode = "chip";
  host.sessionsShowPreview = true;
  const session = projectSidebarSession({
    key: "agent:main:thread",
    lastMessagePreview: "The report is ready for review.",
  });
  const [current, setCurrent] = createSignal(session);
  const update = mountObservedHost(host, container, (observedHost) =>
    renderRecentSession({
      host: observedHost,
      get session() {
        return current();
      },
    }),
  );
  expect(container.querySelector(".sidebar-recent-session__subtitle")?.textContent).toBe(
    "The report is ready for review.",
  );
  const [cached] = snapshotSessions([session], (row) => ({
    snapshotSubtitle: resolveSidebarSessionRowSubtitle(host, row),
  }));
  host.sidebarSnapshot = parseSidebarSnapshot({ ...emptySnapshot, sessions: [cached] });
  expect(host.sidebarSnapshot).not.toBeNull();
  const restored = restoreSnapshotSession(host.sidebarSnapshot!.sessions[0]!, session.key);
  setCurrent(restored);
  update();
  expect(container.querySelector(".sidebar-recent-session__subtitle")?.textContent).toBe(
    "The report is ready for review.",
  );
  expect(container.querySelector(".sidebar-recent-session--single-line")).toBeNull();
  expect(restored.hasActiveRun).toBe(false);
  expect(restored.attention).toEqual({ kind: "none" });
  expect(
    container.querySelectorAll(
      "[data-sidebar-session-pin]:enabled, [data-sidebar-session-archive]:enabled",
    ),
  ).toHaveLength(0);
});

it("keeps Users visible despite a cached legacy collapse preference", () => {
  const { host, container } = createHost();
  host.sidebarAgentsMode = "chip";
  host.restoreSidebarSnapshot({
    ...emptySnapshot,
    collapsedSections: ["online"],
    onlineUsers: [{ id: "ada", name: "Ada", watchedSessions: [] }],
  });
  host.sessionData.presencePayload = { presence: [{ ts: 1, user: { id: "ada", name: "Ada" } }] };
  const update = mountObservedHost(host, container, renderAppSidebarOnline);
  expect(container.querySelector(".sidebar-online__person-name")?.textContent).toBe("Ada");
  host.releaseSidebarSnapshot();
  update();
  expect(container.querySelector(".sidebar-online__person-name")?.textContent).toBe("Ada");
});

it("shows unavailable counts after a failed live summary instead of retaining saved totals", () => {
  const { host, container } = createHost();
  host.restoreSidebarSnapshot({
    ...emptySnapshot,
    mode: "roster",
    peoplePresenceFilter: "online",
    offlineUsers: [],
    onlineUsers: [
      { id: "ada", name: "Ada", identity: { type: "profile", id: "ada" }, watchedSessions: [] },
    ],
    onlineCounts: [["ada", { open: 2, running: 1 }]],
  });
  const update = mountObservedHost(host, container, renderAppSidebarOnline);
  expect(container.querySelector(".sidebar-online__counts")).not.toBeNull();
  host.releaseSidebarSnapshot();
  host.sessionData.ownerCounts.error = "Synthetic count failure";
  update();
  expect(container.querySelector(".sidebar-online__counts")).toBeNull();
  expect(container.querySelector(".sidebar-online__retry")).not.toBeNull();
});

it.each([false, true])(
  "keeps row facepiles idle with unchanged inputs (owner: %s), while admitting new presence",
  async (withOwner) => {
    const { host, container } = createHost();
    const session = projectSidebarSession({
      key: "agent:main:thread",
      owner: withOwner
        ? { actor: { type: "human", id: "ada", identity: { type: "profile", id: "ada" } } }
        : undefined,
    });
    const presence = ["ada", "bea"].map((id) => ({
      ts: 1,
      user: { id, identity: { type: "profile" as const, id }, name: id },
      watchedSessions: [session.key],
    }));
    host.sessionData.presencePayload = { presence };
    const [revision, setRevision] = createSignal(0);
    const observedHost = new Proxy(host, {
      get(target, key, receiver) {
        revision();
        return Reflect.get(target, key, receiver);
      },
    });
    mountSolid(
      () =>
        renderRecentSession({
          host: observedHost,
          get session() {
            revision();
            return session;
          },
        }),
      { container },
    );
    const update = () => {
      setRevision((value) => value + 1);
      flush();
    };
    update();
    const row = container.querySelector(".sidebar-recent-session")!;
    const facepile = container.querySelector("openclaw-viewer-facepile")!;
    await facepile.updateComplete;
    const updates: MutationRecord[] = [];
    const observer = new MutationObserver((records) => updates.push(...records));
    observer.observe(facepile, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    onTestFinished(() => observer.disconnect());

    update();
    await facepile.updateComplete;
    expect(updates).toHaveLength(0);

    host.sessionData.presencePayload = { presence: presence.slice(0, 1) };
    update();
    await facepile.updateComplete;
    expect(updates.length).toBeGreaterThan(0);
    updates.length = 0;
    expect(facepile.querySelector(".viewer-facepile")?.getAttribute("aria-label")).toBe(
      withOwner ? undefined : "ada",
    );

    session.owner = {
      actor: { type: "human", id: "bea", identity: { type: "profile", id: "bea" } },
    };
    update();
    await facepile.updateComplete;
    expect(updates.length > 0).toBe(withOwner);
    expect(container.querySelector(".sidebar-recent-session")).toBe(row);
    expect(container.querySelector("openclaw-viewer-facepile")).toBe(facepile);
    expect(facepile.querySelector(".viewer-facepile")?.getAttribute("aria-label")).toBe("ada");
  },
);

it("updates a pinned session's resolved avatar without replacing its row", () => {
  const { host, container } = createHost();
  const session = projectSidebarSession({ key: "agent:main:pinned" });
  const [avatar, setAvatar] = createSignal("Loading avatar");
  mountSolid(
    () =>
      renderRecentSession({
        host,
        session,
        get icon() {
          const label = avatar();
          return <span data-pinned-avatar>{label}</span>;
        },
      }),
    { container },
  );
  const row = container.querySelector(".sidebar-recent-session");
  expect(container.querySelector("[data-pinned-avatar]")?.textContent).toBe("Loading avatar");

  setAvatar("Ada");
  flush();

  expect(container.querySelector("[data-pinned-avatar]")?.textContent).toBe("Ada");
  expect(container.querySelector(".sidebar-recent-session")).toBe(row);
});
