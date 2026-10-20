import { describe, expect, it } from "vitest";
import type { SessionCatalogSession } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { catalogPage, createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";
import { settleLitElement } from "../lit-settle.ts";
import "../../components/app-sidebar.tsx";

const collapsedKey = "openclaw:sidebar:sessions:collapsed-sections";
const collapsed = () => JSON.parse(localStorage.getItem(collapsedKey) ?? "[]");

async function mountCatalog(
  sessions: Array<Pick<SessionCatalogSession, "threadId"> & Partial<SessionCatalogSession>>,
) {
  const { sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    createSessions("main", ["agent:main:main"]),
  );
  const setCatalog = async (rows = sessions) => {
    const catalogs = catalogPage([]).catalogs;
    catalogs[0]!.hosts[0]!.sessions = rows.map((row) => ({
      status: "idle",
      archived: false,
      canContinue: true,
      canArchive: true,
      ...row,
    }));
    sidebar.sessionData.sessionCatalogs = catalogs;
    sidebar.sessionData.requestSessionDataUpdate();
    await settleLitElement(sidebar);
  };
  await setCatalog();
  const group = (key: string) =>
    sidebar.querySelector<HTMLButtonElement>(`[data-session-catalog-project="${key}"]`);
  return { sidebar, setCatalog, group };
}

function expectList(list: Element | null | undefined, label: string) {
  expect(list?.getAttribute("aria-label")).toBe(label);
  expect(
    [...(list?.children ?? [])].every((item) => item.getAttribute("role") === "listitem"),
  ).toBe(true);
}

describe("AppSidebar project session activity", () => {
  it("preserves collapsed project sections stored by earlier versions", async () => {
    localStorage.setItem(
      collapsedKey,
      JSON.stringify(["catalog-project:codex:gateway:local:custom:repo"]),
    );
    const { sidebar, group } = await mountCatalog([
      { threadId: "custom-group-thread", customGroup: "repo" },
      { threadId: "legacy-project-thread", cwd: "custom:repo" },
    ]);

    const customGroup = group("custom:repo");
    const project = group("project:custom:repo");
    expect([customGroup?.ariaExpanded, project?.ariaExpanded]).toEqual(["false", "false"]);
    expect(sidebar.querySelector('[data-session-key*="custom-group-thread"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-key*="legacy-project-thread"]')).toBeNull();

    project?.click();
    await sidebar.updateComplete;
    expect(customGroup?.getAttribute("aria-expanded")).toBe("true");
    expect(collapsed()).not.toContain("catalog-project:codex:gateway:local:custom:repo");

    project?.click();
    await sidebar.updateComplete;
    customGroup?.click();
    await sidebar.updateComplete;
    expect([project?.ariaExpanded, customGroup?.ariaExpanded]).toEqual(["false", "false"]);
    expect(collapsed()).toEqual([
      "catalog-project:codex:gateway:local:project:custom:repo",
      "catalog-custom:codex:gateway:local:custom:repo",
    ]);
  });

  it("preserves and migrates collapsed person sections stored by earlier versions", async () => {
    localStorage.setItem("openclaw:sidebar:sessions:catalog-grouping", "person");
    const legacySectionId = "catalog-project:codex:gateway:local:person:profile-ada";
    localStorage.setItem(collapsedKey, JSON.stringify([legacySectionId]));
    const { sidebar, group } = await mountCatalog([
      {
        threadId: "person-thread",
        name: "Ada's session",
        createdActor: {
          type: "human",
          id: "profile-ada",
          label: "Ada",
          identity: { type: "profile", id: "profile-ada" },
        },
      },
    ]);

    const person = group("person:profile:profile-ada");
    expect(person?.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar.querySelector('[data-session-key*="person-thread"]')).toBeNull();

    person?.click();
    await sidebar.updateComplete;
    expect(person?.getAttribute("aria-expanded")).toBe("true");
    person?.click();
    await sidebar.updateComplete;
    expect(collapsed()).toEqual(["catalog-person:codex:gateway:local:person:profile:profile-ada"]);
  });

  it("preserves catalog menu focus when project groups reorder", async () => {
    const sessions = [
      { threadId: "thread-a", name: "Project A", cwd: "/work/a" },
      { threadId: "thread-b", name: "Project B", cwd: "/work/b" },
    ];
    const { sidebar, setCatalog } = await mountCatalog(sessions);

    const menu = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-key*="thread-a"] [data-catalog-session-menu]',
    );
    menu?.focus();
    expect(document.activeElement).toBe(menu);

    await setCatalog(sessions.toReversed());

    expect(document.activeElement).toBe(menu);
  });

  it("shows thread-style activity indicators", async () => {
    const { sidebar, group } = await mountCatalog([
      {
        threadId: "active-thread",
        cwd: "/work/openclaw",
        status: "active",
        canContinue: false,
        canArchive: false,
      },
      { threadId: "idle-thread", cwd: "/work/openclaw" },
      { threadId: "loose-thread" },
    ]);

    const project = group("project:/work/openclaw");
    const active = sidebar.querySelector('[data-session-key*="active-thread"]');
    const idle = sidebar.querySelector('[data-session-key*="idle-thread"]');
    const loose = sidebar.querySelector('[data-session-key*="loose-thread"]');
    const projectItem = project?.closest(".sidebar-session-catalog-project");
    const hostList = projectItem?.parentElement;
    const projectList = active?.closest('[role="list"]');
    expect(hostList?.getAttribute("role")).toBe("list");
    expectList(hostList, "Local Codex");
    expect(projectItem?.getAttribute("role")).toBe("listitem");
    expectList(projectList, "Local Codex: openclaw");
    expect(idle?.closest('[role="list"]')).toBe(projectList);
    expect(loose?.parentElement).toBe(hostList);
    expect(loose?.getAttribute("role")).toBe("listitem");
    expect(active?.querySelector(".session-row-state")).toBeNull();
    const activeLead = active?.querySelector(".sidebar-session-indicator");
    expect(activeLead?.querySelector(".session-glyph__ring")?.getAttribute("aria-label")).toBe(
      "Active run",
    );
    const idleLead = idle?.querySelector(".sidebar-session-indicator");
    expect(active?.classList.contains("session-row-host--running")).toBe(true);
    expect(idleLead?.childElementCount).toBe(0);
    expect(idle?.querySelector(".session-row-state")).toBeNull();
  });
});
