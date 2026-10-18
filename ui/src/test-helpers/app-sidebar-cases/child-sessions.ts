import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import {
  createContext,
  createGateway,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import { createGatewayRequestMock, createTestGatewayClient } from "../gateway-client.ts";
import { settleLitElement } from "../lit-settle.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.tsx";

function listResult(sessions: GatewaySessionRow[], ts: number): SessionsListResult {
  return { ...sessionsResult(sessions, ts), path: "" };
}

function parentResult(children: string[], ts: number, overrides: Partial<GatewaySessionRow> = {}) {
  const parent: GatewaySessionRow = {
    key: "agent:main:parent",
    kind: "direct",
    updatedAt: 1,
    childSessions: children,
    ...overrides,
  };
  return listResult([parent], ts);
}

function childRow(key: string, overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key, spawnedBy: "agent:main:parent", kind: "direct", updatedAt: 1, ...overrides };
}
function childPage(rows: GatewaySessionRow[], hasMore: boolean): SessionsListResult {
  return { ...listResult(rows, 10), totalCount: 2, hasMore, nextOffset: hasMore ? 100 : null };
}
function parentHarness() {
  return {
    gateway: createGateway({} as GatewayBrowserClient),
    harness: createSessionsHarness("main", ["agent:main:parent"]),
  };
}
function expectExpanded(sidebar: SidebarLifecycleState) {
  expect(sidebar.querySelector("[data-child-session-toggle]")?.ariaExpanded).toBe("true");
}
const childSelector = (key: string) => `[data-session-key="${key}"]`;

describe("AppSidebar agent chip", () => {
  it("loads and expands child sessions with menus but without root placement controls", async () => {
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const { gateway } = gatewayHarness;
    const harness = createSessionsHarness("main", ["agent:main:parent"]);
    const children: GatewaySessionRow[] = [
      childRow("agent:main:child-one", {
        label: "Research sources",
        updatedAt: 2,
        status: "running",
        hasActiveRun: true,
        startedAt: 1_000,
        runtimeMs: 30_000,
      }),
      childRow("agent:main:child-two", {
        label: "Check tests",
        updatedAt: 3,
        status: "done",
        startedAt: 1_000,
        endedAt: 61_000,
      }),
    ];
    harness.list.mockResolvedValue(listResult(children, 100_000));
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: parentResult(["agent:main:child-one", "agent:main:child-two"], 2, {
        label: "Plan release",
      }),
    });
    await settleLitElement(sidebar);

    const toggle = sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]");
    expect(toggle?.textContent?.trim()).toContain("2");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    await waitForFast(() => expect(harness.list).toHaveBeenCalledOnce());
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2),
    );

    expect(harness.list).toHaveBeenCalledWith({
      rowMode: "compact",
      source: "sidebar",
      spawnedBy: "agent:main:parent",
      limit: 100,
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
      excludeDock: true,
    });
    const childRows = [...sidebar.querySelectorAll<HTMLElement>(".sidebar-recent-session--child")];
    const parentTree = sidebar.querySelector('[data-session-tree="agent:main:parent"]');
    const childList = parentTree?.querySelector(
      ":scope > .sidebar-session-tree__children [role=list]",
    );
    const childTrees = [...(childList?.children ?? [])];
    expect(childList?.getAttribute("aria-label")).toBe("Child sessions");
    expect(childTrees).toHaveLength(2);
    expect(childTrees.every((tree) => tree.getAttribute("role") === "listitem")).toBe(true);
    expect(childRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Research sources"),
      expect.stringContaining("Check tests"),
    ]);
    for (const row of childRows) {
      expect(row.closest("[role=list]")).toBe(childList);
      expect([row.getAttribute("role"), row.getAttribute("draggable")]).toEqual([null, "false"]);
      expect(row.querySelector("[data-sidebar-session-archive]")).not.toBeNull();
      expect(row.querySelector(".sidebar-session-indicator")).not.toBeNull();
      expect(row.querySelector("[data-sidebar-session-pin], .session-row-state")).toBeNull();
    }
    expect(sidebar.querySelector('[aria-label="Done"]')).not.toBeNull();
    const runtimeStartMs = (
      sidebar.querySelector('[data-session-key="agent:main:child-one"] openclaw-elapsed-time') as
        | (HTMLElement & { startMs: number })
        | null
    )?.startMs;
    const childTrail = childRows[0]?.querySelector<HTMLElement>(".session-row-trail");
    expect(childTrail?.querySelector("openclaw-elapsed-time")).not.toBeNull();
    expect(childRows[0]?.querySelector("a")?.getAttribute("aria-describedby")).toBe(childTrail?.id);
    expect(runtimeStartMs).toBeGreaterThan(Date.now() - 31_000);
    expect(runtimeStartMs).toBeLessThan(Date.now() - 29_000);

    harness.list.mockResolvedValue(
      listResult(
        children.map(({ hasActiveRun: _active, ...row }) =>
          Object.assign(row, {
            updatedAt: 4,
            status: "done" as const,
            endedAt: 121_000,
            runtimeMs: 60_000,
          }),
        ),
        3,
      ),
    );
    harness.publishList({
      result: parentResult(["agent:main:child-one"], 3, { label: "Plan release", updatedAt: 4 }),
    });
    await sidebar.updateComplete;
    expect(harness.list).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    gatewayHarness.publishEvent("sessions.changed", {
      sessionKey: "agent:main:child-one",
      agentId: "main",
      reason: "patch",
      spawnedBy: "agent:main:parent",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => expect(harness.list).toHaveBeenCalledTimes(2));
    await waitForFast(() =>
      expect(
        sidebar.querySelector('[data-session-key="agent:main:child-one"] [aria-label="Done"]'),
      ).not.toBeNull(),
    );
  });

  it("propagates loaded child workspace conflicts to a collapsed parent", async () => {
    const { gateway, harness } = parentHarness();
    harness.list.mockResolvedValue(
      listResult(
        [
          childRow("agent:worker:child", {
            updatedAt: 2,
            placement: {
              state: "reclaimed",
              generation: 1,
              createdAtMs: 1,
              updatedAtMs: 2,
              stateChangedAtMs: 2,
              workspaceResultConflict: {
                paths: ["src/local.ts", "src/other.ts"],
                stagedResultRef: "refs/openclaw/worker-results/claim-child",
              },
            },
          }),
        ],
        2,
      ),
    );
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: parentResult(["agent:worker:child"], 2, { label: "Parent task" }),
    });
    await settleLitElement(sidebar);

    const toggle = sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    await waitForFast(() => expect(harness.list).toHaveBeenCalledOnce());
    await waitForFast(() =>
      expect(sidebar.querySelector('[data-session-key="agent:worker:child"]')).not.toBeNull(),
    );

    toggle?.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-session-key="agent:worker:child"]')).toBeNull();
    const parentBadge = sidebar.querySelector<HTMLElement>(
      '[data-session-key="agent:main:parent"] .session-row-badge--cloud',
    );
    expect(parentBadge?.dataset.workspaceConflicts).toBe("2");
    expect(parentBadge?.dataset.placementState).toBeUndefined();
    expect(parentBadge?.hasAttribute("title")).toBe(false);
    expect(
      (parentBadge?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)
        ?.content,
    ).toBe("Cloud worker children: 2 workspace conflicts");
  });

  it("loads every child-session page before marking a parent complete", async () => {
    const { gateway, harness } = parentHarness();
    harness.list
      .mockResolvedValueOnce(childPage([childRow("agent:worker:first")], true))
      .mockResolvedValueOnce(childPage([childRow("agent:worker:second")], false));
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: parentResult(["agent:worker:first", "agent:worker:second"], 10),
    });
    await settleLitElement(sidebar);
    expectExpanded(sidebar);

    await waitForFast(() => expect(harness.list).toHaveBeenCalledTimes(2));
    expect(harness.list.mock.calls[1]?.[0]).toMatchObject({
      spawnedBy: "agent:main:parent",
      offset: 100,
    });
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2),
    );
  });

  it("retries an incomplete child page set only after the operator retries", async () => {
    const { gateway, harness } = parentHarness();
    const firstChild = childRow("agent:worker:first");
    const secondChild = childRow("agent:worker:second", { updatedAt: 2 });
    harness.list
      .mockResolvedValueOnce(childPage([firstChild], true))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(childPage([firstChild, secondChild], false));
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    const publishParent = (ts: number) =>
      harness.publishList({
        result: parentResult([firstChild.key, secondChild.key], ts, { updatedAt: ts }),
      });
    publishParent(10);
    await settleLitElement(sidebar);
    expectExpanded(sidebar);

    await waitForFast(() => expect(harness.list).toHaveBeenCalledTimes(2));
    expect(sidebar.querySelector(".sidebar-recent-session--child")).toBeNull();
    await waitForFast(() =>
      expect(
        sidebar.querySelector('[data-child-session-error="agent:main:parent"]')?.textContent,
      ).toContain("The session query did not return a result. Try again."),
    );

    publishParent(11);
    await settleLitElement(sidebar);
    expect(harness.list).toHaveBeenCalledTimes(2);
    expect(sidebar.querySelector('[data-child-session-error="agent:main:parent"]')).not.toBeNull();

    sidebar
      .querySelector<HTMLButtonElement>('[data-retry-child-sessions="agent:main:parent"]')
      ?.click();
    await waitForFast(() => expect(harness.list).toHaveBeenCalledTimes(3));
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2),
    );
  });

  it("ignores a rejected child request after the session capability changes", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const stale = deferred<SessionsListResult | null>();
    const original = createSessionsHarness("main", ["agent:main:parent"]);
    original.list.mockReturnValue(stale.promise);
    const { provider, sidebar } = await mountSidebar(gateway, original.sessions);
    original.publishList({ result: parentResult(["agent:worker:child"], 2) });
    await settleLitElement(sidebar);
    expectExpanded(sidebar);
    await waitForFast(() => expect(original.list).toHaveBeenCalledOnce());

    const replacement = createSessionsHarness("main", ["agent:main:parent"]);
    replacement.list.mockResolvedValue(
      listResult([childRow("agent:worker:child", { updatedAt: 2, label: "Replacement child" })], 3),
    );
    replacement.publishList({
      result: parentResult(["agent:worker:child"], 3, { updatedAt: 2 }),
    });
    provider.setContext(createContext(gateway, replacement.sessions));
    await waitForFast(() =>
      expect(sidebar.querySelector('[data-session-key="agent:worker:child"]')).not.toBeNull(),
    );

    stale.reject(new Error("old capability failed"));
    await Promise.resolve();
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-session-key="agent:worker:child"]')?.textContent).toContain(
      "Replacement child",
    );
    expect(sidebar.querySelector("[data-child-session-error]")).toBeNull();
  });

  it("nests the selected spawned session and reveals its active ancestor path through a run", async () => {
    const parentKey = "agent:main:parent";
    const runKey = "agent:worker:subagent:delegating-run";
    const childKey = "agent:worker:dashboard:child";
    const parent = {
      key: parentKey,
      sessionId: `session:${parentKey}`,
      kind: "direct" as const,
      updatedAt: 1,
      childSessions: [runKey],
    };
    const run = {
      key: runKey,
      sessionId: `session:${runKey}`,
      parentSessionKey: parentKey,
      kind: "direct" as const,
      updatedAt: 2,
      childSessions: [childKey],
    };
    const child = {
      key: childKey,
      sessionId: `session:${childKey}`,
      parentSessionKey: runKey,
      kind: "direct" as const,
      updatedAt: 2,
      status: "running" as const,
    };
    const rows: GatewaySessionRow[] = [parent, run, child];
    const request = createGatewayRequestMock(async (method, params) => {
      const query = isRecord(params) ? params : undefined;
      if (method === "sessions.describe") {
        return { session: rows.find((row) => row.key === query?.key) ?? null };
      }
      if (method === "sessions.list") {
        return sessionsResult(
          typeof query?.spawnedBy === "string"
            ? rows.filter((row) => row.parentSessionKey === query.spawnedBy)
            : query?.agentId === "worker"
              ? [child]
              : [parent],
          2,
        );
      }
      return {};
    });
    const gateway = createGateway(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const { sidebar, context, provider } = await mountSidebar(gateway, sessions);
    const row = (key: string) => sidebar.querySelector(childSelector(key));
    const toggle = () =>
      sidebar.querySelector<HTMLButtonElement>(`[data-child-session-toggle="${parentKey}"]`);
    try {
      context.agentSelection.set("worker");
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = childKey;
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("sessions.describe", { key: childKey }),
      );
      await waitForFast(() =>
        expect(sidebar.querySelectorAll(`[data-session-key="${childKey}"]`)).toHaveLength(1),
      );
      await waitForFast(() =>
        expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(2),
      );
      expect(row(runKey)).toBeNull();
      expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
      expect(row(childKey)?.classList.contains("sidebar-recent-session--active")).toBe(true);
      const collapsedToggle = toggle();
      collapsedToggle?.click();
      await sidebar.updateComplete;
      expect(collapsedToggle?.getAttribute("aria-expanded")).toBe("false");
      expect(row(childKey)).toBeNull();

      sidebar.sessionKey = parentKey;
      context.agentSelection.set("main");
      await waitForFast(() =>
        expect(sidebar.sessionData.activeSessionLineageSelectedRow?.key).toBe(parentKey),
      );
      sidebar.sessionKey = childKey;
      context.agentSelection.set("worker");
      await waitForFast(() =>
        expect(
          sidebar.querySelector(
            `[data-session-tree="${parentKey}"] [data-session-key="${childKey}"]`,
          ),
        ).not.toBeNull(),
      );
      expect(row(runKey)).toBeNull();
      expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
      const navigation = vi.fn();
      sidebar.onNavigate = navigation;
      sidebar.querySelector<HTMLAnchorElement>(`[data-session-key="${childKey}"] a`)!.click();
      expect(navigation).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ pathname: "/chat/worker/dashboard/child" }),
      );
    } finally {
      provider.remove();
      sessions.dispose();
    }
  });

  it("keeps a directly opened subagent off the root list when its parent is unavailable", async () => {
    const childKey = "agent:main:subagent:orphan";
    const parentKey = "agent:main:unavailable-parent";
    const child = {
      key: childKey,
      sessionId: `session:${childKey}`,
      parentSessionKey: parentKey,
      spawnedBy: parentKey,
      category: "Team",
      kind: "direct" as const,
      updatedAt: 1,
    };
    const request = createGatewayRequestMock(async (method, params) =>
      method === "sessions.list"
        ? sessionsResult([child], 2)
        : { session: isRecord(params) && params.key === childKey ? child : null },
    );
    const gateway = createGateway(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const { sidebar, provider } = await mountSidebar(gateway, sessions);
    try {
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = childKey;

      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("sessions.describe", { key: parentKey }),
      );
      expect(sidebar.sessionKey).toBe(childKey);
      await waitForFast(() =>
        expect(sidebar.sessionData.activeSessionLineageSelectedRow?.key).toBe(childKey),
      );
      expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();
    } finally {
      provider.remove();
      sessions.dispose();
    }
  });

  it.each([
    { archived: true, parentKey: "agent:main:parent", parentLabel: "Archived parent", roots: [] },
    {
      archived: false,
      parentKey: "agent:main:hidden-parent",
      parentLabel: "Hidden parent",
      roots: ["agent:main:other"],
    },
  ])(
    "restores the selected child with an off-page parent (archived: $archived)",
    async ({ archived, parentKey, parentLabel, roots }) => {
      const childKey = "agent:worker:child";
      const request = vi.fn(async (_method: string, params: { key: string }) => ({
        session:
          params.key === childKey
            ? {
                key: childKey,
                ...(archived ? { parentSessionKey: parentKey } : { spawnedBy: parentKey }),
                kind: "direct" as const,
                ...(archived ? { archived: true } : {}),
                updatedAt: archived ? 2 : 3,
              }
            : {
                key: parentKey,
                kind: "direct" as const,
                label: parentLabel,
                ...(archived ? { archived: true } : {}),
                updatedAt: archived ? 1 : 2,
                childSessions: [childKey],
              },
      }));
      const gateway = createGateway({ request } as unknown as GatewayBrowserClient);
      const harness = createSessionsHarness("main", roots);
      const { sidebar, context } = await mountSidebar(gateway, harness.sessions);
      if (archived) {
        context.agentSelection.state.selectedId = "main";
        context.agentSelection.state.scopeId = "main";
      }
      (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
      sidebar.sessionKey = childKey;

      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      await waitForFast(() =>
        expect(sidebar.querySelector(childSelector(childKey))).not.toBeNull(),
      );
      if (archived) {
        expect(sidebar.querySelector(childSelector(parentKey))).toBeNull();
        const child = sidebar.querySelector(childSelector(childKey));
        expect(child?.querySelector(".sidebar-session__archive-glyph")).not.toBeNull();
        expect(child?.classList.contains("sidebar-recent-session--active")).toBe(true);
      } else {
        expect(sidebar.querySelector(childSelector(parentKey))?.textContent).toContain(parentLabel);
      }
    },
  );
});
