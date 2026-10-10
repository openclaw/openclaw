/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../test/helpers/record.js";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  createAgentSelectionCapability,
  selectApplicationSession,
} from "../app/agent-selection.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { activateSessionMenuValue } from "../test-helpers/app-sidebar-menu.ts";
import {
  createContext,
  createGatewayHarness,
  mountSidebar,
  mountSidebarContext,
  type SidebarLifecycleState,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./app-sidebar.ts";

const mainAgents: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [{ id: "main" }],
};
async function mountFixture(
  request: Parameters<typeof createTestGatewayClient>[0],
  agents: AgentsListResult | null = null,
  user?: { id: string; label: string },
) {
  const harness = createGatewayHarness(createTestGatewayClient(request));
  if (user) {
    harness.publish({ selfUser: { id: user.id, name: user.label } });
  }
  const sessions = createTestSessionCapability(harness.gateway);
  await sessions.refresh({ agentId: "main", force: true });
  return { ...(await mountSidebar(harness.gateway, sessions, "panel", agents)), harness, sessions };
}
function sessionTree(sidebar: SidebarLifecycleState, selected: string) {
  const row = (key: string) => sidebar.querySelector(`[data-session-key="${key}"]`);
  const parent = () =>
    row(selected)
      ?.closest("[data-session-tree]")
      ?.parentElement?.closest("[data-session-tree]")
      ?.getAttribute("data-session-tree") ?? null;
  const expand = async (key: string) => {
    sidebar
      .querySelector<HTMLButtonElement>(
        `[data-child-session-toggle="${key}"][aria-expanded="false"]`,
      )
      ?.click();
    await sidebar.updateComplete;
  };
  return { row, parent, expand };
}

describe("sidebar routed-lineage freshness", () => {
  it("hides a selected active main child in Archived after fresh lineage completes", async () => {
    const mainKey = "agent:main:main";
    const selected: GatewaySessionRow = {
      key: "agent:main:selected-active",
      sessionId: "selected-active-session",
      agentId: "main",
      kind: "direct",
      label: "Selected active session",
      archived: false,
      updatedAt: 10,
      spawnedBy: mainKey,
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
          return initialParent.promise;
        }
        throw new Error(`Unexpected describe key: ${String(key)}`);
      }
      return {};
    });
    const { sidebar, provider, sessions } = await mountFixture(request, mainAgents);
    const row = () => sidebar.querySelector(`[data-session-key="${selected.key}"]`);
    try {
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = selected.key;
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("sessions.describe", { key: mainKey }),
      );
      await waitForFast(() => expect(row()).not.toBeNull());

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
      initialParent.resolve({ session: parent });
      await waitForFast(() =>
        expect(sidebar.sessionData.activeSessionLineageRoot?.key).toBe(mainKey),
      );
      await sidebar.updateComplete;
      expect(
        request.mock.calls.filter(
          ([method, params]) => method === "sessions.describe" && params?.key === mainKey,
        ),
      ).toHaveLength(1);
      expect(sidebar.sessionKey).toBe(selected.key);
      expect(sidebar.activeRouteId).toBe("chat");
      expect(sidebar.sessionData.activeSessionLineageSelectedRow?.key).toBe(selected.key);
      expect(sidebar.sessionData.sessionsResult?.sessions).toEqual([]);
      expect(row()).toBeNull();

      const describes = () =>
        request.mock.calls.filter(
          ([method, params]) => method === "sessions.describe" && params?.key === selected.key,
        );
      const settledDescribes = describes().length;
      await sessions.refresh({ agentId: "main", force: true });
      await sidebar.updateComplete;
      await sidebar.sessionData.loadActiveSessionLineage(selected.key);
      await sidebar.updateComplete;
      expect(describes()).toHaveLength(settledDescribes);
      expect(sidebar.sessionData.activeSessionLineageSelectedRow?.key).toBe(selected.key);
      expect(sidebar.sessionData.sessionsResult?.sessions).toEqual([]);
      expect(row()).toBeNull();
    } finally {
      provider.remove();
      sessions.dispose();
      initialParent.resolve({ session: parent });
      freshSelected.resolve({ session: selected });
      await sidebar.updateComplete;
    }
  });

  it.each([
    { first: "lineage", updatedAt: 3 },
    { first: "child list", updatedAt: null },
  ])(
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
      const { sidebar, provider, sessions } = await mountFixture(request);
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
});

describe("selected lineage after managed list admission", () => {
  it.each(["pending incarnation", "known parent"] as const)(
    "%s updates preserve current ancestry before the primary response settles",
    async (kind) => {
      vi.useFakeTimers();
      const pendingIncarnation = kind === "pending incarnation";
      const changesParent = kind === "known parent";
      const changesSessionId = pendingIncarnation;
      const knownParent = kind === "known parent";
      const key = "agent:main:ordinary-child";
      const p1 = "agent:main:original-parent";
      const p2 = "agent:main:successor-parent";
      const expectedParent = changesParent ? p2 : p1;
      const ada = { type: "human" as const, id: "ada", label: "Ada" };
      const bob = { type: "human" as const, id: "bob", label: "Bob" };
      const child: GatewaySessionRow = {
        key,
        sessionId: "ordinary-child-original-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        parentSessionKey: p1,
        label: "Original selected conversation",
        updatedAt: 10,
        owner: { actor: ada },
      };
      const oldParent: GatewaySessionRow = {
        key: p1,
        sessionId: "original-parent-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        childSessions: [key],
        label: "Original ancestor",
        updatedAt: 5,
        owner: { actor: bob },
      };
      const newParent: GatewaySessionRow = {
        ...oldParent,
        key: p2,
        sessionId: "successor-parent-session",
        label: "Successor ancestor",
        owner: { actor: knownParent ? ada : bob },
      };
      const freshParent = { ...oldParent, label: "Current ancestor", updatedAt: 30 };
      const oldParentRead = deferred<{ session: GatewaySessionRow }>();
      let parentReads = 0;
      let current = child;
      let changed = false;
      let primaryReleased = false;
      let primaryReads = 0;
      let managedReads = 0;
      const primary = deferred<SessionsListResult>();
      const result = () => ({
        ...sessionsResult(knownParent ? [current, newParent] : [current], changed ? 30 : 10),
        owners: [ada, bob],
      });
      const request = vi.fn(async (method: string, raw?: unknown) => {
        const params = asOptionalRecord(raw);
        if (method === "sessions.subscribe") {
          return { subscribed: true, list: result() };
        }
        if (method === "sessions.list") {
          if (params?.spawnedBy === p1) {
            return sessionsResult(changed && changesParent ? [] : [current], 30);
          }
          if (params?.spawnedBy === p2) {
            return sessionsResult([current], 30);
          }
          if (params?.involvingMe === true) {
            managedReads += 1;
            return result();
          }
          if (changed && !primaryReleased) {
            primaryReads += 1;
            return primary.promise;
          }
          return result();
        }
        if (method === "sessions.describe") {
          if (params?.key === key) {
            return { session: current };
          }
          if (params?.key === p1) {
            parentReads += 1;
            if (pendingIncarnation && parentReads === 1) {
              return oldParentRead.promise;
            }
            return { session: pendingIncarnation ? freshParent : oldParent };
          }
          if (params?.key === p2) {
            return { session: newParent };
          }
          throw new Error(`Unexpected describe key: ${String(params?.key)}`);
        }
        return {};
      });
      const { sidebar, provider, sessions, harness } = await mountFixture(request, mainAgents, ada);
      const { row, parent: parentOfSelected, expand } = sessionTree(sidebar, key);
      let originalLineage: Promise<void> | undefined;
      try {
        await activateSessionMenuValue(sidebar, "involving-me");
        await waitForFast(() => {
          expect(managedReads).toBeGreaterThan(0);
          expect(sidebar.sessionData.sessionsLoading).toBe(false);
          expect(sidebar.sessionData.sessionsResult?.sessions.map((entry) => entry.key)).toEqual(
            knownParent ? [key, p2] : [key],
          );
        });
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = key;
        await waitForFast(() => expect(parentReads).toBe(1));
        originalLineage = sidebar.sessionData.loadActiveSessionLineage(key);
        if (!pendingIncarnation) {
          await originalLineage;
          await waitForFast(() => expect(row(p1)).not.toBeNull());
          await expand(p1);
          await waitForFast(() => expect(parentOfSelected()).toBe(p1));
        }
        const originalRevision = sessions.canonicalListRevision;
        const originalManagedReads = managedReads;
        changed = true;
        current = {
          ...child,
          sessionId: changesSessionId ? "ordinary-child-successor-session" : child.sessionId,
          parentSessionKey: expectedParent,
          label: "Current selected conversation",
          updatedAt: 30,
        };
        harness.publishEvent("sessions.changed", {
          ...current,
          sessionKey: key,
          session: current,
          reason: "create",
          ts: 30,
        });
        await vi.advanceTimersByTimeAsync(5_000);
        await waitForFast(() => {
          expect(primaryReads).toBeGreaterThan(0);
          expect(managedReads).toBeGreaterThan(originalManagedReads);
          expect(sidebar.sessionData.sessionsLoading).toBe(false);
          expect(sidebar.sessionData.sessionsResult?.sessions[0]).toMatchObject({
            sessionId: current.sessionId,
            parentSessionKey: current.parentSessionKey,
            label: current.label,
          });
        });
        expect(sessions.canonicalListRevision).toBe(originalRevision);
        await sidebar.updateComplete;
        if (pendingIncarnation) {
          await waitForFast(() => expect(parentReads).toBe(2));
        }
        await sidebar.sessionData.loadActiveSessionLineage(key);
        await sidebar.updateComplete;
        await expand(expectedParent);
        const beforePrimary = {
          selectedSessionId: sidebar.findSidebarSessionByKey(key)?.sessionId,
          selectedText: row(key)?.textContent?.replace(/\s+/g, " ").trim(),
          parentOfSelected: parentOfSelected(),
          originalParentVisible: row(p1) !== null,
          successorParentVisible: row(p2) !== null,
          parentReads,
          successorDescribeReads: request.mock.calls.filter(
            ([method, params]) =>
              method === "sessions.describe" && asOptionalRecord(params)?.key === p2,
          ).length,
        };
        if (pendingIncarnation) {
          oldParentRead.resolve({ session: oldParent });
          await originalLineage;
          await sidebar.updateComplete;
          expect(row(p1)?.textContent).toContain("Current ancestor");
          expect(sidebar.findSidebarSessionByKey(key)?.sessionId).toBe(current.sessionId);
        }
        primaryReleased = true;
        primary.resolve(result());
        await waitForFast(() =>
          expect(sessions.canonicalListRevision).toBeGreaterThan(originalRevision),
        );
        await waitForFast(() => expect(row(expectedParent)).not.toBeNull());
        await expand(expectedParent);
        await waitForFast(() => expect(parentOfSelected()).toBe(expectedParent));
        expect(beforePrimary.selectedSessionId).toBe(current.sessionId);
        expect(beforePrimary.selectedText).toContain("Current selected conversation");
        expect(beforePrimary.parentOfSelected).toBe(expectedParent);
        expect(beforePrimary.parentReads).toBe(pendingIncarnation ? 2 : 1);
        expect(beforePrimary.successorParentVisible).toBe(changesParent);
        if (changesParent) {
          expect(beforePrimary.originalParentVisible).toBe(false);
          expect(beforePrimary.successorDescribeReads).toBe(knownParent ? 0 : 1);
        }
      } finally {
        primaryReleased = true;
        primary.resolve(result());
        oldParentRead.resolve({ session: oldParent });
        provider.remove();
        sessions.dispose();
        await originalLineage;
      }
    },
  );
});

describe("selected lineage after a full sessions.changed event", () => {
  it.each(["filtered omitted", "unfiltered metadata"] as const)(
    "%s keeps accepted event fields visible after list refresh failures",
    async (mode) => {
      vi.useFakeTimers();
      const filtered = mode !== "unfiltered metadata";
      const reparent = mode !== "unfiltered metadata";
      const key = "agent:main:event-selected";
      const p1 = "agent:main:event-original-parent";
      const p2 = "agent:main:event-new-parent";
      const expectedParent = reparent ? p2 : p1;
      const initialAt = Date.now() - 100;
      const ada = { type: "human" as const, id: "ada", label: "Ada" };
      const bob = { type: "human" as const, id: "bob", label: "Bob" };
      const child: GatewaySessionRow = {
        key,
        sessionId: "event-selected-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        spawnedBy: p1,
        parentSessionKey: p1,
        label: "Earlier selected title",
        updatedAt: initialAt,
        status: "done",
        owner: { actor: bob },
      };
      const parent: GatewaySessionRow = {
        key: p1,
        sessionId: "event-original-parent-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        childSessions: [key],
        label: "Original parent",
        updatedAt: initialAt - 10,
        owner: { actor: ada },
      };
      const newParent: GatewaySessionRow = {
        key: p2,
        sessionId: "event-new-parent-session",
        agentId: "main",
        kind: "direct",
        archived: false,
        childSessions: [key],
        label: "New parent",
        updatedAt: initialAt - 10,
        owner: { actor: bob },
      };
      let current = child;
      let failedLists = false;
      let recovery = false;
      let primaryFailures = 0;
      let managedFailures = 0;
      let controllerChildReads = 0;
      let newParentReads = 0;
      const result = (rows: GatewaySessionRow[]) => ({
        ...sessionsResult(rows, current.updatedAt ?? initialAt),
        owners: [ada, bob],
      });
      const primaryRows = () => (!filtered || recovery ? [parent, current] : [parent]);
      const request = vi.fn(async (method: string, raw?: unknown) => {
        const params = asOptionalRecord(raw);
        if (method === "sessions.subscribe") {
          return { subscribed: true, list: result(primaryRows()) };
        }
        if (method === "sessions.list") {
          if (params?.spawnedBy === p1) {
            controllerChildReads += 1;
            return result([current]);
          }
          if (params?.spawnedBy === p2) {
            return result([current]);
          }
          if (params?.involvingMe === true) {
            if (failedLists) {
              managedFailures += 1;
              throw new Error("Synthetic managed refresh failure");
            }
            return result([parent]);
          }
          if (failedLists) {
            primaryFailures += 1;
            throw new Error("Synthetic primary refresh failure");
          }
          return result(primaryRows());
        }
        if (method === "sessions.describe") {
          if (params?.key === key) {
            return { session: current };
          }
          if (params?.key === p1) {
            return { session: parent };
          }
          if (params?.key === p2) {
            newParentReads += 1;
            return { session: newParent };
          }
          throw new Error(`Unexpected describe key: ${String(params?.key)}`);
        }
        return {};
      });
      const { sidebar, provider, sessions, harness } = await mountFixture(request, mainAgents, ada);
      const { row, parent: directParent, expand } = sessionTree(sidebar, key);
      try {
        if (filtered) {
          await activateSessionMenuValue(sidebar, "involving-me");
          await waitForFast(() => {
            expect(sidebar.sessionData.sessionsLoading).toBe(false);
            expect(sidebar.sessionData.sessionsResult?.sessions.map((entry) => entry.key)).toEqual([
              p1,
            ]);
          });
        }
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = key;
        await waitForFast(() => expect(sidebar.sessionData.activeSessionLineageRoot?.key).toBe(p1));
        await expand(p1);
        await waitForFast(() => {
          expect(controllerChildReads).toBe(1);
          expect(sidebar.sessionData.loadingChildSessionKeys.has(p1)).toBe(false);
          expect(directParent()).toBe(p1);
          expect(row(key)?.textContent).toContain(child.label);
        });
        const revisionBefore = sessions.canonicalListRevision;
        failedLists = true;
        current = {
          ...child,
          parentSessionKey: expectedParent,
          label: "Event-updated selected title",
          updatedAt: Date.now(),
        };
        harness.publishEvent("sessions.changed", {
          sessionKey: key,
          agentId: "main",
          reason: "create",
          ts: current.updatedAt,
          sessionId: current.sessionId,
          kind: current.kind,
          updatedAt: current.updatedAt,
          label: current.label,
          parentSessionKey: current.parentSessionKey,
          spawnedBy: current.spawnedBy,
          archived: false,
          archivedAt: null,
          archivedBy: null,
          archiveReason: null,
          owner: current.owner,
          createdActor: null,
          participants: [],
          participantCount: 0,
          pinned: false,
          pinnedAt: null,
          unread: false,
          markedUnreadAt: null,
          agentStatus: null,
          observerDigest: null,
          controlOwnerSessionKey: null,
          icon: null,
          color: null,
          channelAvatarUrl: null,
          category: null,
          displayName: null,
          permissionMode: null,
          permissionModePending: false,
          toolOverrides: null,
          thinkingLevel: null,
          activeModelProvider: null,
          activeModel: null,
          lastRunError: null,
          lastRunId: null,
          hasAutomation: false,
          hasActiveRun: false,
          activeRunIds: [],
          status: "done",
        });
        await vi.advanceTimersByTimeAsync(5_000);
        await waitForFast(() =>
          expect(sessions.state.result?.sessions.find((entry) => entry.key === key)).toMatchObject({
            sessionId: child.sessionId,
            label: current.label,
            parentSessionKey: expectedParent,
          }),
        );
        await waitForFast(() => {
          expect(primaryFailures).toBeGreaterThan(0);
          if (filtered) {
            expect(managedFailures).toBeGreaterThan(0);
          }
        });
        await sidebar.updateComplete;
        expect(sessions.canonicalListRevision).toBe(revisionBefore);
        // A retained parent query refreshes its changed member; reparenting
        // retires the old query before its scheduled refresh runs.
        expect(controllerChildReads).toBe(reparent ? 1 : 2);
        if (mode === "filtered omitted") {
          expect(sidebar.sessionData.sessionsResult?.sessions.map((entry) => entry.key)).toEqual([
            p1,
          ]);
        }
        await waitForFast(() => expect(row(key)?.textContent).toContain(current.label));
        await waitForFast(() => expect(row(expectedParent)).not.toBeNull());
        await expand(expectedParent);
        await waitForFast(() => expect(directParent()).toBe(expectedParent));
        expect(newParentReads).toBe(reparent ? 1 : 0);
        failedLists = false;
        recovery = true;
        await sessions.refresh({ agentId: "main", force: true });
        if (filtered) {
          await sidebar.sessionData.refreshSidebarSessions();
        }
        await waitForFast(() => expect(row(expectedParent)).not.toBeNull());
        await expand(expectedParent);
        await waitForFast(() => {
          expect(row(key)?.textContent).toContain(current.label);
          expect(directParent()).toBe(expectedParent);
        });
      } finally {
        vi.useRealTimers();
        failedLists = false;
        provider.remove();
        sessions.dispose();
      }
    },
  );
});

describe("sidebar routed-lineage freshness", () => {
  it("resolves the routed child's former global ancestor over a foreign cached row", async () => {
    const agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "work" }, { id: "research" }],
    } satisfies AgentsListResult;
    const parent: GatewaySessionRow = {
      key: "global",
      agentId: "work",
      sessionId: "owned-parent-session",
      kind: "global",
      label: "Owned parent conversation",
      updatedAt: 1,
      archived: false,
    };
    const child: GatewaySessionRow = {
      key: "agent:work:dashboard:20000000-0000-4000-8000-000000000001",
      agentId: "work",
      sessionId: "work-fork-session",
      kind: "direct",
      label: "Selected Work fork",
      parentSessionKey: parent.key,
      updatedAt: 1_000,
      archived: false,
    };
    const foreign: GatewaySessionRow = {
      ...parent,
      agentId: "main",
      sessionId: "main-global-session",
      label: "Foreign Main conversation",
      updatedAt: 900,
    };
    const workRows = [
      child,
      ...Array.from({ length: 199 }, (_, index): GatewaySessionRow => ({
        key: `agent:work:dashboard:30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        agentId: "work",
        sessionId: `work-page-${index}`,
        kind: "direct",
        updatedAt: 500 - index,
        archived: false,
      })),
    ];
    const workPage: SessionsListResult = {
      ...sessionsResult(workRows, 2_000),
      totalCount: workRows.length + 1,
      limitApplied: 200,
      hasMore: true,
      nextOffset: 200,
    };
    const requireRecord = createRequireRecord("object", "expected-label");
    const request = vi.fn(async (method: string, raw?: unknown) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.groups.list") {
        return { names: [], sectionOrder: [] };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      const params = requireRecord(raw, `${method} params`);
      if (method === "sessions.list") {
        if (params.spawnedBy) {
          return sessionsResult(
            params.spawnedBy === parent.key && (!params.agentId || params.agentId === child.agentId)
              ? [child]
              : [],
            2_000,
          );
        }
        if (params.agentId === "work") {
          return workPage;
        }
        expect(params.agentId).toBeUndefined();
        return {
          ...workPage,
          ...sessionsResult([child, foreign, ...workRows.slice(1, 199)], 2_001),
        };
      }
      if (method === "sessions.describe") {
        if (params.key === child.key) {
          return { session: child };
        }
        expect(params.key).toBe(parent.key);
        if (!params.agentId) {
          throw new Error(
            'Multiple agents are configured, but session key "global" has no explicit owner. Pass agentId or use an agent-prefixed session key.',
          );
        }
        expect(params.agentId === undefined || params.agentId === parent.agentId).toBe(true);
        return { session: parent };
      }
      throw new Error(`Unexpected Gateway method: ${method}`);
    });
    const harness = createGatewayHarness(createTestGatewayClient(request));
    const { gateway } = harness;
    harness.publish({
      hello: {
        ...gatewayHelloForMethods(["sessions.list", "sessions.describe", "sessions.subscribe"]),
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "agent:main:main",
          },
        },
      },
      sessionKey: "agent:work:main",
    });
    gateway.setSessionKey = (sessionKey) => harness.publish({ sessionKey });
    const selection = createAgentSelectionCapability(
      gateway,
      {
        state: { agentsList },
        subscribe: () => () => undefined,
      },
      { load: () => "work", save: () => undefined },
    );
    const sessions = createSessionCapability(gateway, selection);
    const context = {
      ...createContext(gateway, sessions, agentsList),
      agentSelection: selection,
    };
    const { provider, sidebar } = await mountSidebarContext(context, "panel", "sessions");
    sidebar.connected = true;
    try {
      harness.publish({});
      await waitForFast(() =>
        expect(sessions.state.result?.sessions).toHaveLength(workRows.length),
      );
      expect(sessions.state.agentId).toBe("work");

      // Startup recovery can publish an unscoped primary snapshot while Work stays selected.
      await sessions.refresh({ force: true, backgroundHydrate: true });
      expect(sessions.state.agentId).toBeNull();
      expect(sessions.state.result?.sessions.find((row) => row.key === "global")?.agentId).toBe(
        "main",
      );
      expect(selection.state.selectedId).toBe("work");

      selectApplicationSession({ selection, gateway, sessionKey: child.key });
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = child.key;
      await sidebar.sessionData.loadActiveSessionLineage(child.key);
      await sidebar.updateComplete;
      // Reveal the loaded section without fetching the next Gateway page.
      for (let page = 0; page < 20; page += 1) {
        const showMore = sidebar.querySelector<HTMLButtonElement>(
          '.sidebar-session-pagination__button[aria-label="Show more"]',
        );
        if (!showMore) {
          break;
        }
        showMore.click();
        await sidebar.updateComplete;
      }
      expect(
        sidebar.querySelector('.sidebar-session-pagination__button[aria-label="Show more"]'),
      ).toBeNull();

      expect(
        sessions.state.result?.sessions.some(
          (row) => row.key === parent.key && row.agentId === parent.agentId,
        ),
      ).toBe(false);

      const parentRow = sidebar.querySelector(`[data-session-key="${parent.key}"]`);
      expect.soft(parentRow?.textContent ?? "").toContain(parent.label);
      expect.soft(sidebar.textContent).not.toContain(foreign.label);
      expect(
        sidebar.querySelector(`[data-session-key="${child.key}"]`)?.textContent ?? "",
      ).toContain(child.label);
      expect(sidebar.sessionKey).toBe(child.key);
      expect(selection.state.selectedId).toBe("work");
    } finally {
      provider.remove();
      sessions.dispose();
      await sidebar.updateComplete;
    }
  });
});
