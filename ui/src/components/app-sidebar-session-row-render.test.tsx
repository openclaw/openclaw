/* @vitest-environment jsdom */

import type { JSX } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { createTestSessionCapability } from "../lib/sessions/session-capability.test-support.ts";
import {
  createContext,
  createGateway,
  createGatewayHarness,
  createSessions,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { domProbe } from "../test-helpers/dom-probe.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { renderAppSidebarOnline } from "./app-sidebar-online.tsx";
import { renderSidebarAgentCard } from "./app-sidebar-render.tsx";
import { projectSidebarSession } from "./app-sidebar-session-navigation.test-support.ts";
import { renderRecentSession as RecentSession } from "./app-sidebar-session-row-render.tsx";
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

function createHost(mode: "chip" | "roster" = "roster", snapshot?: Partial<SidebarSnapshotModel>) {
  const context = createContext(
    createGateway(createTestGatewayClient(async () => ({}))),
    createSessions("main", []),
  );
  const container = document.createElement("div");
  const props = document.createElement("openclaw-app-sidebar") as AppSidebarElement;
  props.sidebarAgentsMode = mode;
  const host = new AppSidebarOwner({ dashboards: null, loadMoreDashboards() {} }, context, props);
  // The full sidebar mounts this owner; row-only fixtures keep the supplied catalog summary.
  host.sessionPullRequests = {
    summary: (_sessionKey, _worktreeId, initial) => initial,
    count: () => undefined,
  };
  host.sessionOwnershipVisibility = { filters: true, avatars: true };
  document.body.append(container);
  if (snapshot) {
    host.restoreSidebarSnapshot({ ...emptySnapshot, ...snapshot });
  }
  return { host, container, context, dom: domProbe(container) };
}

function mountRow(
  fields: Partial<GatewaySessionRow>,
  presentation: Partial<ReturnType<typeof projectSidebarSession>> = {},
  options: Pick<Parameters<typeof RecentSession>[0], "icon"> = {},
) {
  const fixture = createHost("chip");
  const session = {
    ...projectSidebarSession({ key: "agent:main:thread", ...fields }),
    ...presentation,
  };
  const [current, setCurrent] = createSignal(session);
  mountSolid(() => <RecentSession host={fixture.host} session={current()} {...options} />, {
    container: fixture.container,
  });
  return { ...fixture, session, current, setCurrent };
}

async function createCachedHost() {
  const gateway = createGatewayHarness(createTestGatewayClient(async () => ({})));
  gateway.publish({ client: null, phase: "connecting", hello: null });
  const context = createContext(gateway.gateway, createSessions("main", []));
  const { sidebar: host } = await mountSidebarContext(context);
  return { host, context, dom: domProbe(host) };
}

function observeHost(host: AppSidebarOwner) {
  const [revision, setRevision] = createSignal(0);
  const observedHost = new Proxy(host, {
    get(target, key, receiver) {
      revision();
      return Reflect.get(target, key, receiver);
    },
  });
  return {
    host: observedHost,
    track: () => {
      revision();
    },
    update: () => {
      setRevision((value) => value + 1);
      flush();
    },
  };
}

function mountObservedHost(
  host: AppSidebarOwner,
  container: HTMLElement,
  view: (host: AppSidebarOwner) => JSX.Element,
) {
  const observed = observeHost(host);
  mountSolid(() => view(observed.host), { container });
  return observed.update;
}

it("hides archived pages in the restored sidebar before live data arrives", async () => {
  const { host, context, dom } = await createCachedHost();
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
  host.invalidate();
  await host.updateComplete;
  expect(
    dom.present(
      '.sidebar-pages [data-session-key="agent:main:active"]',
      '.sidebar-pages [data-session-key="agent:main:archived"]',
      ".sidebar-pages .sidebar-session-sort",
    ),
  ).toEqual([true, false, false]);
});

it("sorts built-in Pages alphabetically without reordering dashboards", async () => {
  const { host, context, dom } = await createCachedHost();
  const dashboardKeys = ["agent:main:dashboard:zulu", "agent:main:dashboard:alpha"];
  host.restoreSidebarSnapshot({
    ...emptySnapshot,
    mode: "roster",
    navigationView: "pages",
    pageScopeId: context.agentSelection.state.scopeId,
    pages: snapshotSessions(
      dashboardKeys.map((key) => projectSidebarSession({ key, label: key, hasBoard: true })),
    ),
  });
  host.invalidate();
  await host.updateComplete;
  const entries = [...dom.all(".sidebar-pages [data-sidebar-entry]")];
  const routes = entries
    .map((entry) => entry.getAttribute("data-sidebar-entry"))
    .filter((entry): entry is string => Boolean(entry?.startsWith("route:")));
  const routeLabels = routes.map(
    (route) => dom.query(`[data-sidebar-entry="${route}"] a`)?.textContent?.trim() ?? "",
  );
  expect(routeLabels.length).toBeGreaterThan(4);
  expect(routeLabels).not.toContain("");
  expect(routeLabels).toEqual(routeLabels.toSorted((left, right) => left.localeCompare(right)));
  expect(entries.map((entry) => entry.getAttribute("data-sidebar-entry")).slice(-2)).toEqual(
    dashboardKeys.map((key) => `session:${key}`),
  );
});

it("paints the restored roster and workspace in the first sidebar update", async () => {
  const { host, dom } = await createCachedHost();
  host.sidebarAgentsMode = "chip";
  host.sidebarLiveActivity = false;

  host.restoreSidebarSnapshot({
    ...emptySnapshot,
    mode: "roster",
    cards: [{ id: "main", name: "Harbor", mainKey: "agent:main:main", textAvatar: "⚓" }],
  });
  host.invalidate();
  await host.updateComplete;
  expect(
    dom.present('aside[data-snapshot-state="cached"]', "openclaw-sidebar-agent-roster"),
  ).toEqual([true, true]);
  await waitForSolid(() => expect(dom.text('[data-agent-group="main"]')).toContain("Harbor"));
  expect(dom.query('[data-avatar="⚓"]')).not.toBeNull();
});

it("keeps cached agent rows while the live roster settles", async () => {
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
        return { groups: [], sectionOrder: [] };
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
  host.invalidate();
  await host.updateComplete;
  const agentIds = () =>
    [...host.querySelectorAll(".sidebar-agent-roster__row[data-agent-id]")].map((row) =>
      row.getAttribute("data-agent-id"),
    );
  await waitForSolid(() => expect(agentIds()).toEqual(["main"]));
  expect(host.querySelector(`[data-session-key="${key}"]`)).toBeNull();
  const samples: Array<Array<string | null>> = [];
  const sample = () => samples.push(agentIds());
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
  for (const agents of samples) {
    expect(agents).toEqual(["main"]);
  }
  expect(host.querySelector(`[data-session-key="${key}"]`)).toBeNull();
});

it("keeps the unread badge on an idle child with an icon", () => {
  const { dom } = mountRow(
    { key: "agent:main:child", icon: "🦞", unread: true, status: "done" },
    { isChild: true },
  );
  expect(dom.text(".session-glyph__emoji")).toBe("🦞");
  expect(dom.query('.session-glyph__badge[aria-label="Unread"]')).not.toBeNull();
});

it("keeps an idle child owner's glyph hidden until the run starts", () => {
  const { dom, session, setCurrent } = mountRow(
    {
      key: "agent:main:child",
      status: "done",
      owner: { actor: { type: "human", id: "ada", label: "Ada" } },
    },
    { isChild: true },
  );
  expect(
    dom.present(".session-glyph", "openclaw-session-owner-chip", ".sidebar-child-session__status"),
  ).toEqual([false, false, true]);

  setCurrent({ ...session, hasActiveRun: true, isRunVisuallyActive: true });
  flush();
  expect(dom.query(".session-glyph--running.session-glyph--bare")).not.toBeNull();
  expect(dom.query("openclaw-session-owner-chip")).toBeNull();
});

it.each([false, null, undefined])(
  "preserves the run glyph's bare styling for icon override %s",
  (icon) => {
    const { dom } = mountRow(
      { key: "agent:main:running", hasActiveRun: true, status: "running", icon: "book" },
      {},
      { icon },
    );
    const glyph = dom.query(".session-glyph--running");
    expect(glyph).not.toBeNull();
    expect(glyph?.classList.contains("session-glyph--bare")).toBe(icon === false);
    expect(glyph?.querySelector(".session-glyph__icon") !== null).toBe(icon !== false);
  },
);

it.each(["owner", "icon"] as const)(
  "retains %s artwork and actions when live rows republish unchanged presentation",
  (kind) => {
    const { dom, session, current, setCurrent } = mountRow({
      label: "Research",
      color: "blue",
      unread: true,
      icon: kind === "icon" ? "book" : undefined,
      owner: { actor: { type: "human", id: "ada", label: "Ada" } },
    });
    const chip = dom.query("openclaw-session-owner-chip");
    flush();
    const content = dom.query(".session-glyph__content")!;
    const artwork = content.firstElementChild;
    const graphic = content.querySelector("svg");
    const initialGraphic = graphic?.innerHTML;
    const archive = dom.query("[data-sidebar-session-archive]")!;
    const archiveIcon = archive.querySelector("svg");
    const row = dom.query(".sidebar-recent-session")!;
    const observer = new MutationObserver(() => {});
    observer.observe(content, { childList: true });
    observer.observe(dom.query(".session-row-actions")!, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    observer.observe(row, { attributes: true, attributeFilter: ["style"] });
    onTestFinished(() => observer.disconnect());

    setCurrent({ ...session, updatedAt: 2, owner: { ...session.owner! } });
    flush();
    expect(observer.takeRecords()).toHaveLength(0);
    expect(dom.query(".session-glyph__content")).toBe(content);
    expect(content.firstElementChild).toBe(artwork);
    expect(archive.querySelector("svg")).toBe(archiveIcon);

    setCurrent({
      ...current(),
      archived: true,
      icon: kind === "icon" ? "bot" : undefined,
      owner: { actor: { type: "human", id: "ada", label: "Ada renamed" } },
    });
    flush();
    expect(archive.getAttribute("aria-label")).toBe("Restore session: Research");
    expect(archive.querySelector("svg")).toBe(archiveIcon);
    expect(content.firstElementChild).toBe(artwork);
    if (kind === "owner") {
      expect(chip?.querySelector(".session-owner-chip")?.getAttribute("aria-label")).toContain(
        "Ada renamed",
      );
    } else {
      expect(content.querySelector("svg")).toBe(graphic);
      expect(content.querySelector("svg")?.innerHTML).not.toBe(initialGraphic);
    }
  },
);

it("materializes the archive hint on hover without changing the action name", () => {
  vi.useFakeTimers();
  onTestFinished(installTitleTooltips(document));
  const { host, container, dom } = createHost();
  const session = projectSidebarSession({ key: "agent:main:thread", label: "Research" });
  mountSolid(() => <RecentSession host={host} session={session} />, { container });
  const archive = dom.query<HTMLButtonElement>("[data-sidebar-session-archive]")!;
  const name = archive.getAttribute("aria-label");
  const hint = archive.title;
  expect(hint).not.toBe("");
  expect(dom.query("openclaw-tooltip")).toBeNull();

  archive.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  const tooltip = document.querySelector("openclaw-tooltip");
  expect(tooltip?.content).toBe(hint);
  expect(archive.getAttribute("aria-label")).toBe(name);
});

it("renders the saved chip identity before agent discovery without reviving another agent's chip", async () => {
  const { host, container, context, dom } = createHost("chip");
  host.sessionKey = "agent:main:thread";
  expect(host.activeChipAgent().agent).toBeUndefined();
  host.restoreSidebarSnapshot({
    ...emptySnapshot,
    brand: { ...emptySnapshot.brand, agentId: "main", name: "Harbor", textAvatar: "⚓" },
  });
  const update = mountObservedHost(host, container, renderSidebarAgentCard);
  const card = dom.query("openclaw-sidebar-agent-card");
  expect(card).not.toBeNull();
  await waitForSolid(() => {
    expect(dom.query(".sidebar-workspace-header")).toBeNull();
    expect(card!.querySelector(".sidebar-agent-card__main")?.getAttribute("aria-label")).toContain(
      "Harbor",
    );
    expect(card!.querySelector("[data-avatar='⚓']")).not.toBeNull();
  });
  // The visible name already labels the trigger; no hover tooltip repeats it.
  expect(dom.query("openclaw-tooltip")).toBeNull();
  host.sessionKey = "agent:other:thread";
  context.agentSelection.set("other");
  update();
  expect(dom.query("openclaw-sidebar-agent-card")).toBeNull();
  expect(dom.query(".sidebar-workspace-header")).not.toBeNull();
  expect(dom.query("openclaw-tooltip")).toBeNull();
});

it("retains the workspace name DOM across unrelated sidebar publications and renames", () => {
  const { host, container, dom } = createHost("roster", {});
  const update = mountObservedHost(host, container, renderSidebarAgentCard);
  const name = () => dom.query(".sidebar-agent-card__name-text");
  const original = name();
  expect(original?.textContent).toBe("Harbor");

  update();
  expect(name()).toBe(original);

  host.restoreSidebarSnapshot({
    ...emptySnapshot,
    brand: { ...emptySnapshot.brand, name: "Harbor renamed" },
  });
  update();
  expect(name()).toBe(original);
  expect(name()?.textContent).toBe("Harbor renamed");
});

it("keeps the rendered preview slot after caching without restoring live run authority", () => {
  const { host, container, dom } = createHost("chip");
  host.sessionsShowPreview = true;
  const session = projectSidebarSession({
    key: "agent:main:thread",
    lastMessagePreview: "The report is ready for review.",
  });
  const [current, setCurrent] = createSignal(session);
  const update = mountObservedHost(host, container, (observedHost) => (
    <RecentSession host={observedHost} session={current()} />
  ));
  expect(dom.text(".sidebar-recent-session__subtitle")).toBe("The report is ready for review.");
  const [cached] = snapshotSessions([session], (row) => ({
    snapshotSubtitle: resolveSidebarSessionRowSubtitle(host, row),
  }));
  host.sidebarSnapshot = parseSidebarSnapshot({ ...emptySnapshot, sessions: [cached] });
  expect(host.sidebarSnapshot).not.toBeNull();
  const restored = restoreSnapshotSession(host.sidebarSnapshot!.sessions[0]!, session.key);
  setCurrent(restored);
  update();
  expect(dom.text(".sidebar-recent-session__subtitle")).toBe("The report is ready for review.");
  expect(dom.query(".sidebar-recent-session--single-line")).toBeNull();
  expect([restored.hasActiveRun, restored.attention]).toEqual([false, { kind: "none" }]);
  expect(
    dom.all("[data-sidebar-session-pin]:enabled, [data-sidebar-session-archive]:enabled"),
  ).toHaveLength(0);
});

it("keeps Users visible despite a cached legacy collapse preference", () => {
  const { host, container, dom } = createHost("chip", {
    collapsedSections: ["online"],
    onlineUsers: [{ id: "ada", name: "Ada", watchedSessions: [] }],
  });
  host.sessionData.presencePayload = { presence: [{ ts: 1, user: { id: "ada", name: "Ada" } }] };
  const update = mountObservedHost(host, container, renderAppSidebarOnline);
  expect(dom.text(".sidebar-online__person-name")).toBe("Ada");
  host.releaseSidebarSnapshot();
  update();
  expect(dom.text(".sidebar-online__person-name")).toBe("Ada");
});

it("shows unavailable counts after a failed live summary instead of retaining saved totals", () => {
  const { host, container, dom } = createHost("roster", {
    mode: "roster",
    onlineUsers: [
      { id: "ada", name: "Ada", identity: { type: "profile", id: "ada" }, watchedSessions: [] },
    ],
    onlineCounts: [["ada", { open: 2, running: 1 }]],
  });
  const update = mountObservedHost(host, container, renderAppSidebarOnline);
  expect(dom.query(".sidebar-online__counts")).not.toBeNull();
  host.releaseSidebarSnapshot();
  host.sessionData.ownerCounts.error = "Synthetic count failure";
  update();
  expect(dom.present(".sidebar-online__counts", ".sidebar-online__retry")).toEqual([false, true]);
});

it.each([false, true])(
  "keeps row facepiles idle with unchanged inputs (owner: %s), while admitting new presence",
  async (withOwner) => {
    const { host, container, dom } = createHost();
    let session = projectSidebarSession({
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
    const observed = observeHost(host);
    const current = () => {
      observed.track();
      return session;
    };
    mountSolid(() => <RecentSession host={observed.host} session={current()} />, { container });
    const update = observed.update;
    update();
    const row = dom.query(".sidebar-recent-session")!;
    const facepile = dom.query("openclaw-viewer-facepile")!;
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

    session = {
      ...session,
      owner: { actor: { type: "human", id: "bea", identity: { type: "profile", id: "bea" } } },
    };
    update();
    await facepile.updateComplete;
    expect(updates.length > 0).toBe(withOwner);
    expect(dom.query(".sidebar-recent-session")).toBe(row);
    expect(dom.query("openclaw-viewer-facepile")).toBe(facepile);
    expect(facepile.querySelector(".viewer-facepile")?.getAttribute("aria-label")).toBe("ada");
  },
);

it("updates a pinned session's resolved avatar without replacing its row", () => {
  const { host, container, dom } = createHost();
  const session = projectSidebarSession({ key: "agent:main:pinned" });
  const [avatar, setAvatar] = createSignal("Loading avatar");
  const icon = () => {
    const label = avatar();
    return <span data-pinned-avatar>{label}</span>;
  };
  mountSolid(() => <RecentSession host={host} session={session} icon={icon()} />, { container });
  const row = dom.query(".sidebar-recent-session");
  expect(dom.text("[data-pinned-avatar]")).toBe("Loading avatar");

  setAvatar("Ada");
  flush();

  expect(dom.text("[data-pinned-avatar]")).toBe("Ada");
  expect(dom.query(".sidebar-recent-session")).toBe(row);
});
