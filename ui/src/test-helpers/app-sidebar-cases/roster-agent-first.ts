import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { rosterActivityStore } from "../../lib/agents/roster-activity-store.ts";
import "../../pages/agents-home/agents-home-page.ts";
import {
  agentIds,
  mountRoster,
  owners,
  roster,
  selectFilter,
  session,
  sessionKeys,
} from "./roster.test-support.ts";

describe("AppSidebar agent roster", () => {
  it.each(
    [false, true].flatMap((mixed) =>
      (["idle", "running", "queued", "failed"] as const).map((parentState) => ({
        mixed,
        parentState,
      })),
    ),
  )(
    "reserves one prioritized state slot for a $parentState parent and descendants (mixed=$mixed)",
    async ({ mixed, parentState }) => {
      const parent = "agent:working:parent";
      const { sidebar } = await mountRoster(roster, [
        session("working", 1, {
          key: parent,
          isMain: false,
          unread: true,
          hasActiveRun: parentState === "running" || parentState === "queued",
          lastRunError: parentState === "failed" ? "Parent failed" : undefined,
          status: parentState === "idle" ? "done" : parentState,
        }),
        session("working", 2, {
          key: "agent:working:queued-child",
          isMain: false,
          unread: true,
          spawnedBy: parent,
          status: "queued",
          hasActiveRun: true,
        }),
        ...(mixed
          ? [
              session("working", 3, {
                key: "agent:working:running-child",
                isMain: false,
                spawnedBy: parent,
                status: "running",
                hasActiveRun: true,
              }),
              session("working", 4, {
                key: "agent:working:failed-child",
                isMain: false,
                spawnedBy: parent,
                status: "failed",
                lastRunError: "Child failed",
              }),
            ]
          : []),
      ]);
      sidebar.sidebarAgentsMode = "roster";
      await vi.waitFor(() => expect(sessionKeys(sidebar)).toContain(parent));
      const row = sidebar.querySelector(`[data-session-key="${parent}"]`)!;
      const runningSelector =
        ".session-run-spinner, .session-glyph__ring:not(.session-glyph__ring--queued)";
      const needsAttention = mixed || parentState === "failed";
      expect(row.querySelectorAll(".session-glyph__ring--queued")).toHaveLength(
        !needsAttention && parentState !== "running" ? 1 : 0,
      );
      expect(row.querySelectorAll(runningSelector)).toHaveLength(
        !needsAttention && parentState === "running" ? 1 : 0,
      );
      expect(row.querySelectorAll('[aria-label="Unread"]')).toHaveLength(1);
      expect(row.querySelector('[aria-label="Unread"]')?.textContent?.trim()).toBe("2");
      expect(row.querySelectorAll('[data-session-attention="error"]')).toHaveLength(
        needsAttention ? 1 : 0,
      );
      sidebar.querySelector<HTMLButtonElement>(`[data-child-session-toggle="${parent}"]`)?.click();
      await vi.waitFor(() => expect(sessionKeys(sidebar)).toContain("agent:working:queued-child"));
      expect(row.querySelectorAll(".session-glyph__ring--queued")).toHaveLength(
        parentState === "queued" ? 1 : 0,
      );
      expect(row.querySelectorAll(runningSelector)).toHaveLength(parentState === "running" ? 1 : 0);
      expect(
        sidebar.querySelectorAll(
          '[data-session-key="agent:working:queued-child"] .session-glyph__ring--queued',
        ),
      ).toHaveLength(1);
      sidebar.querySelector<HTMLButtonElement>('[data-agent-collapse="working"]')?.click();
      await vi.waitFor(() => expect(sessionKeys(sidebar)).not.toContain(parent));
      const header = sidebar.querySelector(
        '[data-agent-group="working"] .sidebar-agent-roster__signals',
      );
      expect(header?.querySelectorAll(".session-glyph__ring--queued")).toHaveLength(
        !needsAttention && parentState !== "running" ? 1 : 0,
      );
      expect(header?.querySelectorAll(runningSelector)).toHaveLength(
        !needsAttention && parentState === "running" ? 1 : 0,
      );
      expect(header?.querySelectorAll('[data-session-attention="error"]')).toHaveLength(
        needsAttention ? 1 : 0,
      );
    },
  );

  it.each(["main", "home"])(
    "uses the agent header for canonical Home %s, not a duplicate row",
    async (mainKey) => {
      const homeKey = `agent:working:${mainKey}`;
      const childKey = "agent:working:project";
      const { sidebar, context } = await mountRoster({ ...roster, mainKey }, [
        session("working", 10, {
          key: homeKey,
          pinned: true,
          category: "Saved work",
          hasActiveRun: true,
          status: "queued",
          unread: true,
          childSessions: [childKey],
        }),
        session("working", 9, {
          key: childKey,
          isMain: false,
          spawnedBy: homeKey,
          icon: "🚀",
          unread: true,
        }),
      ]);
      const onNavigate = vi.fn();
      sidebar.onNavigate = onNavigate;
      sidebar.sessionKey = homeKey;
      sidebar.sidebarAgentsMode = "roster";
      await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
      await vi.waitFor(() => expect(sessionKeys(sidebar)).toEqual([childKey]));
      const header = sidebar.querySelector(
        '[data-agent-group="working"] .sidebar-agent-roster__header',
      )!;
      expect(header.querySelectorAll(".session-glyph__ring--queued")).toHaveLength(1);
      expect(header.querySelectorAll('[aria-label="Unread"]')).toHaveLength(1);
      const link = header.querySelector<HTMLAnchorElement>('[data-agent-id="working"]')!;
      link.click();
      await vi.waitFor(() => expect(context.agentSelection.state.selectedId).toBe("working"));
      expect(onNavigate).toHaveBeenLastCalledWith(
        "chat",
        expect.objectContaining({ pathname: "/chat/working" }),
      );
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = homeKey;
      await vi.waitFor(() => expect(link.getAttribute("aria-current")).toBe("page"));
      sidebar.querySelector<HTMLButtonElement>('[data-agent-collapse="working"]')!.click();
      await vi.waitFor(() => expect(sessionKeys(sidebar)).toEqual([]));
      expect(header.querySelectorAll(".session-glyph__ring--queued")).toHaveLength(1);
      expect(header.querySelectorAll('[aria-label="Unread"]')).toHaveLength(1);
      expect(header.querySelector('[aria-label="Unread"]')?.textContent?.trim()).toBe("2");
      expect(link.getAttribute("aria-current")).toBe("page");
    },
  );

  it.each(
    (["chip", "roster"] as const).flatMap((mode) =>
      [false, true].map((viaRun) => ({ mode, viaRun })),
    ),
  )(
    "loads Home descendants and exposes their retry ($mode, hidden run=$viaRun)",
    async ({ mode, viaRun }) => {
      const agentId = mode === "chip" ? "main" : "working";
      const homeKey = `agent:${agentId}:main`;
      const runKey = `agent:${agentId}:subagent:bridge`;
      const childKey = `agent:${agentId}:project`;
      const parentKey = viaRun ? runKey : homeKey;
      const { sidebar, sessions, result } = await mountRoster(roster, []);
      let failed = false;
      sessions.list.mockImplementation(async (options) => {
        if (viaRun && options?.spawnedBy === homeKey) {
          return {
            ...result,
            count: 1,
            sessions: [
              session(agentId, 9, {
                key: runKey,
                isMain: false,
                spawnedBy: homeKey,
                childSessions: [childKey],
              }),
            ],
          };
        }
        if (options?.spawnedBy === parentKey) {
          if (!failed) {
            failed = true;
            throw new Error("Could not load conversations");
          }
          return {
            ...result,
            count: 1,
            sessions: [
              session(agentId, 8, {
                key: childKey,
                isMain: false,
                spawnedBy: parentKey,
              }),
            ],
          };
        }
        return result;
      });
      result.sessions = [session(agentId, 10, { childSessions: [viaRun ? runKey : childKey] })];
      result.count = 1;
      sessions.publish({ result });
      sidebar.sidebarAgentsMode = mode;
      await vi.waitFor(() =>
        expect(sidebar.querySelector(`[data-retry-child-sessions="${parentKey}"]`)).not.toBeNull(),
      );
      sidebar
        .querySelector<HTMLButtonElement>(`[data-retry-child-sessions="${parentKey}"]`)!
        .click();
      await vi.waitFor(() => expect(sessionKeys(sidebar)).toEqual([childKey]));
      expect(sidebar.querySelector("[data-child-session-error]")).toBeNull();
      expect(sidebar.querySelector(`[data-session-key="${homeKey}"]`)).toBeNull();
    },
  );

  it.each([undefined, "Saved work"])(
    "does not promote stale chip-mode child caches into the shared window (category=%s)",
    async (category) => {
      const mainKey = "agent:main:main";
      const childKey = "agent:main:old-child";
      const { sidebar, result } = await mountRoster(
        roster,
        [session("main", 1, { childSessions: [childKey] })],
        undefined,
        [],
        [],
        [
          session("main", 2, {
            key: childKey,
            isMain: false,
            spawnedBy: mainKey,
            category,
            label: "Previously loaded child",
          }),
        ],
      );
      await vi.waitFor(() => expect(sessionKeys(sidebar)).toContain(childKey));
      result.sessions = [session("main", 100, { key: "agent:main:current-window", isMain: false })];
      result.count = 1;
      sidebar.sidebarAgentsMode = "roster";
      await vi.waitFor(() => expect(sessionKeys(sidebar)).toContain("agent:main:current-window"));
      expect(sessionKeys(sidebar)).not.toContain(childKey);
    },
  );

  it("keeps coding, PR, owner, privacy, automation and draft facts beside independent run state", async () => {
    const key = (id: string) => `agent:working:${id}`;
    const { sidebar, sessions } = await mountRoster(roster, [
      session("working", 10, {
        key: key("coding"),
        isMain: false,
        execNode: "test-device",
        label: "Coding",
        icon: "🔧",
      }),
      session("working", 9, { key: key("open"), isMain: false, label: "Open PR" }),
      session("working", 8, { key: key("merged"), isMain: false, label: "Merged PR" }),
      session("working", 7, {
        key: key("private"),
        isMain: false,
        incognito: true,
        owner: { actor: owners[0] },
        status: "failed",
        lastRunError: "Task failed",
        endedAt: 7,
      }),
      session("working", 6, {
        key: key("queued"),
        isMain: false,
        hasActiveRun: true,
        status: "queued",
        visibility: "draft",
      }),
      session("working", 5, { key: key("automation"), isMain: false, hasAutomation: true }),
      session("working", 4, {
        key: key("fork"),
        isMain: false,
        label: "A fork",
        forkSource: { sessionKey: key("source"), sessionId: "source-session" },
      }),
      session("working", 3, {
        key: key("archived"),
        isMain: false,
        label: "Archived task",
        archived: true,
      }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    sidebar.hasSessionDraft = (sessionKey) => sessionKey === key("automation");
    sessions.sessions.setPullRequestSummary(key("open"), { numbers: [101], state: "open" });
    sessions.sessions.setPullRequestSummary(key("merged"), { numbers: [102], state: "merged" });
    await vi.waitFor(() => expect(sessionKeys(sidebar)).toHaveLength(7));
    const row = (id: string) => sidebar.querySelector(`[data-session-key="${key(id)}"]`)!;
    const codingLink = row("coding").querySelector(".sidebar-recent-session__link")!;
    expect(codingLink.firstElementChild?.classList.contains("sidebar-session-indicator")).toBe(
      true,
    );
    expect(codingLink.firstElementChild?.textContent).toContain("🔧");
    expect(
      row("coding").querySelector(
        ".sidebar-recent-session__details-endcap .sidebar-session-indicator",
      ),
    ).toBeNull();
    expect(row("coding").querySelector('.session-row-badge[aria-label="Coding"]')).not.toBeNull();
    expect(row("open").querySelector('[data-pull-request-state="open"]')).not.toBeNull();
    expect(row("merged").querySelector('[data-pull-request-state="merged"]')).not.toBeNull();
    expect(row("private").querySelector(".session-row-badge--incognito")).not.toBeNull();
    expect(row("private").querySelector(".session-owner-chip")).not.toBeNull();
    expect(
      row("private").querySelector('.sidebar-session-team-state [data-session-attention="error"]'),
    ).not.toBeNull();
    expect(row("queued").querySelector(".session-row-draft-indicator")).not.toBeNull();
    expect(row("queued").querySelectorAll(".session-glyph__ring--queued")).toHaveLength(1);
    expect(
      row("automation").querySelector('.session-row-badge[aria-label="Automations"]'),
    ).not.toBeNull();
    expect(row("automation").querySelector(".session-row-badge--draft")).not.toBeNull();
    expect(
      row("fork").querySelector(".sidebar-recent-session__name .sidebar-session-fork-indicator"),
    ).toBeNull();
    expect(
      row("fork")
        .querySelector(".sidebar-recent-session__details-endcap .sidebar-session-fork-indicator")
        ?.hasAttribute("aria-hidden"),
    ).toBe(false);
    await selectFilter(sidebar, "status:all");
    await vi.waitFor(() => expect(sessionKeys(sidebar)).toContain(key("archived")));
    expect(
      row("archived").querySelector(
        ".sidebar-recent-session__name .sidebar-session__archive-glyph",
      ),
    ).toBeNull();
    expect(
      row("archived").querySelector(
        ".sidebar-recent-session__details-endcap .sidebar-session__archive-glyph",
      ),
    ).not.toBeNull();
  });

  it("keeps Home activity on the agent header outside the shared window", async () => {
    const mainKey = "agent:working:main";
    const { sidebar, context } = await mountRoster(roster, [], undefined, [
      session("working", 10, { key: mainKey, hasActiveRun: true, status: "running", unread: true }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = mainKey;
    context.agentSelection.set("working");
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    await vi.waitFor(() =>
      expect(
        sidebar.querySelector(
          '[data-agent-group="working"] .sidebar-agent-roster__signals .sidebar-session-team-state .session-glyph__ring',
        ),
      ).not.toBeNull(),
    );
    expect(
      sidebar.querySelector(
        '[data-agent-group="working"] .sidebar-agent-roster__signals .sidebar-session-team-state [aria-label="Unread"]',
      ),
    ).not.toBeNull();
    expect(sidebar.querySelector(`[data-session-key="${mainKey}"]`)).toBeNull();
    expect(sidebar.querySelector('[data-agent-id="working"]')?.getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("does not reinsert a main row rejected by the normal session visibility filter", async () => {
    const { sidebar } = await mountRoster(roster, [session("working", 10, { kind: "unknown" })]);
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    expect(sessionKeys(sidebar)).toEqual([]);
  });

  it.each(
    ["global", "GLOBAL"].flatMap((homeKey) => [false, true].map((viaRun) => ({ homeKey, viaRun }))),
  )(
    "represents global Home $homeKey and preserves children behind a run=$viaRun",
    async ({ homeKey, viaRun }) => {
      const childKey = "agent:main:project";
      const runKey = "agent:main:subagent:bridge";
      const { sidebar } = await mountRoster(
        { ...roster, scope: "global", agents: [{ id: "main", name: "Harbor" }] },
        [
          {
            key: homeKey,
            childSessions: [viaRun ? runKey : childKey],
            kind: "global",
            label: "Shared conversation",
            hasActiveRun: true,
            status: "running",
          },
          ...(viaRun
            ? [
                session("main", 2, {
                  key: runKey,
                  isMain: false,
                  spawnedBy: homeKey,
                  childSessions: [childKey],
                }),
              ]
            : []),
          session("main", 1, {
            key: childKey,
            isMain: false,
            spawnedBy: viaRun ? runKey : homeKey,
            placement: {
              state: "reclaimed",
              generation: 1,
              createdAtMs: 1,
              updatedAtMs: 1,
              stateChangedAtMs: 1,
              workspaceResultConflict: {
                paths: ["ui/layout.css"],
                totalCount: 1,
                stagedResultRef: "refs/openclaw/worker-results/test",
              },
            },
          }),
        ],
      );
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = homeKey;
      sidebar.sidebarAgentsMode = "roster";
      await vi.waitFor(() => expect(agentIds(sidebar)).toEqual(["main"]));
      await vi.waitFor(() => expect(sessionKeys(sidebar)).toEqual([childKey]));
      expect(
        sidebar.querySelector(
          '[data-agent-group="main"] .sidebar-agent-roster__signals .session-glyph__ring',
        ),
      ).not.toBeNull();
      expect(sidebar.querySelector('[data-agent-id="main"]')?.getAttribute("aria-current")).toBe(
        "page",
      );
    },
  );

  it("starts Online collapsed in team mode and keeps it expandable", async () => {
    const { sidebar, gatewayHarness } = await mountRoster();
    sidebar.sidebarAgentsMode = "roster";
    gatewayHarness.publishEvent("presence", {
      presence: [
        {
          instanceId: "viewer-tab",
          user: { id: "viewer", identity: { type: "profile", id: "viewer" }, name: "Viewer" },
        },
      ],
    });
    await vi.waitFor(() =>
      expect(sidebar.querySelector('.sidebar-online button[aria-label="Online"]')).not.toBeNull(),
    );
    const toggle = sidebar.querySelector<HTMLButtonElement>(
      '.sidebar-online button[aria-label="Online"]',
    )!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar.querySelector(".sidebar-online__list")).toBeNull();
    toggle.click();
    await sidebar.updateComplete;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(sidebar.querySelector('[data-online-user-id="viewer"]')).not.toBeNull();
    toggle.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-online__list")).toBeNull();
  });

  it("suspends all mounted sidebar consumers while hidden, retaining a visible Agents home", async () => {
    const { sidebar, context, provider, request } = await mountRoster();
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    await vi.waitFor(() =>
      expect(sidebar.querySelectorAll("openclaw-sidebar-new-session-menu")).toHaveLength(1),
    );
    const store = rosterActivityStore(context);
    await vi.waitFor(() => expect(store.snapshot.loading).toBe(false));
    const listCount = () =>
      request.mock.calls.filter(([method]) => method === "sessions.list").length;
    const initial = listCount();
    sidebar.navigationVisible = false;
    await vi.waitFor(() => expect(store.snapshot.result).toBeNull());
    expect(sidebar.querySelector("openclaw-sidebar-agent-roster")?.isConnected).toBe(true);
    await store.refresh();
    expect(listCount()).toBe(initial);
    const home = document.createElement("openclaw-agents-home-page");
    provider.append(home);
    await vi.waitFor(() => expect(store.snapshot.result).not.toBeNull());
    await vi.waitFor(() => expect(store.snapshot.loading).toBe(false));
    expect(listCount()).toBe(initial + 1);
    sidebar.navigationVisible = true;
    await sidebar.updateComplete;
    await vi.waitFor(() => expect(agentIds(sidebar)).toHaveLength(3));
    expect(listCount()).toBe(initial + 1);
    home.remove();
    expect(store.snapshot.result).not.toBeNull();
    sidebar.navigationVisible = false;
    await vi.waitFor(() => expect(store.snapshot.result).toBeNull());
    sidebar.navigationVisible = true;
    await vi.waitFor(() => expect(store.snapshot.result).not.toBeNull());
    expect(listCount()).toBe(initial + 2);
  });

  it.each([false, true])(
    "keeps descendant conflicts separate from the parent state (running=%s)",
    async (running) => {
      const parent = "agent:working:parent";
      const branch = "agent:working:branch";
      const key = (name: string) => `agent:working:${name}`;
      const rows: GatewaySessionRow[] = [
        session("working", 20, {
          key: parent,
          isMain: false,
          label: "Coordinate implementation",
          hasActiveRun: running,
        }),
        session("working", 19, {
          key: branch,
          isMain: false,
          spawnedBy: parent,
          label: "Regression checks",
        }),
        ...(["done", "killed", "failed", "timeout"] as const).map((status, index) =>
          session("working", 18 - index, {
            key: key(status),
            isMain: false,
            spawnedBy: branch,
            status,
            label: status,
            endedAt: 15,
            lastRunError: status === "failed" ? "Check failed" : undefined,
          }),
        ),
        session("working", 12, {
          key: key("running"),
          isMain: false,
          spawnedBy: branch,
          hasActiveRun: true,
          status: "running",
          unread: true,
          label: "Continue verification",
          startedAt: Date.now() - 3_000,
        }),
        session("working", 11, {
          key: key("approve"),
          isMain: false,
          spawnedBy: parent,
          label: "Await permission",
        }),
        session("working", 10, {
          key: key("question"),
          isMain: false,
          spawnedBy: parent,
          label: "Choose next step",
        }),
        session("working", 9, {
          key: key("conflict"),
          isMain: false,
          spawnedBy: branch,
          label: "Reconcile workspace",
          placement: {
            state: "reclaimed",
            generation: 1,
            createdAtMs: 1,
            updatedAtMs: 9,
            stateChangedAtMs: 9,
            workspaceResultConflict: {
              paths: ["ui/layout.css"],
              totalCount: 1,
              stagedResultRef: "refs/openclaw/worker-results/test",
            },
          },
        }),
      ];
      const { sidebar, gatewayHarness } = await mountRoster(
        roster,
        rows,
        undefined,
        [],
        [
          {
            id: "approval-stress",
            kind: "exec",
            request: { command: "git status", sessionKey: key("approve") },
            createdAtMs: Date.now(),
            expiresAtMs: Date.now() + 60_000,
          },
        ],
      );
      sidebar.sidebarAgentsMode = "roster";
      await vi.waitFor(() => expect(sessionKeys(sidebar)).toContain(parent));
      gatewayHarness.publishEvent("question.requested", {
        id: "question-stress",
        agentId: "working",
        sessionKey: key("question"),
        questions: [{ questionId: "next", header: "Next", question: "Continue?", options: [] }],
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        status: "pending",
      });
      const row = (name: string) => sidebar.querySelector(`[data-session-key="${name}"]`);
      await vi.waitFor(() => {
        expect(row(parent)?.querySelector('[data-session-attention="approval"]')).not.toBeNull();
        expect(
          row(parent)?.querySelectorAll(
            ".sidebar-session-team-state__status [data-session-attention]",
          ),
        ).toHaveLength(1);
        expect(
          row(parent)?.querySelector('.sidebar-session-team-state [aria-label="Unread"]'),
        ).not.toBeNull();
        expect(row(parent)?.querySelector('[data-workspace-conflicts="1"]')).not.toBeNull();
      });
      expect(
        row(parent)?.querySelector(".sidebar-session-team-state .session-glyph__ring"),
      ).toBeNull();
      expect(row(parent)?.querySelector(".sidebar-child-session-toggle__count")?.textContent).toBe(
        "3",
      );
      sidebar.querySelector<HTMLButtonElement>(`[data-child-session-toggle="${parent}"]`)?.click();
      await vi.waitFor(() => expect(row(branch)).not.toBeNull());
      expect(
        row(parent)?.querySelectorAll(".sidebar-session-team-state__status .session-glyph__ring"),
      ).toHaveLength(running ? 1 : 0);
      expect(row(parent)?.querySelector(".sidebar-session-team-state__status svg")).toBeNull();
      sidebar.querySelector<HTMLButtonElement>(`[data-child-session-toggle="${branch}"]`)?.click();
      await vi.waitFor(() => expect(row(key("running"))).not.toBeNull());
      for (const status of ["done", "killed", "failed", "timeout"]) {
        expect(
          row(key(status))?.querySelector(
            status === "done" || status === "killed"
              ? `.sidebar-child-session__status--${status}`
              : '[data-session-attention="error"]',
          ),
        ).not.toBeNull();
      }
      expect(
        row(key("running"))?.querySelector(".sidebar-session-team-state .session-glyph__ring"),
      ).not.toBeNull();
      expect(row(key("running"))?.querySelectorAll('[aria-label="Unread"]')).toHaveLength(1);
      expect(
        row(key("running"))?.querySelector(".session-row-trail openclaw-elapsed-time"),
      ).not.toBeNull();
      expect(
        row(key("approve"))?.querySelectorAll('[data-session-attention="approval"]'),
      ).toHaveLength(1);
      expect(row(key("approve"))?.querySelector(".session-row-badge--approval")).toBeNull();
      sidebar.querySelector<HTMLButtonElement>('[data-agent-collapse="working"]')?.click();
      await vi.waitFor(() => expect(row(parent)).toBeNull());
      const header = sidebar.querySelector(
        '[data-agent-group="working"] .sidebar-agent-roster__header',
      );
      expect(header?.querySelector('[data-session-attention="approval"]')).not.toBeNull();
      expect(header?.querySelectorAll("[data-session-attention]")).toHaveLength(1);
      expect(header?.querySelector(".session-glyph__ring")).toBeNull();
      expect(header?.querySelector('[aria-label="Unread"]')).not.toBeNull();
    },
  );
});
