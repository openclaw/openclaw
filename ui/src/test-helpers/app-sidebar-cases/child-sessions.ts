import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
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
} from "../app-sidebar.ts";
import { createGatewayRequestMock, createTestGatewayClient } from "../gateway-client.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar agent chip", () => {
  it("loads and expands child sessions with menus but without root placement controls", async () => {
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const { gateway } = gatewayHarness;
    const harness = createSessionsHarness("main", ["agent:main:parent"]);
    harness.list.mockResolvedValue({
      ts: 100_000,
      path: "",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "agent:main:child-one",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          label: "Research sources",
          updatedAt: 2,
          status: "running",
          hasActiveRun: true,
          startedAt: 1_000,
          runtimeMs: 30_000,
        },
        {
          key: "agent:main:child-two",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          label: "Check tests",
          updatedAt: 3,
          status: "done",
          startedAt: 1_000,
          endedAt: 61_000,
        },
      ],
    });
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            label: "Plan release",
            updatedAt: 1,
            childSessions: ["agent:main:child-one", "agent:main:child-two"],
          },
        ],
      },
    });
    await sidebar.updateComplete;

    const toggle = sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]");
    expect(toggle?.textContent?.trim()).toContain("2");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar.querySelector(".sidebar-recent-session--child")).toBeNull();

    toggle?.click();
    await waitForFast(() => expect(harness.list).toHaveBeenCalledOnce());
    await waitForFast(() =>
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2),
    );

    expect(harness.list).toHaveBeenCalledWith({
      spawnedBy: "agent:main:parent",
      limit: 100,
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
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
    expect(childRows.every((row) => !row.hasAttribute("role"))).toBe(true);
    expect(childRows.every((row) => row.closest("[role=list]") === childList)).toBe(true);
    expect(childRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Research sources"),
      expect.stringContaining("Check tests"),
    ]);
    expect(childRows.every((row) => row.getAttribute("draggable") === "false")).toBe(true);
    expect(childRows.every((row) => row.querySelector("[data-session-menu]") !== null)).toBe(true);
    expect(childRows.every((row) => row.querySelector("[data-sidebar-session-pin]") === null)).toBe(
      true,
    );
    expect(childRows.every((row) => row.querySelector(".session-row-state") === null)).toBe(true);
    expect(childRows.every((row) => row.querySelector(".sidebar-session-indicator") !== null)).toBe(
      true,
    );
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

    harness.list.mockResolvedValue({
      ts: 3,
      path: "",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "agent:main:child-one",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          label: "Research sources",
          updatedAt: 4,
          status: "done",
          startedAt: 1_000,
          endedAt: 121_000,
          runtimeMs: 60_000,
        },
        {
          key: "agent:main:child-two",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          label: "Check tests",
          updatedAt: 4,
          status: "done",
          startedAt: 1_000,
          endedAt: 121_000,
          runtimeMs: 60_000,
        },
      ],
    });
    harness.publishList({
      result: {
        ts: 3,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            label: "Plan release",
            updatedAt: 4,
            childSessions: ["agent:main:child-one"],
          },
        ],
      },
    });
    await sidebar.updateComplete;
    expect(harness.list).toHaveBeenCalledOnce();
    gatewayHarness.publishEvent("sessions.changed", {
      sessionKey: "agent:main:child-one",
      agentId: "main",
      reason: "patch",
      spawnedBy: "agent:main:parent",
    });
    await waitForFast(() => expect(harness.list).toHaveBeenCalledTimes(2));
    await waitForFast(() =>
      expect(
        sidebar.querySelector('[data-session-key="agent:main:child-one"] [aria-label="Done"]'),
      ).not.toBeNull(),
    );
  });

  it("propagates loaded child workspace conflicts to a collapsed parent", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:parent"]);
    harness.list.mockResolvedValue({
      ts: 2,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "agent:worker:child",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          label: "Conflicted child",
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
        },
      ],
    });
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            label: "Parent task",
            updatedAt: 1,
            childSessions: ["agent:worker:child"],
          },
        ],
      },
    });
    await sidebar.updateComplete;

    const toggle = sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]");
    toggle?.click();
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
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:parent"]);
    const page = (key: string, hasMore: boolean): SessionsListResult => ({
      ts: 10,
      path: "",
      count: 1,
      totalCount: 2,
      hasMore,
      nextOffset: hasMore ? 100 : null,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key,
          spawnedBy: "agent:main:parent",
          kind: "direct",
          updatedAt: 1,
        },
      ],
    });
    harness.list
      .mockResolvedValueOnce(page("agent:worker:first", true))
      .mockResolvedValueOnce(page("agent:worker:second", false));
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 10,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            updatedAt: 1,
            childSessions: ["agent:worker:first", "agent:worker:second"],
          },
        ],
      },
    });
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();

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
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:parent"]);
    const page = (sessions: SessionsListResult["sessions"], hasMore: boolean) => ({
      ts: 10,
      path: "",
      count: sessions.length,
      totalCount: 2,
      hasMore,
      nextOffset: hasMore ? 100 : null,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions,
    });
    const firstChild = {
      key: "agent:worker:first",
      spawnedBy: "agent:main:parent",
      kind: "direct" as const,
      updatedAt: 1,
    };
    const secondChild = {
      key: "agent:worker:second",
      spawnedBy: "agent:main:parent",
      kind: "direct" as const,
      updatedAt: 2,
    };
    harness.list
      .mockResolvedValueOnce(page([firstChild], true))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(page([firstChild, secondChild], false));
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    const publishParent = (ts: number) =>
      harness.publishList({
        result: {
          ts,
          path: "",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [
            {
              key: "agent:main:parent",
              kind: "direct",
              updatedAt: ts,
              childSessions: [firstChild.key, secondChild.key],
            },
          ],
        },
      });
    publishParent(10);
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();

    await waitForFast(() => expect(harness.list).toHaveBeenCalledTimes(2));
    expect(sidebar.querySelector(".sidebar-recent-session--child")).toBeNull();
    await waitForFast(() =>
      expect(
        sidebar.querySelector('[data-child-session-error="agent:main:parent"]')?.textContent,
      ).toContain("The session query did not return a result. Try again."),
    );

    publishParent(11);
    await sidebar.updateComplete;
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
    original.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            updatedAt: 1,
            childSessions: ["agent:worker:child"],
          },
        ],
      },
    });
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
    await waitForFast(() => expect(original.list).toHaveBeenCalledOnce());

    const replacement = createSessionsHarness("main", ["agent:main:parent"]);
    replacement.list.mockResolvedValue({
      ts: 3,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "agent:worker:child",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          updatedAt: 2,
          label: "Replacement child",
        },
      ],
    });
    replacement.publishList({
      result: {
        ts: 3,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            updatedAt: 2,
            childSessions: ["agent:worker:child"],
          },
        ],
      },
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

  it.each(["agent:main:parent", "agent:main:main"])(
    "nests the selected categorized subagent under %s and reveals the active path",
    async (parentKey) => {
      const childKey = "agent:worker:subagent:child";
      const parent = {
        key: parentKey,
        sessionId: `session:${parentKey}`,
        kind: "direct" as const,
        label: "Parent task",
        updatedAt: 1,
        childSessions: [childKey],
      };
      const child = {
        key: childKey,
        sessionId: `session:${childKey}`,
        parentSessionKey: parentKey,
        category: "Team",
        kind: "direct" as const,
        label: "Selected child",
        updatedAt: 2,
        status: "running" as const,
      };
      const request = createGatewayRequestMock(async (method, params) => {
        const query = isRecord(params) ? params : undefined;
        if (method === "sessions.describe") {
          return { session: query?.key === parentKey ? parent : child };
        }
        if (method === "sessions.list") {
          return sessionsResult(
            query?.spawnedBy === parentKey || query?.agentId === "worker" ? [child] : [parent],
            2,
          );
        }
        return {};
      });
      const gateway = createGateway(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(gateway);
      await sessions.refresh({ agentId: "main", force: true });
      const { sidebar, context, provider } = await mountSidebar(gateway, sessions);
      try {
        context.agentSelection.set("worker");
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = "agent:worker:subagent:child";
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith("sessions.describe", {
            key: "agent:worker:subagent:child",
          }),
        );
        await waitForFast(() =>
          expect(
            sidebar.querySelectorAll('[data-session-key="agent:worker:subagent:child"]'),
          ).toHaveLength(1),
        );
        await waitForFast(() =>
          expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(2),
        );
        expect(
          sidebar.querySelectorAll('[data-session-key="agent:worker:subagent:child"]'),
        ).toHaveLength(1);
        expect(
          sidebar
            .querySelector(`[data-child-session-toggle="${parentKey}"]`)
            ?.getAttribute("aria-expanded"),
        ).toBe("true");
        expect(
          sidebar
            .querySelector('[data-session-key="agent:worker:subagent:child"]')
            ?.classList.contains("sidebar-recent-session--active"),
        ).toBe(true);
        const toggle = sidebar.querySelector<HTMLButtonElement>(
          `[data-child-session-toggle="${parentKey}"]`,
        );
        toggle?.click();
        await sidebar.updateComplete;
        expect(toggle?.getAttribute("aria-expanded")).toBe("false");
        expect(
          sidebar.querySelector('[data-session-key="agent:worker:subagent:child"]'),
        ).toBeNull();

        sidebar.sessionKey = parentKey;
        context.agentSelection.set("main");
        await waitForFast(() =>
          expect(sidebar.sessionData.activeSessionLineageSelectedRow?.key).toBe(parentKey),
        );
        sidebar.sessionKey = "agent:worker:subagent:child";
        context.agentSelection.set("worker");
        await waitForFast(() =>
          expect(
            sidebar.querySelector(
              `[data-session-tree="${parentKey}"] [data-session-key="agent:worker:subagent:child"]`,
            ),
          ).not.toBeNull(),
        );
      } finally {
        provider.remove();
        sessions.dispose();
      }
    },
  );

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
      label: "Opened subagent",
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

  it("keeps the selected archived child when its archived parent is filtered out", async () => {
    const request = vi.fn(async (_method: string, params: { key: string }) => ({
      session:
        params.key === "agent:worker:child"
          ? {
              key: "agent:worker:child",
              parentSessionKey: "agent:main:parent",
              kind: "direct" as const,
              label: "Selected child",
              archived: true,
              updatedAt: 2,
            }
          : {
              key: "agent:main:parent",
              kind: "direct" as const,
              label: "Archived parent",
              archived: true,
              updatedAt: 1,
              childSessions: ["agent:worker:child"],
            },
    }));
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient);
    const harness = createSessionsHarness("main", []);
    const { sidebar, context } = await mountSidebar(gateway, harness.sessions);
    context.agentSelection.state.selectedId = "main";
    context.agentSelection.state.scopeId = "main";
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = "agent:worker:child";

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() =>
      expect(sidebar.querySelector('[data-session-key="agent:worker:child"]')).not.toBeNull(),
    );
    expect(sidebar.querySelector('[data-session-key="agent:main:parent"]')).toBeNull();
    expect(
      sidebar.querySelector(
        '[data-session-key="agent:worker:child"] .sidebar-session__archive-glyph',
      ),
    ).not.toBeNull();
    expect(
      sidebar
        .querySelector('[data-session-key="agent:worker:child"]')
        ?.classList.contains("sidebar-recent-session--active"),
    ).toBe(true);
  });

  it("retries a failed child load after collapsing and reopening the parent", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:parent"]);
    harness.list.mockRejectedValueOnce(new Error("temporary list failure")).mockResolvedValueOnce({
      ts: 2,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "agent:worker:child",
          spawnedBy: "agent:main:parent",
          kind: "direct",
          label: "Recovered child",
          updatedAt: 2,
        },
      ],
    });
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:parent",
            kind: "direct",
            updatedAt: 1,
            childSessions: ["agent:worker:child"],
          },
        ],
      },
    });
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
    await waitForFast(() => expect(harness.list).toHaveBeenCalledOnce());
    await waitForFast(() => expect(sidebar.textContent).toContain("temporary list failure"));

    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
    await waitForFast(() => expect(harness.list).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(sidebar.textContent).toContain("Recovered child"));
  });

  it("restores a directly opened child whose parent is outside the root page", async () => {
    const request = vi.fn(async (_method: string, params: { key: string }) => ({
      session:
        params.key === "agent:worker:child"
          ? {
              key: "agent:worker:child",
              spawnedBy: "agent:main:hidden-parent",
              kind: "direct" as const,
              label: "Selected child",
              updatedAt: 3,
            }
          : {
              key: "agent:main:hidden-parent",
              kind: "direct" as const,
              label: "Hidden parent",
              updatedAt: 2,
              childSessions: ["agent:worker:child"],
            },
    }));
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:other"]);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = "agent:worker:child";

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() =>
      expect(sidebar.querySelector('[data-session-key="agent:worker:child"]')).not.toBeNull(),
    );
    expect(
      sidebar.querySelector('[data-session-key="agent:main:hidden-parent"]')?.textContent,
    ).toContain("Hidden parent");
  });
});
