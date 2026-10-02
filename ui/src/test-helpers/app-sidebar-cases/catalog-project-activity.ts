import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar project session activity", () => {
  it.each([
    {
      name: "non-first drive spelling without a canonical id",
      first: "C:\\Work\\Notes",
      second: "c:/work/notes/",
      key: "project:c:\\work\\notes",
      aliases: ["c:/WORK/NOTES/"],
    },
    {
      name: "multiple drive aliases including an absent worktree",
      first: "C:\\Work\\Notes",
      second: "c:/work/notes/",
      key: "project:c:\\work\\notes",
      aliases: [
        "C:\\Work\\Notes",
        "project:c:/WORK/NOTES/",
        "project:C:/Work/Notes/.CLAUDE/WORKTREES/removed/src",
        "project:c:\\work\\notes",
      ],
    },
    {
      name: "UNC aliases",
      first: "\\\\Server\\Share\\Notes",
      second: "\\\\server\\share\\notes\\",
      key: "project:\\\\server\\share\\notes",
      aliases: ["\\\\SERVER\\Share\\Notes", "project:\\\\server\\SHARE\\notes\\"],
    },
    {
      name: "legacy separator-free drive-root aliases",
      first: "C:\\",
      second: "c:/.CLAUDE/WORKTREES/fix/src",
      key: "project:c:\\",
      aliases: ["project:C:", "c:"],
    },
    {
      name: "drive-root worktree aliases",
      first: "C:\\",
      second: "c:/.CLAUDE/WORKTREES/fix/src",
      key: "project:c:\\",
      aliases: ["c:/", "project:C:/.CLAUDE/WORKTREES/removed/src"],
    },
  ])(
    "clears $name and preserves state through roster reorder and reload",
    async ({ first, second, key, aliases }) => {
      const prefix = "catalog-project:codex:gateway:local:";
      const canonicalId = prefix + key;
      const retained = [
        `catalog-project:codex:node:other:${key}`,
        `catalog-project:claude:gateway:local:${key}`,
      ];
      localStorage.setItem(
        "openclaw:sidebar:sessions:collapsed-sections",
        JSON.stringify([...retained, ...aliases.map((alias) => prefix + alias)]),
      );
      const gateway = createGateway({} as GatewayBrowserClient);
      const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
      const sessions = Array.from({ length: 6 }, (_, index) => ({
        threadId: `windows-${index}`,
        name: `Windows ${index}`,
        cwd: index === 0 ? first : second,
        status: "idle" as const,
        archived: false,
        canContinue: true,
        canArchive: true,
      }));
      const host = {
        hostId: "gateway:local",
        label: "Local Codex",
        kind: "gateway" as const,
        connected: true,
        sessions,
      };
      const catalog = {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: true },
        hosts: [host],
      };
      const refresh = async () => {
        sidebar.sessionData.sessionCatalogs = [{ ...catalog }];
        sidebar.sessionData.requestSessionDataUpdate();
        await sidebar.updateComplete;
      };
      await refresh();
      const head = () => sidebar.querySelector<HTMLButtonElement>("[data-session-catalog-project]");
      expect(sidebar.querySelectorAll("[data-session-catalog-project]")).toHaveLength(1);
      expect(head()?.getAttribute("aria-expanded")).toBe("false");
      host.sessions = sessions.toReversed();
      await refresh();
      expect(head()?.getAttribute("aria-expanded")).toBe("false");
      head()?.click();
      await sidebar.updateComplete;
      expect(head()?.getAttribute("aria-expanded")).toBe("true");
      const stored = () =>
        JSON.parse(localStorage.getItem("openclaw:sidebar:sessions:collapsed-sections") ?? "[]");
      expect(stored()).toEqual(retained);
      sidebar.querySelector<HTMLButtonElement>(".sidebar-session-pagination__button")?.click();
      await sidebar.updateComplete;
      expect(sidebar.querySelectorAll("[data-catalog-session-key]")).toHaveLength(6);
      host.sessions = sessions;
      await refresh();
      expect(sidebar.querySelectorAll("[data-catalog-session-key]")).toHaveLength(6);
      expect(head()?.getAttribute("aria-expanded")).toBe("true");
      head()?.click();
      await sidebar.updateComplete;
      expect(stored()).toEqual([...retained, canonicalId]);
      host.sessions = sessions.toReversed();
      await refresh();
      expect(head()?.getAttribute("aria-expanded")).toBe("false");
      // Recreate the view from the real preference reader, without retaining its in-memory state.
      const { sidebar: reloaded } = await mountSidebar(
        gateway,
        createSessions("main", ["agent:main:main"]),
      );
      reloaded.sessionData.sessionCatalogs = [catalog];
      reloaded.sessionData.requestSessionDataUpdate();
      await reloaded.updateComplete;
      const reloadedHead = reloaded.querySelector<HTMLButtonElement>(
        "[data-session-catalog-project]",
      );
      expect(reloadedHead?.getAttribute("aria-expanded")).toBe("false");
      reloadedHead?.click();
      await reloaded.updateComplete;
      expect(stored()).toEqual(retained);
      expect(reloaded.querySelectorAll("[data-catalog-session-key]")).toHaveLength(5);
    },
  );

  it("keeps drive-relative and absolute-root collapse preferences independent", async () => {
    const storageKey = "openclaw:sidebar:sessions:collapsed-sections";
    const relativeId = "catalog-project-drive-relative:codex:gateway:local:project:C:";
    const rootId = "catalog-project:codex:gateway:local:project:c:\\";
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const sessions = [
      { threadId: "relative-root", cwd: "C:" },
      { threadId: "absolute-root", cwd: "C:\\" },
    ].map((session) =>
      Object.assign(session, {
        status: "idle" as const,
        archived: false,
        canContinue: true,
        canArchive: true,
      }),
    );
    const host = {
      hostId: "gateway:local",
      label: "Local Codex",
      kind: "gateway" as const,
      connected: true,
      sessions,
    };
    const catalog = {
      id: "codex",
      label: "Codex",
      capabilities: { continueSession: true, archive: true },
      hosts: [host],
    };
    const refresh = async () => {
      sidebar.sessionData.sessionCatalogs = [{ ...catalog }];
      sidebar.sessionData.requestSessionDataUpdate();
      await sidebar.updateComplete;
    };
    const head = (view: typeof sidebar, key: string) =>
      Array.from(view.querySelectorAll<HTMLButtonElement>("[data-session-catalog-project]")).find(
        (button) => button.dataset.sessionCatalogProject === key,
      );
    const stored = () => JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    await refresh();
    expect(sidebar.querySelectorAll("[data-session-catalog-project]")).toHaveLength(2);
    head(sidebar, "project:C:")?.click();
    await sidebar.updateComplete;
    expect(head(sidebar, "project:C:")?.getAttribute("aria-expanded")).toBe("false");
    expect(head(sidebar, "project:c:\\")?.getAttribute("aria-expanded")).toBe("true");
    expect(stored()).toEqual([relativeId]);
    head(sidebar, "project:c:\\")?.click();
    await sidebar.updateComplete;
    expect(stored()).toEqual([relativeId, rootId]);
    host.sessions = sessions.toReversed();
    await refresh();
    expect(head(sidebar, "project:C:")?.getAttribute("aria-expanded")).toBe("false");
    expect(head(sidebar, "project:c:\\")?.getAttribute("aria-expanded")).toBe("false");
    head(sidebar, "project:C:")?.click();
    await sidebar.updateComplete;
    expect(stored()).toEqual([rootId]);
    expect(head(sidebar, "project:c:\\")?.getAttribute("aria-expanded")).toBe("false");
    head(sidebar, "project:C:")?.click();
    await sidebar.updateComplete;
    host.sessions = sessions.filter((session) => session.threadId !== "relative-root");
    await refresh();
    head(sidebar, "project:c:\\")?.click();
    await sidebar.updateComplete;
    expect(stored()).toEqual([relativeId]);
    // Restore through the persisted reader while the relative session is still absent.
    const { sidebar: reloaded } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main"]),
    );
    const reload = async () => {
      reloaded.sessionData.sessionCatalogs = [{ ...catalog }];
      reloaded.sessionData.requestSessionDataUpdate();
      await reloaded.updateComplete;
    };
    await reload();
    expect(head(reloaded, "project:c:\\")?.getAttribute("aria-expanded")).toBe("true");
    head(reloaded, "project:c:\\")?.click();
    await reloaded.updateComplete;
    head(reloaded, "project:c:\\")?.click();
    await reloaded.updateComplete;
    expect(stored()).toEqual([relativeId]);
    host.sessions = sessions.toReversed();
    await reload();
    expect(head(reloaded, "project:C:")?.getAttribute("aria-expanded")).toBe("false");
    expect(head(reloaded, "project:c:\\")?.getAttribute("aria-expanded")).toBe("true");
    head(reloaded, "project:C:")?.click();
    await reloaded.updateComplete;
    expect(stored()).toEqual([]);
  });

  it("preserves collapsed project sections stored by earlier versions", async () => {
    localStorage.setItem(
      "openclaw:sidebar:sessions:collapsed-sections",
      JSON.stringify(["catalog-project:codex:gateway:local:custom:repo"]),
    );
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.sessionData.sessionCatalogs = [
      {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: true },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "custom-group-thread",
                name: "Custom group session",
                customGroup: "repo",
                status: "idle",
                archived: false,
                canContinue: true,
                canArchive: true,
              },
              {
                threadId: "legacy-project-thread",
                name: "Legacy collapsed project",
                cwd: "custom:repo",
                status: "idle",
                archived: false,
                canContinue: true,
                canArchive: true,
              },
            ],
          },
        ],
      },
    ];
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const customGroup = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-catalog-project="custom:repo"]',
    );
    const project = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-catalog-project="project:custom:repo"]',
    );
    expect(customGroup?.getAttribute("aria-expanded")).toBe("false");
    expect(project?.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar.querySelector('[data-session-key*="custom-group-thread"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-key*="legacy-project-thread"]')).toBeNull();

    project?.click();
    await sidebar.updateComplete;
    expect(customGroup?.getAttribute("aria-expanded")).toBe("true");
    expect(
      JSON.parse(localStorage.getItem("openclaw:sidebar:sessions:collapsed-sections") ?? "[]"),
    ).not.toContain("catalog-project:codex:gateway:local:custom:repo");

    project?.click();
    await sidebar.updateComplete;
    customGroup?.click();
    await sidebar.updateComplete;
    expect(project?.getAttribute("aria-expanded")).toBe("false");
    expect(customGroup?.getAttribute("aria-expanded")).toBe("false");
    expect(
      JSON.parse(localStorage.getItem("openclaw:sidebar:sessions:collapsed-sections") ?? "[]"),
    ).toEqual([
      "catalog-project:codex:gateway:local:project:custom:repo",
      "catalog-custom:codex:gateway:local:custom:repo",
    ]);
  });

  it("preserves and migrates collapsed person sections stored by earlier versions", async () => {
    localStorage.setItem("openclaw:sidebar:sessions:catalog-grouping", "person");
    const legacySectionId = "catalog-project:codex:gateway:local:person:profile-ada";
    localStorage.setItem(
      "openclaw:sidebar:sessions:collapsed-sections",
      JSON.stringify([legacySectionId]),
    );
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.sessionData.sessionCatalogs = [
      {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: true },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "person-thread",
                name: "Ada's session",
                createdActor: {
                  type: "human",
                  id: "profile-ada",
                  label: "Ada",
                  identity: { type: "profile", id: "profile-ada" },
                },
                status: "idle",
                archived: false,
                canContinue: true,
                canArchive: true,
              },
            ],
          },
        ],
      },
    ];
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const person = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-catalog-project="person:profile:profile-ada"]',
    );
    expect(person?.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar.querySelector('[data-session-key*="person-thread"]')).toBeNull();

    person?.click();
    await sidebar.updateComplete;
    expect(person?.getAttribute("aria-expanded")).toBe("true");
    person?.click();
    await sidebar.updateComplete;
    expect(
      JSON.parse(localStorage.getItem("openclaw:sidebar:sessions:collapsed-sections") ?? "[]"),
    ).toEqual(["catalog-person:codex:gateway:local:person:profile:profile-ada"]);
  });

  it("preserves catalog menu focus when project groups reorder", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const sessions = [
      { threadId: "thread-a", name: "Project A", cwd: "/work/a" },
      { threadId: "thread-b", name: "Project B", cwd: "/work/b" },
    ];
    const setCatalog = async (orderedSessions: typeof sessions) => {
      sidebar.sessionData.sessionCatalogs = [
        {
          id: "codex",
          label: "Codex",
          capabilities: { continueSession: true, archive: true },
          hosts: [
            {
              hostId: "gateway:local",
              label: "Local Codex",
              kind: "gateway",
              connected: true,
              sessions: orderedSessions.map((session) => ({
                ...session,
                status: "idle" as const,
                archived: false,
                canContinue: true,
                canArchive: true,
              })),
            },
          ],
        },
      ];
      sidebar.sessionData.requestSessionDataUpdate();
      await sidebar.updateComplete;
    };
    await setCatalog(sessions);

    const menu = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-key*="thread-a"] [data-catalog-session-menu]',
    );
    menu?.focus();
    expect(document.activeElement).toBe(menu);

    await setCatalog(sessions.toReversed());

    expect(document.activeElement).toBe(menu);
  });

  it("shows thread-style activity indicators", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.sessionData.sessionCatalogs = [
      {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: true },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "active-thread",
                name: "Active session",
                cwd: "/work/openclaw",
                status: "active",
                archived: false,
                canContinue: false,
                canArchive: false,
              },
              {
                threadId: "idle-thread",
                name: "Idle session",
                cwd: "/work/openclaw",
                status: "idle",
                archived: false,
                canContinue: true,
                canArchive: true,
              },
              {
                threadId: "loose-thread",
                name: "Loose session",
                status: "idle",
                archived: false,
                canContinue: true,
                canArchive: true,
              },
            ],
          },
        ],
      },
    ];
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const project = sidebar.querySelector(
      '[data-session-catalog-project="project:/work/openclaw"]',
    );
    const active = sidebar.querySelector('[data-session-key*="active-thread"]');
    const idle = sidebar.querySelector('[data-session-key*="idle-thread"]');
    const loose = sidebar.querySelector('[data-session-key*="loose-thread"]');
    const projectItem = project?.closest(".sidebar-session-catalog-project");
    const hostList = projectItem?.parentElement;
    const projectList = active?.closest('[role="list"]');
    expect(project).not.toBeNull();
    expect(hostList?.getAttribute("role")).toBe("list");
    expect(hostList?.getAttribute("aria-label")).toBe("Local Codex");
    expect(
      [...(hostList?.children ?? [])].every((item) => item.getAttribute("role") === "listitem"),
    ).toBe(true);
    expect(projectItem?.getAttribute("role")).toBe("listitem");
    expect(projectList?.getAttribute("aria-label")).toBe("Local Codex: openclaw");
    expect(
      [...(projectList?.children ?? [])].every((item) => item.getAttribute("role") === "listitem"),
    ).toBe(true);
    expect(idle?.closest('[role="list"]')).toBe(projectList);
    expect(loose?.parentElement).toBe(hostList);
    expect(loose?.getAttribute("role")).toBe("listitem");
    expect(active?.querySelector(".session-row-state")).toBeNull();
    const activeLead = active?.querySelector(".sidebar-session-indicator");
    expect(activeLead?.querySelector(".session-glyph__ring")?.getAttribute("aria-label")).toBe(
      "Active run",
    );
    const idleLead = idle?.querySelector(".sidebar-session-indicator");
    expect(activeLead).not.toBeNull();
    expect(active?.classList.contains("session-row-host--running")).toBe(true);
    expect(idleLead).not.toBeNull();
    expect(idleLead?.childElementCount).toBe(0);
    expect(idle?.querySelector(".session-row-state")).toBeNull();
  });
});
