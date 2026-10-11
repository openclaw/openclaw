/* @vitest-environment jsdom */

import { render, type ReactiveElement } from "lit";
import { expect, it, onTestFinished, vi } from "vitest";
import "../test-helpers/app-sidebar-suite.ts";
import { renderAppSidebarOnline } from "./app-sidebar-online.ts";
import { renderAppSidebarBrand, type AppSidebarRenderHost } from "./app-sidebar-render.ts";
import { projectSidebarSession } from "./app-sidebar-session-navigation.test-support.ts";
import { renderRecentSession, type SessionListHost } from "./app-sidebar-session-row-render.ts";
import { resolveSidebarSessionRowSubtitle } from "./session-row-subtitle.ts";
import type { SidebarSnapshotController } from "./sidebar-snapshot-controller.ts";
import {
  parseSidebarSnapshot,
  restoreSnapshotSession,
  snapshotSessions,
  type SidebarSnapshotModel,
} from "./sidebar-snapshot-model.ts";
import "./app-sidebar.ts";

const emptySnapshot: SidebarSnapshotModel = {
  routingDefaults: { mainKey: "main", scope: "per-sender" },
  roster: null,
  mode: "chip",
  navigationView: "sessions",
  navigationScope: "all",
  scopesEquivalent: false,
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
  onlineExpanded: false,
  ownerId: null,
  involvingMe: false,
  footer: null,
  brand: { name: "Harbor", avatar: null, icon: "claw", environment: null },
};

function createHost() {
  const host = document.createElement("openclaw-app-sidebar") as AppSidebarRenderHost &
    SessionListHost &
    Pick<
      ConstructorParameters<typeof SidebarSnapshotController>[0],
      "restoreSidebarSnapshot" | "releaseSidebarSnapshot"
    >;
  host.sidebarAgentsMode = "roster";
  host.sessionOwnershipVisibility = { filters: true, avatars: true };
  const container = document.createElement("div");
  document.body.append(container);
  return { host, container };
}

it("renders the saved chip identity before agent discovery without reviving another agent's chip", async () => {
  const { host, container } = createHost();
  host.sidebarAgentsMode = "chip";
  host.sessionKey = "agent:main:thread";
  expect(host.activeChipAgent().agent).toBeUndefined();
  host.restoreSidebarSnapshot({
    ...emptySnapshot,
    brand: { ...emptySnapshot.brand, agentId: "main", name: "Harbor", textAvatar: "⚓" },
  });
  render(renderAppSidebarBrand(host), container);
  const card = container.querySelector<ReactiveElement>("openclaw-sidebar-agent-card");
  expect(card).not.toBeNull();
  await card!.updateComplete;
  expect(container.querySelector(".sidebar-workspace-header")).toBeNull();
  expect(card!.querySelector(".sidebar-agent-card__name")?.textContent).toContain("Harbor");
  expect(card!.querySelector("[data-avatar='⚓']")).not.toBeNull();
  host.sessionKey = "agent:other:thread";
  render(renderAppSidebarBrand(host), container);
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
  render(renderRecentSession({ host, session }), container);
  expect(container.querySelector(".sidebar-recent-session__subtitle")?.textContent).toBe(
    "The report is ready for review.",
  );
  const [cached] = snapshotSessions([session], (row) => ({
    snapshotSubtitle: resolveSidebarSessionRowSubtitle(host, row),
  }));
  host.sidebarSnapshot = parseSidebarSnapshot({
    ...emptySnapshot,
    sessions: [cached],
  });
  expect(host.sidebarSnapshot).not.toBeNull();
  const restored = restoreSnapshotSession(host.sidebarSnapshot!.sessions[0]!, session.key);
  render(renderRecentSession({ host, session: restored }), container);
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

it("keeps a pre-hello Online expansion after releasing the cached sidebar", () => {
  const { host, container } = createHost();
  host.sidebarAgentsMode = "chip";
  host.restoreSidebarSnapshot({
    ...emptySnapshot,
    collapsedSections: ["online"],
    onlineUsers: [{ id: "ada", name: "Ada", watchedSessions: [] }],
  });
  host.sessionData.presencePayload = { presence: [{ ts: 1, user: { id: "ada", name: "Ada" } }] };
  const update = () => render(renderAppSidebarOnline(host), container);
  update();
  const toggle = container.querySelector<HTMLButtonElement>(".sidebar-session-group-toggle")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector(".sidebar-online__list")).toBeNull();
  toggle.click();
  update();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector(".sidebar-online__person-name")?.textContent).toBe("Ada");
  host.releaseSidebarSnapshot();
  update();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector(".sidebar-online__person-name")?.textContent).toBe("Ada");
});

it("shows unavailable counts after a failed live summary instead of retaining saved totals", () => {
  const { host, container } = createHost();
  host.restoreSidebarSnapshot({
    ...emptySnapshot,
    mode: "roster",
    onlineExpanded: true,
    onlineUsers: [
      { id: "ada", name: "Ada", identity: { type: "profile", id: "ada" }, watchedSessions: [] },
    ],
    onlineCounts: [["ada", { open: 2, running: 1 }]],
  });
  render(renderAppSidebarOnline(host), container);
  expect(container.querySelector(".sidebar-online__counts")).not.toBeNull();
  host.releaseSidebarSnapshot();
  host.sessionData.ownerCounts.error = "Synthetic count failure";
  render(renderAppSidebarOnline(host), container);
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
    const update = () => render(renderRecentSession({ host, session }), container);
    update();
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
    expect(facepile.querySelector(".viewer-facepile")?.getAttribute("aria-label")).toBe("ada");
  },
);

it("keeps Online facepiles idle until presence or time-sensitive ordering changes", async () => {
  vi.useFakeTimers();
  const now = 1_800_000_000_000;
  vi.setSystemTime(now);
  const { host, container } = createHost();
  const presence = ["ada", "zoe"].map((id) => ({
    ts: now,
    user: { id, identity: { type: "profile" as const, id }, name: id },
    lastActivityAt: id === "ada" ? now - 119_999 : now,
  }));
  host.sessionData.presencePayload = { presence };
  const update = () => render(renderAppSidebarOnline(host), container);
  update();
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

  vi.setSystemTime(now + 2);
  update();
  await facepile.updateComplete;
  expect(updates.length).toBeGreaterThan(0);
  updates.length = 0;
  expect(facepile.querySelector(".viewer-facepile")?.getAttribute("aria-label")).toBe("zoe, ada");

  host.sessionData.presencePayload = { presence: presence.slice(0, 1) };
  update();
  await facepile.updateComplete;
  expect(updates.length).toBeGreaterThan(0);
  expect(facepile.querySelector(".viewer-facepile")?.getAttribute("aria-label")).toBe("ada");
});
