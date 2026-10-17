import { describe, expect, it } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogSession,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { activateSessionMenuValue } from "../app-sidebar-menu.ts";
import { createGatewayHarness, type SidebarLifecycleState } from "../app-sidebar.ts";
import { settleLitElement } from "../lit-settle.ts";
import { waitForFast } from "../wait-for.ts";
import { sessionFixture, human, sessionQuery, sessionList } from "./session-suite.test-support.ts";
import "../../components/app-sidebar.tsx";

async function selectOwner(sidebar: SidebarLifecycleState, ownerId: string, involvingMe = false) {
  await activateSessionMenuValue(sidebar, involvingMe ? "involving-me" : `owner:${ownerId}`);
  await waitForFast(() => expect(sidebar.sessionData.sessionsLoading).toBe(false));
  await sidebar.updateComplete;
}

function catalogSession(
  threadId: string,
  name: string,
  overrides: Partial<SessionCatalogSession> = {},
): SessionCatalogSession {
  return {
    threadId,
    name,
    status: "stored",
    archived: false,
    canContinue: true,
    canArchive: false,
    ...overrides,
  };
}

function catalog(sessions: SessionCatalogSession[]): SessionCatalog[] {
  return [
    {
      id: "claude",
      label: "Claude Code",
      capabilities: { continueSession: true, archive: false },
      hosts: [
        {
          hostId: "gateway:local",
          label: "Local Claude",
          kind: "gateway",
          connected: true,
          sessions,
        },
      ],
    },
  ];
}

describe("AppSidebar session ownership filtering", () => {
  it("uses the complete owner facet instead of raw loaded-row principals", async () => {
    const harness = createSessionsHarness("main", [
      "agent:main:opaque-profile",
      "agent:main:discord-channel",
      "agent:main:session-principal",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const opaqueProfile = result.sessions.find((row) => row.key.endsWith(":opaque-profile"));
    const discordChannel = result.sessions.find((row) => row.key.endsWith(":discord-channel"));
    const sessionPrincipal = result.sessions.find((row) => row.key.endsWith(":session-principal"));
    if (!opaqueProfile || !discordChannel || !sessionPrincipal) {
      throw new Error("expected owner rows");
    }
    opaqueProfile.createdActor = {
      type: "human",
      id: "profile:channel:opaque",
      label: "Channel Keeper",
    };
    opaqueProfile.owner = { actor: opaqueProfile.createdActor };
    discordChannel.createdActor = { type: "human", id: "discord:channel:123" };
    sessionPrincipal.createdActor = {
      type: "agent",
      id: "agent:roboclaw:discord:channel:456",
    };
    result.owners = [
      { type: "human", id: "profile:channel:opaque", label: "Channel Keeper" },
      { type: "agent", id: "research", label: "Research" },
    ];

    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>("#sidebar-session-owner-title")!.click();
    await sidebar.updateComplete;
    const menu = sidebar.querySelector(".sidebar-session-owner-filter")!;
    expect(menu?.querySelector('[data-value="owner:profile:channel:opaque"]')).not.toBeNull();
    expect(menu?.textContent).toContain("Channel Keeper");
    expect(
      sidebar.querySelector(
        '[data-session-key="agent:main:opaque-profile"] openclaw-session-owner-chip',
      ),
    ).toBeNull();
    expect(
      sidebar.querySelector(
        '[data-session-key="agent:main:discord-channel"] openclaw-session-owner-chip',
      ),
    ).toBeNull();
    expect(
      sidebar.querySelector(
        '[data-session-key="agent:main:session-principal"] openclaw-session-owner-chip',
      ),
    ).toBeNull();
    expect(menu?.querySelector('[data-value="owner:discord:channel:123"]')).toBeNull();
    expect(
      menu?.querySelector('[data-value="owner:agent:roboclaw:discord:channel:456"]'),
    ).toBeNull();

    result.owners = undefined;
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    const unavailableMenu = sidebar.querySelector("#sidebar-session-owner-title");
    expect(unavailableMenu?.querySelector('[data-value^="owner:"]') ?? null).toBeNull();
    expect(unavailableMenu?.textContent ?? "").not.toContain("Channel Keeper");
  });

  it("filters by effective owner and hides custom groups without matching sessions", async () => {
    const harness = sessionFixture(["agent:main:main", "agent:main:ada", "agent:main:bob"]);
    const result = harness.result;
    const ada = harness.row("agent:main:ada");
    const bob = harness.row("agent:main:bob");
    ada.createdActor = human("Bob");
    ada.owner = {
      actor: human("Ada"),
      assignedBy: human("Bob"),
      assignedAt: 10,
    };
    ada.category = "Research";
    bob.createdActor = human("Ada");
    bob.owner = {
      actor: human("Bob"),
      assignedBy: human("Ada"),
      assignedAt: 11,
    };
    bob.category = "Operations";
    result.owners = [human("Ada"), human("Bob")];
    harness.publish({ groups: ["Research", "Operations"] });
    const { sidebar } = await harness.mount();
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    expect(sidebar.querySelectorAll("openclaw-session-owner-chip")).toHaveLength(2);
    await selectOwner(sidebar, "profile-ada");

    expect(sessionQuery(sidebar, "agent:main:ada")).not.toBeNull();
    expect(sessionQuery(sidebar, "agent:main:bob")).toBeNull();
    expect(sidebar.querySelector('[data-session-section="category:Research"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-section="category:Operations"]')).toBeNull();
    expect(
      sidebar.querySelector(".sidebar-session-toolbar .sidebar-session-sort--filtered"),
    ).toBeNull();

    await activateSessionMenuValue(sidebar, "empty-groups:never");
    await sidebar.updateComplete;
    // The explicit display choice restores the heading, never filtered-out sessions.
    expect(sidebar.querySelector('[data-session-section="category:Operations"]')).not.toBeNull();
    expect(sessionQuery(sidebar, "agent:main:bob")).toBeNull();
    await selectOwner(sidebar, "");
    await selectOwner(sidebar, "profile-ada");
    expect(sidebar.querySelector('[data-session-section="category:Operations"]')).not.toBeNull();
    expect(sessionQuery(sidebar, "agent:main:bob")).toBeNull();
  });

  it.each([
    { grouping: "category", filter: "mine" },
    { grouping: "person", filter: "involving-me" },
    { grouping: "project", filter: "mine" },
    { grouping: "none", filter: "involving-me" },
  ] as const)(
    "hides zero-match $grouping sections for $filter without changing Everyone or populated groups",
    async ({ grouping, filter }) => {
      const gateway = createGatewayHarness({} as GatewayBrowserClient);
      gateway.publish({ selfUser: { id: "profile-ada", name: "Ada" } });
      const harness = sessionFixture(["agent:main:match", "agent:main:other"]);
      const result = harness.result;
      const match = harness.row("agent:main:match");
      const other = harness.row("agent:main:other");
      const ada = {
        ...human("Ada"),
        identity: { type: "profile" as const, id: "profile-ada" },
      };
      const bob = {
        ...human("Bob"),
        identity: { type: "profile" as const, id: "profile-bob" },
      };
      match.owner = { actor: filter === "mine" ? ada : bob };
      match.participants = [{ identity: ada.identity, label: "Ada" }];
      match.category = "Research";
      match.kind = "group";
      match.spawnedWorkspaceDir = "/repos/research";
      other.owner = { actor: bob };
      other.category = "Operations";
      other.spawnedWorkspaceDir = "/repos/operations";
      result.owners = [ada, bob];
      harness.publish({ groups: ["Empty", "Research", "Operations"] });
      // The Gateway owns personal membership, including participation outside
      // the bounded avatar preview. Its filtered response is the UI boundary.
      harness.list.mockImplementation(async () => ({ ...result, count: 1, sessions: [match] }));
      const { sidebar } = await harness.mount(gateway.gateway);
      Object.assign(sidebar, { sessionsGrouping: grouping });
      await sidebar.updateComplete;
      const sectionIds = () =>
        [...sidebar.querySelectorAll<HTMLElement>("[data-session-section]")].map(
          (section) => section.dataset.sessionSection,
        );
      const everyoneSections = sectionIds();
      if (grouping === "category") {
        expect(everyoneSections).toContain("category:Empty");
        expect(everyoneSections).toContain("groups");
      }

      await selectOwner(sidebar, "profile-ada", filter === "involving-me");
      expect(harness.list).toHaveBeenCalledWith(
        expect.objectContaining(
          filter === "mine" ? { ownerId: "profile-ada" } : { involvingMe: true },
        ),
      );
      const matchingSection =
        grouping === "category"
          ? "category:Research"
          : grouping === "person"
            ? `person:profile:${match.owner.actor.id}`
            : grouping === "project"
              ? "project:/repos/research"
              : "ungrouped";
      expect(sectionIds()).toEqual([matchingSection]);
      expect(sessionQuery(sidebar, "agent:main:match")).not.toBeNull();
      expect(sessionQuery(sidebar, "agent:main:other")).toBeNull();
      if (grouping !== "none") {
        sidebar.sessionOrganizer.saveCollapsedSessionSections(new Set([matchingSection]));
        await sidebar.updateComplete;
        expect(sectionIds()).toEqual([matchingSection]);
        expect(sidebar.querySelector(".sidebar-session-group-count")?.textContent).toBe("1");
        expect(sessionQuery(sidebar, "agent:main:match")).toBeNull();
      }

      harness.list.mockResolvedValue({ ...result, count: 0, sessions: [] });
      await sidebar.sessionData.refreshSidebarSessions();
      await sidebar.updateComplete;
      expect(sectionIds()).toEqual([]);
      expect(sidebar.querySelector(".sidebar-session-toolbar")).not.toBeNull();

      await selectOwner(sidebar, "");
      expect(sectionIds()).toEqual(everyoneSections);
      expect(harness.sessions.state.groups).toEqual(["Empty", "Research", "Operations"]);
    },
  );

  it("filters adopted catalog rows by authoritative live ownership", async () => {
    const backingSessionKey = "agent:main:claude-bound";
    const harness = sessionFixture(["agent:main:main", "agent:main:ada", backingSessionKey]);
    const result = harness.result;
    const ada = harness.row("agent:main:ada");
    const adopted = harness.row(backingSessionKey);
    ada.createdActor = human("Ada");
    adopted.createdActor = human("Ada");
    adopted.owner = {
      actor: human("Bob"),
      assignedBy: human("Ada"),
      assignedAt: 10,
    };
    result.owners = [human("Ada"), human("Bob")];

    const { sidebar } = await harness.mount();
    sidebar.sessionData.sessionCatalogs = catalog([
      catalogSession("claude-thread", "Claude session", {
        sessionKey: backingSessionKey,
        createdActor: human("Ada"),
      }),
      catalogSession("external-thread", "External unowned session"),
    ]);
    sidebar.sessionData.requestSessionDataUpdate();
    harness.publishList({ result, agentId: "main" });
    await settleLitElement(sidebar);

    expect(sessionQuery(sidebar, backingSessionKey)).not.toBeNull();
    expect(sidebar.textContent).toContain("External unowned session");
    await selectOwner(sidebar, "profile-bob");

    expect(sessionQuery(sidebar, backingSessionKey)).not.toBeNull();
    expect(sidebar.textContent).not.toContain("External unowned session");

    harness.publishList({
      result: { ...result, count: 1, sessions: [ada] },
      agentId: "main",
    });
    await sidebar.sessionData.refreshSidebarSessions();
    await settleLitElement(sidebar);
    expect(sessionQuery(sidebar, backingSessionKey)).toBeNull();
    expect(sidebar.textContent).not.toContain("External unowned session");
  });

  it("keeps catalog rows whose backing ownership is outside the loaded page", async () => {
    const harness = sessionFixture(["agent:main:main", "agent:main:ada", "agent:main:bob"]);
    const result = harness.result;
    const ada = harness.row("agent:main:ada");
    const bob = harness.row("agent:main:bob");
    ada.createdActor = human("Ada");
    bob.createdActor = human("Bob");
    result.owners = [human("Ada"), human("Bob")];

    const unloadedSessionKey = "agent:main:beyond-loaded-page";
    const { sidebar } = await harness.mount();
    sidebar.sessionData.sessionCatalogs = catalog([
      catalogSession("unloaded-thread", "Unloaded backing session", {
        sessionKey: unloadedSessionKey,
        createdActor: human("Ada"),
      }),
    ]);
    sidebar.sessionData.requestSessionDataUpdate();
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    await selectOwner(sidebar, "profile-ada");
    expect(sessionQuery(sidebar, unloadedSessionKey)).not.toBeNull();
  });

  it("badges the owner avatar and announces unread once", async () => {
    const key = "agent:main:unread";
    const harness = sessionFixture(["agent:main:main", key, "agent:main:other"]);
    const result = harness.result;
    const unread = harness.row(key);
    const other = harness.row("agent:main:other");
    unread.createdActor = human("Ada");
    unread.owner = { actor: unread.createdActor };
    unread.unread = true;
    other.createdActor = human("Bob");
    other.owner = { actor: other.createdActor };
    result.owners = [human("Ada"), human("Bob")];

    const { sidebar } = await harness.mount();
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    const row = sessionQuery(sidebar, key);
    expect(row?.querySelector(".session-glyph openclaw-session-owner-chip")).not.toBeNull();
    const badge = row?.querySelector(".sidebar-session-indicator .session-glyph__badge--unread");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("role")).toBe("img");
    expect(row?.querySelector(".session-row-state")).toBeNull();
    const link = row!.querySelector("a")!;
    const description = (link.getAttribute("aria-describedby") ?? "")
      .split(/\s+/u)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    const name = [...link.querySelectorAll('[role="img"]')]
      .filter((image) => !image.closest('[aria-hidden="true"]'))
      .map((image) => image.getAttribute("aria-label") ?? "")
      .join(" ");
    expect(`${link.textContent} ${name} ${description}`.match(/Unread/g)).toHaveLength(1);
  });

  it("keeps owner avatars off child rows", async () => {
    const parentKey = "agent:main:parent";
    const childKey = "agent:main:child";
    const harness = createSessionsHarness("main", [parentKey]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const parentRow = result.sessions[0];
    if (!parentRow) {
      throw new Error("expected parent row");
    }
    result.sessions[0] = {
      ...parentRow,
      key: parentKey,
      createdActor: { type: "human", id: "profile-ada", label: "Ada" },
      owner: { actor: { type: "human", id: "profile-ada", label: "Ada" } },
      childSessions: [childKey],
    };
    result.owners = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
    ];
    harness.list.mockResolvedValue({
      ts: 2,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: childKey,
          spawnedBy: parentKey,
          kind: "direct",
          label: "Child task",
          updatedAt: 2,
          status: "done",
          createdActor: { type: "human", id: "profile-bob", label: "Bob" },
          owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
        },
      ],
    });

    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(`[data-child-session-toggle="${parentKey}"]`)?.click();
    await waitForFast(() =>
      expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).not.toBeNull(),
    );

    expect(
      sidebar.querySelector(`[data-session-key="${parentKey}"] openclaw-session-owner-chip`),
    ).not.toBeNull();
    expect(
      sidebar.querySelector(`[data-session-key="${childKey}"] openclaw-session-owner-chip`),
    ).toBeNull();
    expect(
      sidebar.querySelector(`[data-session-key="${childKey}"] [aria-label="Done"]`),
    ).not.toBeNull();
  });

  it("renders a controlled child once under its explicit dashboard parent", async () => {
    const navigationParentKey = "agent:main:dashboard:navigation-parent";
    const controlParentKey = "agent:main:main";
    const childKey = "agent:main:dashboard:controlled-child";
    const child = {
      key: childKey,
      kind: "direct" as const,
      label: "Controlled child",
      updatedAt: 3,
      parentSessionKey: navigationParentKey,
      spawnedBy: controlParentKey,
    };
    const harness = sessionFixture([navigationParentKey]);
    harness.list.mockImplementation(async (options) => {
      const sessions = options?.spawnedBy === navigationParentKey ? [child] : [];
      return sessionList(sessions, { ts: 3 });
    });
    const { sidebar } = await harness.mount();
    harness.publishList({
      result: sessionList(
        [
          {
            key: navigationParentKey,
            kind: "direct",
            label: "Dashboard parent",
            updatedAt: 2,
            childSessions: [childKey],
          },
        ],
        { ts: 3 },
      ),
    });
    await settleLitElement(sidebar);
    expect(
      sidebar
        .querySelector(`[data-child-session-toggle="${navigationParentKey}"]`)
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    await waitForFast(() =>
      expect(harness.list).toHaveBeenCalledWith(
        expect.objectContaining({ spawnedBy: navigationParentKey }),
      ),
    );
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(`[data-session-key="${childKey}"]`)).toHaveLength(1),
    );
    expect(
      sessionQuery(sidebar, childKey)?.classList.contains("sidebar-recent-session--child"),
    ).toBe(true);
  });
});
