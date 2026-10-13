import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { activateSessionMenuValue } from "../app-sidebar-menu.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import { settleLitElement } from "../lit-settle.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

async function selectOwner(sidebar: SidebarLifecycleState, ownerId: string, involvingMe = false) {
  await activateSessionMenuValue(sidebar, involvingMe ? "involving-me" : `owner:${ownerId}`);
  await waitForFast(() => expect(sidebar.sessionData.sessionsLoading).toBe(false));
  await sidebar.updateComplete;
}

describe("AppSidebar session ownership filtering", () => {
  it("filters by effective owner and hides custom groups without matching sessions", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:ada",
      "agent:main:bob",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const ada = result.sessions.find((row) => row.key.endsWith(":ada"));
    const bob = result.sessions.find((row) => row.key.endsWith(":bob"));
    if (!ada || !bob) {
      throw new Error("expected owner rows");
    }
    ada.createdActor = { type: "human", id: "profile-bob", label: "Bob" };
    ada.owner = {
      actor: { type: "human", id: "profile-ada", label: "Ada" },
      assignedBy: { type: "human", id: "profile-bob", label: "Bob" },
      assignedAt: 10,
    };
    ada.category = "Research";
    bob.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    bob.owner = {
      actor: { type: "human", id: "profile-bob", label: "Bob" },
      assignedBy: { type: "human", id: "profile-ada", label: "Ada" },
      assignedAt: 11,
    };
    bob.category = "Operations";
    result.owners = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
    ];
    harness.publish({ groups: ["Research", "Operations"] });
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    expect(sidebar.querySelectorAll("openclaw-session-owner-chip")).toHaveLength(2);
    await selectOwner(sidebar, "profile-ada");

    expect(sidebar.querySelector('[data-session-key="agent:main:ada"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:bob"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-section="category:Research"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-section="category:Operations"]')).toBeNull();
    expect(
      sidebar.querySelector(".sidebar-session-toolbar .sidebar-session-sort--filtered"),
    ).toBeNull();

    await activateSessionMenuValue(sidebar, "empty-groups:never");
    await sidebar.updateComplete;
    // The explicit display choice restores the heading, never filtered-out sessions.
    expect(sidebar.querySelector('[data-session-section="category:Operations"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:bob"]')).toBeNull();
    await selectOwner(sidebar, "");
    await selectOwner(sidebar, "profile-ada");
    expect(sidebar.querySelector('[data-session-section="category:Operations"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:bob"]')).toBeNull();
  });

  it.each([
    { grouping: "project", filter: "mine" },
    { grouping: "none", filter: "involving-me" },
  ] as const)(
    "hides zero-match $grouping sections for $filter without changing Everyone or populated groups",
    async ({ grouping, filter }) => {
      const gateway = createGatewayHarness({} as GatewayBrowserClient);
      gateway.publish({ selfUser: { id: "profile-ada", name: "Ada" } });
      const harness = createSessionsHarness("main", ["agent:main:match", "agent:main:other"]);
      const result = harness.sessions.state.result!;
      const [match, other] = result.sessions;
      if (!match || !other) {
        throw new Error("expected matching and nonmatching sessions");
      }
      const ada = {
        type: "human" as const,
        id: "profile-ada",
        label: "Ada",
        identity: { type: "profile" as const, id: "profile-ada" },
      };
      const bob = {
        type: "human" as const,
        id: "profile-bob",
        label: "Bob",
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
      const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
      Object.assign(sidebar, { sessionsGrouping: grouping });
      await sidebar.updateComplete;
      const sectionIds = () =>
        [...sidebar.querySelectorAll<HTMLElement>("[data-session-section]")].map(
          (section) => section.dataset.sessionSection,
        );
      const everyoneSections = sectionIds();
      await selectOwner(sidebar, "profile-ada", filter === "involving-me");
      expect(harness.list).toHaveBeenCalledWith(
        expect.objectContaining(
          filter === "mine" ? { ownerId: "profile-ada" } : { involvingMe: true },
        ),
      );
      const matchingSection = grouping === "project" ? "project:/repos/research" : "ungrouped";
      expect(sectionIds()).toEqual([matchingSection]);
      expect(sidebar.querySelector('[data-session-key="agent:main:match"]')).not.toBeNull();
      expect(sidebar.querySelector('[data-session-key="agent:main:other"]')).toBeNull();
      if (grouping !== "none") {
        sidebar.sessionOrganizer.saveCollapsedSessionSections(new Set([matchingSection]));
        await sidebar.updateComplete;
        expect(sectionIds()).toEqual([matchingSection]);
        expect(sidebar.querySelector(".sidebar-session-group-count")?.textContent).toBe("1");
        expect(sidebar.querySelector('[data-session-key="agent:main:match"]')).toBeNull();
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
    const gateway = createGateway({} as GatewayBrowserClient);
    const backingSessionKey = "agent:main:claude-bound";
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:ada",
      backingSessionKey,
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const ada = result.sessions.find((row) => row.key.endsWith(":ada"));
    const adopted = result.sessions.find((row) => row.key === backingSessionKey);
    if (!ada || !adopted) {
      throw new Error("expected ownership rows");
    }
    ada.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    adopted.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    adopted.owner = {
      actor: { type: "human", id: "profile-bob", label: "Bob" },
      assignedBy: { type: "human", id: "profile-ada", label: "Ada" },
      assignedAt: 10,
    };
    result.owners = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
    ];

    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    sidebar.sessionData.sessionCatalogs = [
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
            sessions: [
              {
                threadId: "claude-thread",
                name: "Claude session",
                status: "stored",
                archived: false,
                sessionKey: backingSessionKey,
                createdActor: { type: "human", id: "profile-ada", label: "Ada" },
                canContinue: true,
                canArchive: false,
              },
              {
                threadId: "external-thread",
                name: "External unowned session",
                status: "stored",
                archived: false,
                canContinue: true,
                canArchive: false,
              },
            ],
          },
        ],
      },
    ];
    sidebar.sessionData.requestSessionDataUpdate();
    harness.publishList({ result, agentId: "main" });
    await settleLitElement(sidebar);

    expect(sidebar.querySelector(`[data-session-key="${backingSessionKey}"]`)).not.toBeNull();
    expect(sidebar.textContent).toContain("External unowned session");
    await selectOwner(sidebar, "profile-bob");

    expect(sidebar.querySelector(`[data-session-key="${backingSessionKey}"]`)).not.toBeNull();
    expect(sidebar.textContent).not.toContain("External unowned session");

    harness.publishList({
      result: { ...result, count: 1, sessions: [ada] },
      agentId: "main",
    });
    await sidebar.sessionData.refreshSidebarSessions();
    await settleLitElement(sidebar);
    expect(sidebar.querySelector(`[data-session-key="${backingSessionKey}"]`)).toBeNull();
    expect(sidebar.textContent).not.toContain("External unowned session");
  });

  it("keeps catalog rows whose backing ownership is outside the loaded page", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:ada",
      "agent:main:bob",
    ]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const ada = result.sessions.find((row) => row.key.endsWith(":ada"));
    const bob = result.sessions.find((row) => row.key.endsWith(":bob"));
    if (!ada || !bob) {
      throw new Error("expected owner rows");
    }
    ada.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    bob.createdActor = { type: "human", id: "profile-bob", label: "Bob" };
    result.owners = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
    ];

    const unloadedSessionKey = "agent:main:beyond-loaded-page";
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    sidebar.sessionData.sessionCatalogs = [
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
            sessions: [
              {
                threadId: "unloaded-thread",
                name: "Unloaded backing session",
                status: "stored",
                archived: false,
                sessionKey: unloadedSessionKey,
                createdActor: { type: "human", id: "profile-ada", label: "Ada" },
                canContinue: true,
                canArchive: false,
              },
            ],
          },
        ],
      },
    ];
    sidebar.sessionData.requestSessionDataUpdate();
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    await selectOwner(sidebar, "profile-ada");
    expect(sidebar.querySelector(`[data-session-key="${unloadedSessionKey}"]`)).not.toBeNull();
  });

  it("badges the owner avatar and announces unread once", async () => {
    const key = "agent:main:unread";
    const harness = createSessionsHarness("main", ["agent:main:main", key, "agent:main:other"]);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    const unread = result.sessions.find((row) => row.key === key);
    const other = result.sessions.find((row) => row.key.endsWith(":other"));
    if (!unread || !other) {
      throw new Error("expected ownership rows");
    }
    unread.createdActor = { type: "human", id: "profile-ada", label: "Ada" };
    unread.owner = { actor: unread.createdActor };
    unread.unread = true;
    other.createdActor = { type: "human", id: "profile-bob", label: "Bob" };
    other.owner = { actor: other.createdActor };
    result.owners = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
    ];

    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      harness.sessions,
    );
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    const row = sidebar.querySelector(`[data-session-key="${key}"]`);
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
});
