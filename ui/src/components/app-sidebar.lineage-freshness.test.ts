/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult, SessionsPatchResult } from "../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createGateway,
  createGatewayHarness,
  deferred,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./app-sidebar.ts";

describe("sidebar routed-lineage freshness", () => {
  it.each(["main child", "ordinary root"] as const)(
    "hides a selected active %s in Archived after fresh lineage completes",
    async (kind) => {
      const mainKey = "agent:main:main";
      const selected: GatewaySessionRow = {
        key: "agent:main:selected-active",
        sessionId: "selected-active-session",
        agentId: "main",
        kind: "direct",
        label: "Selected active session",
        archived: false,
        updatedAt: 10,
        ...(kind === "main child" ? { spawnedBy: mainKey } : {}),
      };
      const parent: GatewaySessionRow = {
        key: mainKey,
        sessionId: "main-parent-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        updatedAt: 10,
        childSessions: [selected.key],
      };
      const initialParent = deferred<{ session: GatewaySessionRow }>();
      const freshSelected = deferred<{ session: GatewaySessionRow }>();
      const freshParent = deferred<{ session: GatewaySessionRow }>();
      let filterChanged = false;
      const request = vi.fn(async (method, raw) => {
        const params = raw && typeof raw === "object" ? raw : {};
        if (method === "sessions.list") {
          return sessionsResult(
            "archived" in params && params.archived === true ? [] : [selected],
            10,
          );
        }
        if (method === "sessions.describe") {
          const key = "key" in params ? params.key : undefined;
          if (key === selected.key) {
            return freshSelected.promise;
          }
          if (key === mainKey) {
            return filterChanged ? freshParent.promise : initialParent.promise;
          }
          throw new Error(`Unexpected describe key: ${String(key)}`);
        }
        return {};
      });
      const gateway = createGateway(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(gateway);
      await sessions.refresh({ agentId: "main", force: true });
      const { sidebar, provider } = await mountSidebar(gateway, sessions, "panel", {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      });
      const row = () => sidebar.querySelector(`[data-session-key="${selected.key}"]`);
      try {
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = selected.key;
        if (kind === "main child") {
          // Keep the original ancestry pending so the filter starts a fresh lookup.
          await waitForFast(() =>
            expect(request).toHaveBeenCalledWith("sessions.describe", { key: mainKey }),
          );
        } else {
          await waitForFast(() =>
            expect(sidebar.sessionData.activeSessionLineageRoot?.key).toBe(selected.key),
          );
        }
        await waitForFast(() => expect(row()).not.toBeNull());

        filterChanged = true;
        sidebar.sessionOrganizer.setSessionsStatusFilter("archived");
        expect(sidebar.sessionData.childSessionRowsByParent).toEqual({});
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith(
            "sessions.list",
            expect.objectContaining({ archived: true }),
          ),
        );
        await waitForFast(() => expect(sidebar.sessionData.sessionsResult?.sessions).toEqual([]));
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith("sessions.describe", { key: selected.key }),
        );
        await sidebar.updateComplete;
        expect(row()).toBeNull();

        freshSelected.resolve({ session: selected });
        if (kind === "main child") {
          await waitForFast(() =>
            expect(
              request.mock.calls.filter(
                ([method, params]) => method === "sessions.describe" && params?.key === mainKey,
              ),
            ).toHaveLength(2),
          );
          freshParent.resolve({ session: parent });
        }
        await waitForFast(() =>
          expect(sidebar.sessionData.activeSessionLineageRoot?.key).toBe(
            kind === "main child" ? mainKey : selected.key,
          ),
        );
        await sidebar.updateComplete;
        expect(sidebar.sessionKey).toBe(selected.key);
        expect(sidebar.activeRouteId).toBe("chat");
        expect(sidebar.sessionData.activeSessionLineageSelectedRow?.key).toBe(selected.key);
        expect(sidebar.sessionData.sessionsResult?.sessions).toEqual([]);
        expect(row()).toBeNull();
      } finally {
        provider.remove();
        sessions.dispose();
        initialParent.resolve({ session: parent });
        freshSelected.resolve({ session: selected });
        freshParent.resolve({ session: parent });
        await sidebar.updateComplete;
      }
    },
  );

  it("retains a listed route across canonical omission while its cold parent lookup is pending", async () => {
    const key = "agent:main:cold-child";
    const parentKey = "agent:main:cold-parent";
    const child = {
      key,
      sessionId: "cold-child-session",
      kind: "direct" as const,
      spawnedBy: parentKey,
      label: "Listed route",
      updatedAt: 2,
    };
    const parent = {
      key: parentKey,
      sessionId: "cold-parent-session",
      kind: "direct" as const,
      updatedAt: 1,
    };
    const parentRead = deferred<{ session: typeof parent }>();
    const childRead = deferred<{ session: typeof child }>();
    let rows: SessionsListResult["sessions"] = [child];
    const request = vi.fn(async (method, params) => {
      if (method === "sessions.list") {
        return sessionsResult(rows, 3);
      }
      if (method === "sessions.describe") {
        return (params as { key: string }).key === parentKey
          ? parentRead.promise
          : childRead.promise;
      }
      return {};
    });
    const gateway = createGateway(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const { sidebar, provider } = await mountSidebar(gateway, sessions);
    try {
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = key;
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("sessions.describe", { key: parentKey }),
      );
      expect(sidebar.querySelector(`[data-session-key="${key}"]`)?.textContent).toContain(
        "Listed route",
      );
      rows = [];
      await sessions.refresh({ agentId: "main", force: true });
      await sidebar.updateComplete;
      expect(
        sidebar
          .querySelector(`[data-session-key="${key}"]`)
          ?.textContent?.replace(/\s+/g, " ")
          .trim(),
      ).toContain("Listed route");
    } finally {
      provider.remove();
      sessions.dispose();
      parentRead.resolve({ session: parent });
      childRead.resolve({ session: child });
      await Promise.all([parentRead.promise, childRead.promise]);
      await sidebar.updateComplete;
    }
  });

  it.each(
    [3, 4, null].flatMap((updatedAt) =>
      (["child list", "lineage"] as const).map((first) => ({ first, updatedAt })),
    ),
  )(
    "keeps the fresh selected child when $first finishes first (updatedAt: $updatedAt)",
    async ({ first, updatedAt }) => {
      const parentKey = "agent:main:parent";
      const key = "agent:main:child";
      const siblingKey = "agent:main:sibling";
      const parent = {
        key: parentKey,
        sessionId: "selected-parent-session",
        kind: "direct" as const,
        updatedAt: 1,
        childSessions: [key, siblingKey],
      };
      const stale = {
        key,
        sessionId: "selected-child-session",
        spawnedBy: parentKey,
        kind: "direct" as const,
        label: "Stale selected child",
        updatedAt,
        status: updatedAt === 3 ? ("running" as const) : ("done" as const),
      };
      const fresh = {
        ...stale,
        updatedAt: updatedAt === 3 ? 4 : updatedAt,
        label: "Selected child",
        status: "done" as const,
      };
      const sibling = {
        ...fresh,
        key: siblingKey,
        sessionId: "sibling-session",
        label: "Loaded sibling",
      };
      const described = deferred<{ session: typeof stale }>();
      const listed = deferred<SessionsListResult>();
      const request = vi.fn(async (method, params) => {
        if (method === "sessions.list") {
          return (params as { spawnedBy?: string }).spawnedBy === parentKey
            ? listed.promise
            : sessionsResult([parent], 2);
        }
        return method === "sessions.describe" ? described.promise : {};
      });
      const gateway = createGateway(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(gateway);
      await sessions.refresh({ agentId: "main", force: true });
      const { sidebar, provider } = await mountSidebar(gateway, sessions);
      try {
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = key;
        const lineage = sidebar.sessionData.loadActiveSessionLineage(key);
        await waitForFast(() => expect(request).toHaveBeenCalledWith("sessions.describe", { key }));
        sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")?.click();
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith(
            "sessions.list",
            expect.objectContaining({ spawnedBy: parentKey }),
          ),
        );
        if (first === "lineage") {
          described.resolve({ session: stale });
          await waitForFast(() =>
            expect(sessions.state.result?.sessions.find((row) => row.key === key)?.label).toBe(
              stale.label,
            ),
          );
          listed.resolve(sessionsResult([fresh, sibling], 3));
        } else {
          listed.resolve(sessionsResult([fresh, sibling], 3));
          await waitForFast(() =>
            expect(sessions.state.result?.sessions.find((row) => row.key === key)?.label).toBe(
              fresh.label,
            ),
          );
          described.resolve({ session: stale });
        }
        await lineage;
        await waitForFast(() =>
          expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2),
        );
        await sidebar.updateComplete;
        expect(sidebar.textContent).toContain("Loaded sibling");
        expect
          .soft(sidebar.querySelector(`[data-session-key="${key}"]`)?.textContent)
          .not.toContain(stale.label);
        expect.soft(sessions.state.result?.sessions.find((row) => row.key === key)).toMatchObject({
          label: fresh.label,
          updatedAt: fresh.updatedAt,
          status: "done",
        });
        expect(
          sidebar.querySelector(`[data-session-key="${key}"] [aria-label="Done"]`),
        ).not.toBeNull();
      } finally {
        provider.remove();
        sessions.dispose();
        described.resolve({ session: stale });
        listed.resolve(sessionsResult([fresh, sibling], 3));
        await Promise.all([described.promise, listed.promise]);
        await sidebar.updateComplete;
      }
    },
  );

  it.each([4, null])(
    "retains the current selected descriptor after cached ancestry completes (updatedAt: %s)",
    async (updatedAt) => {
      const key = "agent:main:cached-child";
      const parentKey = "agent:main:cached-parent";
      const rootKey = "agent:main:cached-root";
      const owner = { type: "human" as const, id: "ada", label: "Ada" };
      const otherOwner = { type: "human" as const, id: "bob", label: "Bob" };
      const parent = {
        key: parentKey,
        sessionId: "cached-parent-session",
        kind: "direct" as const,
        parentSessionKey: rootKey,
        childSessions: [key],
        updatedAt: 1,
        owner: { actor: owner },
      };
      const child = {
        key,
        kind: "direct" as const,
        sessionId: "cached-child-session",
        spawnedBy: parentKey,
        label: "Earlier cached descriptor",
        status: "done" as const,
        updatedAt,
        owner: { actor: owner },
      };
      const ancestor = {
        key: rootKey,
        sessionId: "cached-root-session",
        kind: "direct" as const,
        updatedAt: 1,
      };
      const current = { ...child, label: "Current child descriptor" };
      let filteredRows: SessionsListResult["sessions"] = [parent, child];
      const rootRead = deferred<{ session: typeof ancestor }>();
      const childRead = deferred<SessionsListResult>();
      const result = (rows: SessionsListResult["sessions"]) => ({
        ...sessionsResult(rows, 5),
        owners: [owner, otherOwner],
      });
      const request = vi.fn(async (method, params) => {
        if (method === "sessions.list") {
          const query = params as { spawnedBy?: string; ownerId?: string };
          if (query.spawnedBy === parentKey) {
            return childRead.promise;
          }
          return result(
            query.ownerId
              ? filteredRows
              : [
                  parent,
                  {
                    key: "agent:main:other",
                    sessionId: "cached-other-session",
                    kind: "direct",
                    updatedAt: 1,
                    owner: { actor: otherOwner },
                  },
                ],
          );
        }
        if (method === "sessions.describe") {
          expect(params).toEqual({ key: rootKey });
          return rootRead.promise;
        }
        return {};
      });
      const gateway = createGateway(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(gateway);
      await sessions.refresh({ agentId: "main", force: true });
      const { sidebar, provider } = await mountSidebar(gateway, sessions);
      let lineage: Promise<void> | undefined;
      let children: Promise<void> | undefined;
      try {
        sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort")!.click();
        await sidebar.updateComplete;
        sidebar.querySelector(".sidebar-session-sort-menu")!.dispatchEvent(
          new CustomEvent("wa-select", {
            bubbles: true,
            detail: { item: { value: "owner:ada" } },
          }),
        );
        await waitForFast(() => {
          expect(sidebar.sessionOwnerFilterId).toBe(owner.id);
          expect(sidebar.sessionData.sessionsResult?.sessions.some((row) => row.key === key)).toBe(
            true,
          );
        });
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = key;
        lineage = sidebar.sessionData.loadActiveSessionLineage(key);
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith("sessions.describe", { key: rootKey }),
        );
        children = sidebar.sessionData.loadChildSessions(parentKey);
        childRead.resolve(result([current]));
        await children;
        await waitForFast(() =>
          expect(sessions.state.result?.sessions.find((row) => row.key === key)?.label).toBe(
            current.label,
          ),
        );
        filteredRows = [parent];
        await sidebar.sessionData.refreshSidebarSessions();
        expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
          parentKey,
        ]);
        rootRead.resolve({ session: ancestor });
        await lineage;
        await sidebar.updateComplete;
        expect
          .soft(sessions.state.result?.sessions.find((row) => row.key === key)?.label)
          .toBe(current.label);
        expect(sidebar.querySelector(`[data-session-key="${key}"]`)?.textContent).toContain(
          current.label,
        );
      } finally {
        provider.remove();
        sessions.dispose();
        rootRead.resolve({ session: ancestor });
        childRead.resolve(result([current]));
        await Promise.all([lineage, children]);
        await sidebar.updateComplete;
      }
    },
  );

  it.each([
    { listed: false, rejectRefresh: false, pendingSelection: false },
    { listed: true, rejectRefresh: false, pendingSelection: false },
    { listed: true, rejectRefresh: true, pendingSelection: false },
    ...(
      [
        "introduced",
        "introduced-read",
        "introduced-local",
        "introduced-newer-local",
        "introduced-primary",
        "introduced-terminal",
        "introduced-overlap",
        "introduced-event",
        "introduced-swarm",
        "introduced-cached",
      ] as const
    ).map((pendingSelection) => ({
      listed: false,
      rejectRefresh: false,
      pendingSelection,
    })),
    ...(["held", "completed", "metadata", "replacement", "deletion", "root"] as const).map(
      (pendingSelection) => ({
        listed: true,
        rejectRefresh: false,
        pendingSelection,
      }),
    ),
  ])(
    "refreshes a routed child while preserving filtered membership (listed: $listed, rejected refresh: $rejectRefresh, pending selection: $pendingSelection)",
    async ({ listed, rejectRefresh, pendingSelection }) => {
      const parentKey = "agent:main:parent";
      const key = "agent:main:subagent:child";
      const otherKey = "agent:main:other-owner";
      const owner = { type: "human" as const, id: "ada", label: "Ada" };
      const otherOwner = { type: "human" as const, id: "bob", label: "Bob" };
      const metadata = pendingSelection === "metadata";
      const presentation = (label: string) => ({
        label: metadata ? undefined : label,
        derivedTitle: metadata ? label : undefined,
        lastMessagePreview: metadata ? `${label} preview` : undefined,
      });
      const parent = {
        key: parentKey,
        sessionId: "session-filtered-parent",
        kind: "direct" as const,
        updatedAt: 1,
        childSessions: pendingSelection === "root" ? [] : [key],
        owner: { actor: owner },
      };
      const child = {
        key,
        kind: "direct" as const,
        sessionId: "session-filtered-child",
        spawnedBy: pendingSelection === "root" ? undefined : parentKey,
        updatedAt: 2,
        label: metadata ? undefined : "Previous child",
        owner: { actor: owner },
      };
      const result = (sessions: SessionsListResult["sessions"]): SessionsListResult => ({
        ts: 3,
        path: "",
        count: sessions.length,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        owners: [owner, otherOwner],
        sessions,
      });
      const children = deferred<SessionsListResult>();
      let childReads = 0;
      const filteredRows = () => (listed ? [parent, child] : [parent]);
      let filteredResult = result(filteredRows());
      let primaryResult = result([
        parent,
        {
          key: otherKey,
          sessionId: "session-other-owner",
          kind: "direct",
          updatedAt: 1,
          owner: { actor: otherOwner },
        },
      ]);
      let independentResult = result([parent]);
      let rejectFiltered = false;
      let rejectedReads = 0;
      let pendingQuery = deferred<SessionsListResult>();
      const markRead = deferred<SessionsPatchResult>();
      let readOperation: Promise<SessionsPatchResult | null> | undefined;
      let patchReads = 0;
      let holdFiltered = false;
      let heldReads = 0;
      let queryRefresh: Promise<void> | undefined;
      const gatewayHarness = createGatewayHarness(
        createTestGatewayClient(async (method, params) => {
          if (method === "sessions.patch") {
            patchReads += 1;
            return markRead.promise;
          }
          if (method === "sessions.list") {
            const query = params as { spawnedBy?: string; ownerId?: string; search?: string };
            if (query.search === "fresh-held") {
              return independentResult;
            }
            if (query.spawnedBy === parentKey) {
              childReads += 1;
              return children.promise;
            }
            if (query.ownerId === owner.id) {
              if (holdFiltered) {
                heldReads += 1;
                return pendingQuery.promise;
              }
              if (rejectFiltered) {
                rejectedReads += 1;
                throw new Error("Filtered session refresh unavailable");
              }
              return filteredResult;
            }
            return primaryResult;
          }
          return method === "sessions.describe" ? { session: child } : {};
        }),
      );
      const { gateway } = gatewayHarness;
      const sessions = createTestSessionCapability(gateway);
      try {
        await sessions.refresh({ agentId: "main", force: true });
        const { sidebar } = await mountSidebar(gateway, sessions);
        sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort")!.click();
        await sidebar.updateComplete;
        sidebar.querySelector(".sidebar-session-sort-menu")!.dispatchEvent(
          new CustomEvent("wa-select", {
            bubbles: true,
            detail: { item: { value: "owner:ada" } },
          }),
        );
        await waitForFast(() => {
          expect(sidebar.sessionOwnerFilterId).toBe(owner.id);
          expect(sidebar.sessionData.sessionsLoading).toBe(false);
          expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual(
            filteredRows().map((row) => row.key),
          );
        });

        if (pendingSelection) {
          holdFiltered = true;
          queryRefresh = sidebar.sessionData.refreshSidebarSessions();
          await waitForFast(() => expect(heldReads).toBe(1));
        }
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = key;
        await waitForFast(() =>
          expect(sessions.state.result?.sessions.find((row) => row.key === key)).toMatchObject({
            key,
            sessionId: child.sessionId,
            ...(metadata ? {} : { label: child.label }),
          }),
        );
        const refreshed = {
          ...child,
          updatedAt: 4,
          unread: pendingSelection === "introduced-read",
          ...(pendingSelection === "introduced-terminal" ||
          pendingSelection === "introduced-overlap"
            ? {
                hasActiveRun: true,
                status: "running" as const,
                activeRunIds:
                  pendingSelection === "introduced-overlap"
                    ? ["finishing-run", "remaining-run"]
                    : ["finishing-run"],
              }
            : {}),
          ...(pendingSelection === "introduced-swarm" ? { swarmGroupId: "synthetic-group" } : {}),
          ...presentation("Current child"),
        };
        filteredResult = result(listed ? [parent, refreshed] : [parent]);
        rejectFiltered = rejectRefresh;
        if (pendingSelection) {
          if (typeof pendingSelection === "string" && pendingSelection.startsWith("introduced")) {
            await waitForFast(() => expect(childReads).toBe(1));
            if (pendingSelection === "introduced-primary") {
              primaryResult = result([...primaryResult.sessions, refreshed]);
              await sessions.refresh({ agentId: "main", force: true });
            } else if (pendingSelection === "introduced-cached") {
              independentResult = result([refreshed]);
              const query = { agentId: "main", search: "fresh-held" };
              const stop = sessions.subscribeList(query, () => undefined);
              try {
                await sessions.refreshList(query);
                expect(sessions.reconcile(sessions.listSnapshot(query).result?.sessions[0])).toBe(
                  true,
                );
              } finally {
                stop();
              }
            } else {
              children.resolve(result([refreshed]));
            }
            await waitForFast(() =>
              expect(sessions.state.result?.sessions.find((row) => row.key === key)?.label).toBe(
                "Current child",
              ),
            );
            if (
              pendingSelection === "introduced-terminal" ||
              pendingSelection === "introduced-overlap"
            ) {
              expect(
                sessions.reconcileRunTerminal({
                  sessionKeys: [key],
                  runId: "finishing-run",
                  status: "done",
                  endedAt: 5,
                }),
              ).toBe(true);
              expect(sessions.state.result?.sessions.find((row) => row.key === key)).toMatchObject({
                status: pendingSelection === "introduced-overlap" ? "running" : "done",
                activeRunIds: pendingSelection === "introduced-overlap" ? ["remaining-run"] : [],
              });
            } else if (pendingSelection === "introduced-event") {
              expect(
                sessions.reconcileChanged({
                  key,
                  sessionId: child.sessionId,
                  updatedAt: 5,
                  hasActiveRun: true,
                  status: "running",
                  archived: false,
                }).applied,
              ).toBe(true);
              expect(sessions.state.result?.sessions.find((row) => row.key === key)?.status).toBe(
                "running",
              );
            } else if (pendingSelection === "introduced-swarm") {
              gatewayHarness.publishEvent("sessions.changed", {
                swarmGroupId: "synthetic-group",
                kind: "log",
                text: "Synthetic progress",
              });
              expect(sessions.state.result?.sessions.find((row) => row.key === key)?.swarmLog).toBe(
                "Synthetic progress",
              );
            }
            if (pendingSelection === "introduced-newer-local") {
              holdFiltered = false;
              pendingQuery.resolve(result([parent]));
              await queryRefresh;
              pendingQuery = deferred<SessionsListResult>();
              holdFiltered = true;
              queryRefresh = sidebar.sessionData.refreshSidebarSessions();
              await waitForFast(() => expect(heldReads).toBe(2));
            }
            if (pendingSelection === "introduced-read") {
              readOperation = sessions.patch(
                key,
                { unread: false },
                { agentId: "main", expectedMarkedUnreadAt: null },
              );
              await waitForFast(() => expect(patchReads).toBe(1));
              expect(sessions.state.result?.sessions.find((row) => row.key === key)?.unread).toBe(
                false,
              );
            } else if (
              pendingSelection === "introduced-local" ||
              pendingSelection === "introduced-newer-local"
            ) {
              sessions.patchRowLocal(key, { thinkingLevel: "high" });
              expect(
                sessions.state.result?.sessions.find((row) => row.key === key)?.thinkingLevel,
              ).toBe("high");
            }
            holdFiltered = false;
            const currentQuery = pendingSelection === "introduced-newer-local";
            filteredResult = result([
              parent,
              {
                ...child,
                updatedAt: currentQuery ? 5 : 3,
                label: currentQuery ? "Newer query child" : "Late introduced child",
              },
            ]);
            pendingQuery.resolve(filteredResult);
            await queryRefresh;
            await sidebar.updateComplete;
            expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
              parentKey,
              key,
            ]);
            expect(
              sidebar
                .querySelector(`[data-session-key="${key}"]`)
                ?.textContent?.replace(/\s+/g, " ")
                .trim(),
            ).toContain(currentQuery ? "Newer query child" : "Current child");
            expect(sidebar.querySelector(`[data-session-key="${otherKey}"]`)).toBeNull();
            return;
          }
          holdFiltered = false;
          pendingQuery.resolve(filteredResult);
          await queryRefresh;
          await sidebar.updateComplete;
          expect(sidebar.querySelector(`[data-session-key="${key}"]`)?.textContent).toContain(
            "Current child",
          );
          if (pendingSelection !== "root") {
            await waitForFast(() => expect(childReads).toBe(1));
          }
          filteredResult = result([
            parent,
            {
              ...refreshed,
              sessionId: pendingSelection === "replacement" ? "replacement-child" : child.sessionId,
              updatedAt: 5,
              ...presentation("Latest filtered child"),
              status: "done",
            },
          ]);
          await sidebar.sessionData.refreshSidebarSessions();
          await sidebar.updateComplete;
          expect(sidebar.querySelector(`[data-session-key="${key}"]`)?.textContent).toContain(
            "Latest filtered child",
          );
          if (pendingSelection === "deletion") {
            sessions.reconcileChanged({
              key,
              sessionId: child.sessionId,
              agentId: "main",
              reason: "delete",
            });
            await sidebar.updateComplete;
            expect(sidebar.querySelector(`[data-session-key="${key}"]`)).toBeNull();
          }
          const primaryBeforeRejectedChild = sessions.state.result;
          if (pendingSelection !== "held" && pendingSelection !== "root") {
            children.resolve(
              result([
                { ...child, updatedAt: 3, ...presentation("Delayed child"), status: "running" },
              ]),
            );
            await waitForFast(() =>
              expect(sidebar.sessionData.loadingChildSessionKeys.has(parentKey)).toBe(false),
            );
          }
          await sidebar.updateComplete;
          if (pendingSelection === "completed" || pendingSelection === "metadata") {
            const current = sessions.state.result?.sessions.find((row) => row.key === key);
            const expected = presentation("Latest filtered child");
            expect(current).toMatchObject({
              sessionId: child.sessionId,
              updatedAt: 5,
              status: "done",
            });
            expect(current?.label).toBe(expected.label);
            expect(current?.derivedTitle).toBe(expected.derivedTitle);
            expect(current?.lastMessagePreview).toBe(expected.lastMessagePreview);
            expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual(
              primaryBeforeRejectedChild?.sessions.map((row) => row.key),
            );
            expect(sessions.state.result?.sessions.filter((row) => row.key !== key)).toEqual(
              primaryBeforeRejectedChild?.sessions.filter((row) => row.key !== key),
            );
          } else {
            expect(sessions.state.result).toBe(primaryBeforeRejectedChild);
          }
          if (pendingSelection === "deletion") {
            expect(sidebar.querySelector(`[data-session-key="${key}"]`)).toBeNull();
            expect(
              sidebar.sessionData.sessionsResult?.sessions.some((row) => row.key === key),
            ).toBe(false);
            return;
          }
          expect(
            sidebar.sessionData.sessionsResult?.sessions.find((row) => row.key === key),
          ).toMatchObject({
            ...presentation("Latest filtered child"),
            status: "done",
          });
          if (pendingSelection === "root") {
            expect(sidebar.findSidebarSessionByKey(key)?.status).toBe("done");
          } else {
            expect(
              sidebar.querySelector(`[data-session-key="${key}"] [aria-label="Done"]`),
            ).not.toBeNull();
          }
        } else {
          children.resolve(result([refreshed]));
        }

        if (rejectRefresh) {
          await waitForFast(() => expect(rejectedReads).toBe(1));
          expect(sidebar.textContent).toContain("Filtered session refresh unavailable");
        }
        await waitForFast(() =>
          expect(sidebar.querySelector(`[data-session-key="${key}"]`)?.textContent).toContain(
            pendingSelection ? "Latest filtered child" : "Current child",
          ),
        );
        if (!pendingSelection) {
          expect(sessions.state.result?.sessions.find((row) => row.key === key)?.label).toBe(
            "Current child",
          );
        }
        expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual(
          filteredRows().map((row) => row.key),
        );
        expect(sidebar.querySelector(`[data-session-key="${otherKey}"]`)).toBeNull();
        if (pendingSelection) {
          filteredResult = result([parent]);
          await sidebar.sessionData.refreshSidebarSessions();
          await sidebar.updateComplete;
          expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
            parentKey,
          ]);
          expect(
            sidebar
              .querySelector(`[data-session-key="${key}"]`)
              ?.textContent?.replace(/\s+/g, " ")
              .trim(),
          ).toContain("Latest filtered child");
          expect(sidebar.findSidebarSessionByKey(key)).toMatchObject({
            sessionId: pendingSelection === "replacement" ? "replacement-child" : child.sessionId,
            label: "Latest filtered child",
            ...(metadata ? { lastMessagePreview: "Latest filtered child preview" } : {}),
          });
        }
      } finally {
        sessions.dispose();
        markRead.resolve({ ok: true, path: "", key, entry: { sessionId: child.sessionId } });
        children.resolve(result([child]));
        pendingQuery.resolve(filteredResult);
        await queryRefresh;
        await children.promise;
        await readOperation;
      }
    },
  );

  it("refreshes canonical placement while retaining same-session presentation", async () => {
    const parentKey = "agent:main:parent";
    const key = "agent:main:device-child";
    const parent = {
      key: parentKey,
      sessionId: "session-device-parent",
      kind: "direct" as const,
      updatedAt: 1,
      childSessions: [key],
    };
    const available = {
      key,
      kind: "direct" as const,
      sessionId: "session-device-child",
      parentSessionKey: parentKey,
      updatedAt: 2,
      derivedTitle: "My device session",
      lastMessagePreview: "Most recent message",
      placement: {
        state: "active" as const,
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
        environmentId: "worker:device",
        activeOwnerEpoch: 1,
        workerBundleHash: "a".repeat(64),
        workspaceBaseManifestRef: "manifest",
        remoteWorkspaceDir: "/workspace",
        runner: { kind: "device" as const, status: "available" as const },
      },
    };
    const offline = {
      ...available,
      derivedTitle: undefined,
      lastMessagePreview: undefined,
      placement: {
        ...available.placement,
        runner: { kind: "device" as const, status: "offline" as const },
      },
    };
    const result = (selected: typeof available | typeof offline): SessionsListResult => ({
      ts: 2,
      path: "",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [parent, selected],
    });
    let selected: typeof available | typeof offline = available;
    const gateway = createGateway(
      createTestGatewayClient(async (method, params) => {
        if (method === "sessions.list") {
          return (params as { spawnedBy?: string }).spawnedBy === parentKey
            ? { ...result(selected), count: 1, sessions: [selected] }
            : result(selected);
        }
        return {};
      }),
    );
    const sessions = createTestSessionCapability(gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const { sidebar, provider } = await mountSidebar(gateway, sessions);
    try {
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = key;
      await waitForFast(() =>
        expect(sidebar.sessionData.activeSessionLineageSelectedRow?.placement).toMatchObject({
          runner: { kind: "device", status: "available" },
        }),
      );
      await waitForFast(() =>
        expect(
          sidebar.sessionData.childSessionRowsByParent[parentKey]?.[0]?.placement,
        ).toMatchObject({
          runner: { kind: "device", status: "available" },
        }),
      );
      selected = offline;
      await sessions.refresh({ agentId: "main", force: true });

      expect(sidebar.sessionData.activeSessionLineageSelectedRow).toMatchObject({
        placement: { runner: { kind: "device", status: "offline" } },
        derivedTitle: "My device session",
        lastMessagePreview: "Most recent message",
      });
    } finally {
      provider.remove();
      sessions.dispose();
    }
  });
});
