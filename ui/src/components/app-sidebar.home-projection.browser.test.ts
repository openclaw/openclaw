import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { patchSettings } from "../app/settings.ts";
import {
  mountRoster,
  owners,
  selectFilter,
  settleRoster,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { catalogPage } from "../test-helpers/app-sidebar.ts";
import "../test-helpers/load-styles.ts";
import "./app-sidebar.tsx";

setupSidebarTest();

it("only shows a child disclosure on pins that can expand a sidebar branch", async () => {
  const main = "agent:main:main";
  const homeChild = "agent:main:home-child";
  const parent = "agent:main:project";
  const projectChild = "agent:main:project-child";
  const { sidebar } = await mountRoster(undefined, [
    {
      key: main,
      agentId: "main",
      kind: "direct",
      label: "Main session",
      childSessions: [homeChild],
    },
    {
      key: homeChild,
      agentId: "main",
      kind: "direct",
      label: "Release notes",
      spawnedBy: main,
    },
    {
      key: parent,
      agentId: "main",
      kind: "direct",
      label: "Design review",
      childSessions: [projectChild],
    },
    {
      key: projectChild,
      agentId: "main",
      kind: "direct",
      label: "Review screenshots",
      spawnedBy: parent,
    },
  ]);
  patchSettings({ sidebarAgentsMode: "chip" });
  sidebar.sidebarEntries = [main, parent].map((key) => `session:${key}`);
  await settleRoster(sidebar);

  const pins = sidebar.querySelector(".sidebar-recent-sessions--pinned")!;
  const disclosure = (key: string) =>
    pins.querySelector<HTMLButtonElement>(`[data-child-session-toggle="${key}"]`);
  expect(pins.querySelector(`[data-session-key="${main}"] a`)?.textContent).toContain(
    "Main session",
  );
  expect(sidebar.querySelector(`[data-session-key="${homeChild}"]`)?.textContent).toContain(
    "Release notes",
  );
  expect(disclosure(main)).toBeNull();

  const toggle = disclosure(parent)!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.click();
  await settleRoster(sidebar);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(pins.querySelector(`[data-session-key="${projectChild}"]`)?.textContent).toContain(
    "Review screenshots",
  );
});

for (const mode of ["chip", "roster"] as const) {
  it(`keeps self-parented Home navigable with child discovery in ${mode} mode`, async () => {
    const key = "agent:main:main";
    const { sidebar, context } = await mountRoster(undefined, [
      {
        key,
        agentId: "main",
        kind: "direct",
        parentSessionKey: key,
        updatedAt: 1,
        childSessions: ["agent:main:child", "agent:main:subagent:review"],
        label: "Home",
        lastMessagePreview: "Home context",
      },
      {
        key: "agent:main:child",
        agentId: "main",
        kind: "direct",
        parentSessionKey: key,
        spawnedBy: key,
        updatedAt: 2,
        label: "Child conversation",
      },
      {
        key: "agent:main:subagent:review",
        agentId: "main",
        kind: "direct",
        spawnedBy: key,
        updatedAt: 3,
        hasActiveRun: true,
        label: "Review worker",
      },
    ]);
    patchSettings({ sidebarAgentsMode: mode });
    await settleRoster(sidebar);
    const home = sidebar.projectHomeSession(sidebar.mainSessionRow()!, "main");
    expect(home.key).toBe(key);
    expect(home.subagentSummary?.runningChildCount).toBe(1);
    expect(home.childLoadParentKeys).toContain(key);
    expect(home.children?.map((row) => row.key)).toContain("agent:main:child");
    if (mode === "chip") {
      expect(sidebar.querySelector('[data-session-key="agent:main:child"]')?.textContent).toContain(
        "Child conversation",
      );
    } else {
      expect(sidebar.querySelector('[data-session-key="agent:main:child"]')).toBeNull();
      expect(
        sidebar.querySelector('[data-agent-group="main"] .sidebar-agent-roster__row'),
      ).not.toBeNull();
    }
    sidebar
      .querySelector<HTMLButtonElement>(
        ".sidebar-agent-card__main, .sidebar-workspace-header__main",
      )!
      .click();
    await settleRoster(sidebar);
    sidebar.querySelector<HTMLElement>('.sidebar-agent-menu [data-value="agent:recent"]')!.click();
    await settleRoster(sidebar);
    expect(context.agentSelection.state).toEqual({ selectedId: "recent", scopeId: "recent" });
    expect(sidebar.querySelector(".sidebar-agent-card__main")?.textContent).toContain("Scout");
  });
}

it("keeps agent switching available without a Home session", async () => {
  const { sidebar, context } = await mountRoster(undefined, []);
  expect(sidebar.mainSessionRow()).toBeNull();
  sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
  await settleRoster(sidebar);
  sidebar.querySelector<HTMLElement>('.sidebar-agent-menu [data-value="agent:recent"]')!.click();
  await settleRoster(sidebar);
  expect(context.agentSelection.state).toEqual({ selectedId: "recent", scopeId: "recent" });
  expect(sidebar.querySelector(".sidebar-agent-card__main")?.textContent).toContain("Scout");
});

it("opens a catalog-adopted parent's child from its personal pin", async () => {
  const parent = "agent:main:offlist-parent";
  const child = "agent:main:offlist-child";
  const { sidebar } = await mountRoster(undefined, [
    {
      key: parent,
      agentId: "main",
      kind: "direct",
      updatedAt: 1,
      label: "Off-list parent",
      childSessions: [child],
    },
    {
      key: child,
      agentId: "main",
      kind: "direct",
      updatedAt: 2,
      label: "Off-list child",
      spawnedBy: parent,
    },
  ]);
  patchSettings({ sidebarAgentsMode: "chip" });
  sidebar.sessionData.sessionCatalogs = catalogPage([
    { threadId: "parent", name: "Off-list parent", sessionKey: parent },
  ]).catalogs;
  sidebar.sessionData.requestSessionDataUpdate();
  await settleRoster(sidebar);

  const parentRow = `[data-session-key="${parent}"]`;
  expect(sidebar.querySelectorAll(parentRow)).toHaveLength(1);
  expect(
    sidebar.querySelector(`[data-session-section="catalog:codex"] ${parentRow}`),
  ).not.toBeNull();

  sidebar.sidebarEntries = [`session:${parent}`];
  await settleRoster(sidebar);

  const pins = sidebar.querySelector(".sidebar-recent-sessions--pinned")!;
  const toggle = pins.querySelector<HTMLButtonElement>(`[data-child-session-toggle="${parent}"]`)!;
  expect(toggle).not.toBeNull();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.click();
  await settleRoster(sidebar);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const childLink = pins.querySelector<HTMLAnchorElement>(`[data-session-key="${child}"] a`)!;
  expect(childLink.textContent).toContain("Off-list child");
  sidebar.onNavigate = vi.fn();
  childLink.click();
  expect(sidebar.onNavigate).toHaveBeenCalledWith("chat", { pathname: "/chat/main/offlist-child" });
});

it.each([false, true])(
  "retains a saved parent under another owner filter (matching child: %s)",
  async (matchingChild) => {
    const parent = "agent:main:sam-parent";
    const child = "agent:main:review";
    const hidden = "agent:main:sam-notes";
    const rows = [
      {
        key: parent,
        label: "Sam parent",
        childSessions: [child, hidden],
        owner: { actor: owners[1] },
      },
      {
        key: child,
        label: "Review",
        spawnedBy: parent,
        owner: { actor: owners[matchingChild ? 0 : 1] },
      },
      { key: hidden, label: "Sam notes", spawnedBy: parent, owner: { actor: owners[1] } },
    ];
    const { sidebar } = await mountRoster(
      undefined,
      rows.map((row) => Object.assign({}, row, { kind: "direct" as const, agentId: "main" })),
    );
    sidebar.sessionKey = parent;
    sidebar.activeRouteId = "chat";
    sidebar.sidebarEntries = [`session:${parent}`];
    await selectFilter(sidebar, "owner:profile-ada");
    await settleRoster(sidebar);

    const pins = () =>
      expectDefined(sidebar.querySelector('[data-session-section="pinned"]'), "pinned section");
    const link = (key: string) =>
      expectDefined(
        pins().querySelector<HTMLAnchorElement>(`[data-session-key="${key}"] a`),
        `saved navigation link for ${key}`,
      );
    expect(link(parent).textContent).toContain("Sam parent");
    sidebar.onNavigate = vi.fn();
    const toggle = pins().querySelector<HTMLButtonElement>(
      `[data-child-session-toggle="${parent}"]`,
    );
    if (matchingChild) {
      const disclosure = expectDefined(toggle, "matching child disclosure");
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      disclosure.click();
      await settleRoster(sidebar);
      link(child).click();
      expect(sidebar.onNavigate).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ pathname: "/chat/main/review" }),
      );
      await settleRoster(sidebar);
    } else {
      expect(toggle).toBeNull();
      expect(pins().querySelector(`[data-session-key="${child}"]`)).toBeNull();
    }
    expect(pins().querySelector(`[data-session-key="${hidden}"]`)).toBeNull();
    link(parent).click();
    expect(sidebar.onNavigate).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/main/sam-parent" }),
    );
    if (matchingChild) {
      sidebar.sidebarEntries = [];
      await settleRoster(sidebar);
      expect(sidebar.querySelector('[data-session-section="pinned"]')).toBeNull();
      sidebar.sidebarEntries = [`session:${parent}`];
      await settleRoster(sidebar);
      expect(
        pins()
          .querySelector(`[data-child-session-toggle="${parent}"]`)
          ?.getAttribute("aria-expanded"),
      ).toBe("false");
    }
  },
);

it("loads and opens a child named by a saved parent outside the sidebar list", async () => {
  const parent = "agent:main:described-parent";
  const child = "agent:main:described-child";
  const { sidebar, sessions } = await mountRoster(
    undefined,
    [],
    undefined,
    [
      {
        key: parent,
        sessionId: "described-parent",
        agentId: "main",
        kind: "direct",
        label: "Saved parent",
        childSessions: [child],
      },
    ],
    [],
    [
      {
        key: child,
        sessionId: "described-child",
        agentId: "main",
        kind: "direct",
        label: "Saved project notes",
        spawnedBy: parent,
      },
    ],
  );
  patchSettings({ sidebarAgentsMode: "chip" });
  sidebar.sidebarEntries = [`session:${parent}`];
  await settleRoster(sidebar);

  const pins = ".sidebar-recent-sessions--pinned";
  const toggle = () =>
    sidebar.querySelector<HTMLButtonElement>(`${pins} [data-child-session-toggle="${parent}"]`);
  await vi.waitFor(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("false"));
  expectDefined(toggle(), "saved parent disclosure").click();

  const childLink = () =>
    sidebar.querySelector<HTMLAnchorElement>(`${pins} [data-session-key="${child}"] a`);
  await vi.waitFor(() => expect(childLink()?.textContent).toContain("Saved project notes"));
  expect(sessions.list).toHaveBeenCalledWith(expect.objectContaining({ spawnedBy: parent }));
  sidebar.onNavigate = vi.fn();
  const link = expectDefined(childLink(), "loaded child link");
  expect(link.getAttribute("href")).toBe("/chat/main/described-child");
  link.click();
  expect(sidebar.onNavigate).toHaveBeenCalledWith(
    "chat",
    expect.objectContaining({ pathname: "/chat/main/described-child" }),
  );
});

it("keeps a descriptor-only pin navigable without inventing a child row", async () => {
  const parent = "agent:main:described-parent";
  const child = "agent:main:unavailable-child";
  const { sidebar } = await mountRoster(undefined, [], undefined, [
    {
      key: parent,
      sessionId: "described-parent",
      agentId: "main",
      kind: "direct",
      label: "Saved parent",
      childSessions: [child],
    },
  ]);
  patchSettings({ sidebarAgentsMode: "chip" });
  sidebar.sidebarEntries = [`session:${parent}`];
  await settleRoster(sidebar);

  const pins = ".sidebar-recent-sessions--pinned";
  const parentLink = () =>
    sidebar.querySelector<HTMLAnchorElement>(`${pins} [data-session-key="${parent}"] a`);
  await vi.waitFor(() => expect(parentLink()?.textContent).toContain("Saved parent"));
  expect(sidebar.querySelector(`${pins} [data-session-key="${child}"]`)).toBeNull();
  sidebar.onNavigate = vi.fn();
  parentLink()!.click();
  expect(sidebar.onNavigate).toHaveBeenCalledWith(
    "chat",
    expect.objectContaining({ pathname: "/chat/main/described-parent" }),
  );
});
