/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../test/helpers/record.js";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import { loadChatHistory } from "../pages/chat/chat-history.ts";
import { createTestChatPane } from "../pages/chat/chat-pane.test-support.ts";
import { refreshPageChat } from "../pages/chat/chat-state-refresh.ts";
import { buildSessionsListQuery } from "../pages/sessions/list-query.ts";
import { activateSessionMenuValue } from "../test-helpers/app-sidebar-menu.ts";
import "../test-helpers/app-sidebar-suite.ts";
import type { GatewayRequestMock } from "../test-helpers/gateway-client.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  childToggle,
  findRow,
  rowElement,
  waitForRequest,
  mountRoster,
  placement as makePlacement,
  sessionRow,
  disposeRoster,
  human,
} from "./app-sidebar-freshness.test-support.ts";
import "./app-sidebar.tsx";

const requireRecord = createRequireRecord("object", "expected-label");
const requestParams = (request: GatewayRequestMock, method: string) =>
  request.mock.calls
    .filter(([name]) => name === method)
    .map(([, params]) => requireRecord(params, `${method} params`));
const page = (rows: GatewaySessionRow[], offset = 0): SessionsListResult => ({
  ...sessionsResult(rows, 10),
  offset,
  totalCount: 101,
  hasMore: offset === 0,
  nextOffset: offset === 0 ? 100 : null,
});

it("keeps folded child failures in the parent hovercard and own failures in child cards", async () => {
  const parent: GatewaySessionRow = { key: "agent:main:parent", kind: "direct", label: "Parent" };
  const child: GatewaySessionRow = {
    key: "agent:main:child",
    kind: "direct",
    label: "Validation",
    spawnedBy: parent.key,
    status: "failed",
    lastRunError: "Worker disconnected",
    updatedAt: 100,
  };
  const { sidebar } = await mountRoster(async (method) =>
    method === "sessions.list" ? sessionsResult([parent, child], 100) : {},
  );
  const attention = { kind: "error", reason: child.lastRunError, sourceSessionKey: child.key };
  expect(sidebar.findSidebarHovercardRowByKey(parent.key)?.attention).toEqual({
    ...attention,
    childLabel: child.label,
  });
  expect(sidebar.findSidebarHovercardRowByKey(child.key)?.attention).toEqual(attention);
});

it.each(["away and back", "during publication"] as const)(
  "keeps fetched siblings after selection changes (%s)",
  async (transition) => {
    const reentrant = transition === "during publication";
    const parentKey = "agent:main:parent";
    const primaryFacts = { agentId: "main", archived: false, updatedAt: 10 };
    const first = sessionRow("agent:main:first", "first-session", {
      ...primaryFacts,
      spawnedBy: parentKey,
      label: "First child",
    });
    const second: GatewaySessionRow = {
      ...first,
      key: "agent:main:second",
      sessionId: "second-session",
      label: "New sibling from child list",
      updatedAt: 20,
    };
    const parent = sessionRow(parentKey, "parent-session", {
      ...primaryFacts,
      label: "Parent",
      childSessions: [first.key],
    });
    const primary = sessionsResult([parent, first], 10);
    const refreshedFirst = { ...first, label: "First child from late query", updatedAt: 20 };
    const listed = sessionsResult(reentrant ? [refreshedFirst] : [refreshedFirst, second], 20);
    const childRead = deferred<SessionsListResult>();
    const secondDescribe = deferred<{ session: GatewaySessionRow }>();
    const unexpectedMethods: string[] = [];
    const request = vi.fn(async (method, params) => {
      if (method === "sessions.list") {
        const query = requireRecord(params, "sessions.list params");
        return query.spawnedBy === parentKey ? childRead.promise : primary;
      }
      if (method === "sessions.describe") {
        const query = requireRecord(params, "sessions.describe params");
        if (query.key === second.key) {
          return secondDescribe.promise;
        }
      }
      if (method === "sessions.groups.list") {
        return { names: [], groups: [], sectionOrder: [] };
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      unexpectedMethods.push(method);
      throw new Error(`Unexpected Gateway method: ${method}`);
    });
    const { sidebar, provider, sessions, data } = await mountRoster(request);
    const pending: Promise<unknown>[] = [];
    const select = (key: string) => {
      sidebar.sessionKey = key;
      const lineage = data.loadActiveSessionLineage(key);
      pending.push(lineage);
      return lineage;
    };
    let stopReentry: () => void = () => undefined;
    try {
      sidebar.activeRouteId = "chat";
      const firstLineage = select(first.key);
      const children = data.loadChildSessions(parentKey);
      pending.push(children);
      await firstLineage;
      await waitForRequest(request, "sessions.list", { spawnedBy: parentKey }, true);
      await sidebar.updateComplete;
      const toggle = childToggle(sidebar, parentKey);
      if (!toggle) {
        throw new Error("Expected the parent's child-session toggle");
      }
      if (toggle.getAttribute("aria-expanded") !== "true") {
        toggle.click();
      }
      await sidebar.updateComplete;

      if (reentrant) {
        stopReentry = sessions.subscribe((state) => {
          if (
            state.result?.sessions.find((row) => row.key === first.key)?.label ===
            refreshedFirst.label
          ) {
            stopReentry();
            void select(second.key);
          }
        });
      } else {
        const nextLineage = select(second.key);
        await waitForRequest(request, "sessions.describe", { key: second.key });
        secondDescribe.reject(new Error("Selected sibling describe temporarily unavailable"));
        await nextLineage;
        await sidebar.updateComplete;
        await select(first.key);
        await sidebar.updateComplete;
      }
      const primaryKeys = [parentKey, first.key];
      expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual(primaryKeys);
      expect(data.loadingChildSessionKeys.has(parentKey)).toBe(true);

      childRead.resolve(listed);
      await children;
      await sidebar.updateComplete;
      expect(data.childSessionRowsByParent[parentKey]?.map((row) => row.key)).toEqual(
        reentrant ? [first.key] : [first.key, second.key],
      );
      if (!reentrant) {
        expect(rowElement(sidebar, second.key)?.textContent).toContain(second.label);
      }
      expect(rowElement(sidebar, first.key)?.textContent).toContain(refreshedFirst.label);
      expect(sidebar.sessionKey).toBe(reentrant ? second.key : first.key);
      expect(findRow(sessions.state.result, first.key)).toMatchObject(refreshedFirst);
      if (reentrant) {
        expect(request).toHaveBeenCalledWith("sessions.describe", { key: second.key });
        expect(data.activeSessionLineageSelectedRow?.key).not.toBe(first.key);
        expect(sessions.state.result?.sessions).toHaveLength(primaryKeys.length);
      } else {
        expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual(primaryKeys);
        expect(data.sessionsResult?.sessions.map((row) => row.key)).toEqual(primaryKeys);
      }
      expect(unexpectedMethods).toEqual([]);
    } finally {
      stopReentry();
      disposeRoster({ provider, sessions });
      childRead.resolve(listed);
      secondDescribe.resolve({ session: second });
      await Promise.allSettled(pending);
      await sidebar.updateComplete;
    }
  },
);

it.each([
  [1, 10],
  [2, null],
] as const)(
  "orders child page %s against an intervening history read (updatedAt: %s)",
  async (selectedPage, updatedAt) => {
    const parentKey = "agent:main:paged-parent";
    const key = "agent:main:paged-child";
    const selected = sessionRow(key, "paged-child-session", {
      spawnedBy: parentKey,
      label: "Child page descriptor",
      status: "done",
      updatedAt,
      placement: makePlacement("available"),
    });
    const siblings = Array.from({ length: 100 }, (_, index) => ({
      ...selected,
      key: `agent:main:paged-sibling-${index}`,
      sessionId: `paged-sibling-session-${index}`,
      label: `Sibling ${index}`,
    }));
    const parent = sessionRow(parentKey, "paged-parent-session", {
      updatedAt: 1,
      childSessions: [key, ...siblings.map((row) => row.key)],
    });
    const historyRow = { ...selected, label: "History", placement: makePlacement("offline") };
    const firstRows = selectedPage === 1 ? [selected, ...siblings.slice(0, 99)] : siblings;
    const lastRows = selectedPage === 1 ? [siblings[99]!] : [selected];
    const firstPage = deferred<SessionsListResult>();
    const historyRead = deferred<{ messages: unknown[]; sessionInfo: GatewaySessionRow }>();
    const request = vi.fn(async (method, params) => {
      if (method === "sessions.list") {
        const query = params as { spawnedBy?: string; offset?: number };
        return query.spawnedBy === parentKey
          ? query.offset === 100
            ? page(lastRows, 100)
            : firstPage.promise
          : sessionsResult([parent, selected], 10);
      }
      return method === "chat.history" ? historyRead.promise : {};
    });
    const { client, sessions, sidebar, provider, data } = await mountRoster(request);
    const { state } = createTestChatPane({ client, sessions });
    state.sessionKey = key;
    state.sessionsResult = sessions.state.result;
    state.sessionsResultAgentId = sessions.state.agentId;
    const pending: Promise<unknown>[] = [];
    try {
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = key;
      pending.push(data.loadActiveSessionLineage(key));
      const children = data.loadChildSessions(parentKey);
      pending.push(children);
      await waitForRequest(request, "sessions.list", { spawnedBy: parentKey, limit: 100 }, true);
      const canonicalRevision = sessions.canonicalListRevision;
      const loaded = refreshPageChat(state, {
        historyLoad: loadChatHistory(state, { deferBranches: true }),
        awaitHistory: true,
        scheduleScroll: false,
      });
      pending.push(loaded);
      historyRead.resolve({ messages: [], sessionInfo: historyRow });
      await loaded;
      expect(findRow(sessions.state.result, key)?.label).toBe(historyRow.label);
      expect(sessions.canonicalListRevision).toBe(canonicalRevision);
      firstPage.resolve(page(firstRows, 0));
      await children;
      await sidebar.updateComplete;
      expect(
        requestParams(request, "sessions.list")
          .filter((params) => params.spawnedBy === parentKey)
          .map((params) => params.offset ?? 0),
      ).toEqual([0, 100]);
      expect(data.childSessionRowsByParent[parentKey]).toHaveLength(101);
      const { label, placement } = selectedPage === 1 ? historyRow : selected;
      expect(findRow(sessions.state.result, key)).toMatchObject({ label, placement });
      expect(rowElement(sidebar, key)?.textContent).toContain(label);
    } finally {
      disposeRoster({ provider, sessions });
      firstPage.resolve(page(firstRows, 0));
      historyRead.resolve({ messages: [], sessionInfo: historyRow });
      await Promise.allSettled(pending);
      await sidebar.updateComplete;
    }
  },
);

it.each([
  [false, 10],
  [true, null],
] as const)(
  "keeps a nonselected child's managed observation after paging (first page loaded: %s, updatedAt: %s)",
  async (firstPageLoaded, updatedAt) => {
    const parentKey = "agent:main:managed-parent";
    const children = Array.from({ length: 101 }, (_, index) =>
      sessionRow(`agent:worker:managed-child-${index}`, `managed-child-session-${index}`, {
        spawnedBy: parentKey,
        label: `Previous child ${index}`,
        status: "done",
        hasActiveRun: false,
        runtimeMs: 100,
        updatedAt,
      }),
    );
    const child = children[0]!;
    const fresh = {
      ...child,
      label: "Accepted managed child",
      status: "running" as const,
      hasActiveRun: true,
      runtimeMs: 400,
    };
    const childKeys = children.map((row) => row.key);
    const parent = sessionRow(parentKey, "parent", { updatedAt: 1, childSessions: childKeys });
    const firstPage = deferred<SessionsListResult>();
    const secondPage = deferred<SessionsListResult>();
    const childPage = (offset: number) => page(children.slice(offset, offset + 100), offset);
    const request = vi.fn(async (method, params) => {
      if (method !== "sessions.list") {
        return {};
      }
      const query = requireRecord(params, "sessions.list params");
      if (query.spawnedBy === parentKey) {
        return query.offset === 100 ? secondPage.promise : firstPage.promise;
      }
      return sessionsResult(query.search === child.key ? [fresh] : [parent], 10);
    });
    const { sidebar, provider, sessions, context, data } = await mountRoster(request, {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "worker" }],
    });
    const query = buildSessionsListQuery(context, {
      deepLinkSessionKey: child.key,
      includeGlobal: true,
      includeUnknown: true,
      statusFilter: "active",
    });
    const unsubscribe = sessions.subscribeList(query, () => {});
    let childLoad: Promise<void> | undefined;
    try {
      sidebar.activeRouteId = "sessions";
      await sidebar.updateComplete;
      childLoad = data.loadChildSessions(parentKey);
      childToggle(sidebar)!.click();
      await waitForRequest(request, "sessions.list", { spawnedBy: parentKey, limit: 100 }, true);
      const primary = sessions.state.result;
      const canonicalRevision = sessions.canonicalListRevision;
      if (firstPageLoaded) {
        firstPage.resolve(childPage(0));
        await waitForRequest(request, "sessions.list", { spawnedBy: parentKey, offset: 100 }, true);
      }
      await sessions.refreshList({ ...query, force: true });
      expect(sessions.listSnapshot(query).result?.sessions).toEqual([fresh]);
      expect(sessions.canonicalListRevision).toBe(canonicalRevision);
      expect(sessions.state.result).toBe(primary);
      expect(data.sessionsResult?.sessions.map((row) => row.key)).toEqual([parentKey]);
      firstPage.resolve(childPage(0));
      secondPage.resolve(childPage(100));
      await childLoad;
      await sidebar.updateComplete;
      expect(data.childSessionRowsByParent[parentKey]?.map((row) => row.key)).toEqual(childKeys);
      expect.soft(rowElement(sidebar, child.key)?.textContent).toContain(fresh.label);
      expect.soft(sidebar.findSidebarHovercardRowByKey(child.key)).toMatchObject(fresh);
      expect(
        childToggle(sidebar)?.classList.contains("sidebar-child-session-toggle--running"),
      ).toBe(true);
      expect(sessions.state.result).toBe(primary);
    } finally {
      unsubscribe();
      disposeRoster({ provider, sessions });
      firstPage.resolve(childPage(0));
      secondPage.resolve(childPage(100));
      await childLoad;
      await sidebar.updateComplete;
    }
  },
);

it.each([
  { first: "filtered list", primaryListed: true, updatedAt: 4, differentParents: true },
  { first: "describe", primaryListed: false, updatedAt: null, differentParents: false },
])(
  "uses the later selected-row read while ancestry waits ($first issued first, updatedAt: $updatedAt, primary listed: $primaryListed, different parents: $differentParents)",
  async ({ first, updatedAt, primaryListed, differentParents }) => {
    const key = "agent:main:observed-child";
    const parentKey = "agent:main:parent";
    const describedParentKey = differentParents ? "agent:main:described-parent" : parentKey;
    const owner = human("ada", "Ada");
    const otherOwner = human("bob", "Bob");
    const parent = sessionRow(parentKey, "parent", { updatedAt: 1, owner: { actor: owner } });
    const describedParent = {
      ...parent,
      key: describedParentKey,
      sessionId: differentParents ? "described-parent-session" : parent.sessionId,
    };
    const described = sessionRow(key, "observed-child-session", {
      spawnedBy: describedParentKey,
      label: "Described selected child",
      updatedAt,
      owner: { actor: owner },
      placement: makePlacement("available"),
    });
    const filtered = {
      ...described,
      spawnedBy: parentKey,
      label: "Filtered selected child",
      placement: makePlacement("offline"),
    };
    const initial = sessionRow("agent:main:a", "a", { updatedAt: 1, owner: { actor: owner } });
    const other = {
      ...initial,
      key: "agent:main:b",
      sessionId: "b",
      owner: { actor: otherOwner },
    };
    const result = (rows: SessionsListResult["sessions"]): SessionsListResult => ({
      ...sessionsResult(rows, 5),
      owners: [owner, otherOwner],
    });
    const selectedRead = deferred<{ session: typeof described }>();
    const repeatedSelectedRead = deferred<{ session: typeof described }>();
    const parentRead = deferred<{ session: typeof parent }>();
    const filteredRead = deferred<SessionsListResult>();
    const followupRead = deferred<SessionsListResult>();
    let holdFiltered = false;
    let heldReads = 0;
    let selectedReads = 0;
    const request = vi.fn(async (method, params) => {
      if (method === "sessions.list") {
        const query = params as { spawnedBy?: string; ownerId?: string };
        if (query.spawnedBy === parentKey || query.spawnedBy === describedParentKey) {
          return result([]);
        }
        if (query.ownerId === owner.id) {
          if (holdFiltered) {
            heldReads += 1;
            return heldReads === 1 ? filteredRead.promise : followupRead.promise;
          }
          return result([initial]);
        }
        return result(
          primaryListed
            ? [initial, other, differentParents ? filtered : described]
            : [initial, other],
        );
      }
      if (method === "sessions.describe") {
        expect(params).toEqual({
          key: (params as { key: string }).key === key ? key : describedParentKey,
        });
        return (params as { key: string }).key === key
          ? ++selectedReads === 1
            ? selectedRead.promise
            : repeatedSelectedRead.promise
          : parentRead.promise;
      }
      return {};
    });
    const { sidebar, provider, sessions, data } = await mountRoster(request);
    let lineage: Promise<void> | undefined;
    let refresh: Promise<void> | undefined;
    try {
      await activateSessionMenuValue(sidebar, "owner:ada");
      await waitForFast(() => {
        expect(sidebar.sessionOwnerFilterId).toBe(owner.id);
        expect(data.sessionsLoading).toBe(false);
        expect(data.sessionsResult?.sessions.map((row) => row.key)).toEqual([initial.key]);
      });
      // Finish the initial filter request before opening the held successor read.
      await data.refreshSidebarSessions();
      holdFiltered = true;
      if (first === "filtered list") {
        refresh = data.refreshSidebarSessions();
        await waitForFast(() => expect(heldReads).toBe(1));
      }
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = key;
      lineage = data.loadActiveSessionLineage(key);
      await waitForRequest(request, "sessions.describe", { key });
      selectedRead.resolve({ session: described });
      if (primaryListed && differentParents) {
        parentRead.resolve({ session: describedParent });
        await waitForFast(() => expect(rowElement(sidebar, describedParentKey)).not.toBeNull());
      }
      await waitForRequest(request, "sessions.describe", { key: describedParentKey });
      expect(requestParams(request, "sessions.describe").filter((p) => p.key === key)).toHaveLength(
        1,
      );
      if (first === "describe") {
        refresh = data.refreshSidebarSessions();
        await waitForFast(() => expect(heldReads).toBe(1));
      }
      filteredRead.resolve(result([parent, filtered]));
      await refresh;
      const expected = first === "filtered list" ? described : filtered;
      expect(findRow(data.sessionsResult, key)?.label).toBe(expected.label);
      parentRead.resolve({ session: describedParent });
      await lineage;
      await sidebar.updateComplete;
      const { label, placement } = expected;
      expect.soft(findRow(sessions.state.result, key)).toMatchObject({ label, placement });
      expect.soft(sidebar.findSidebarSessionByKey(key)).toMatchObject({
        label,
        placementState: placement.state,
      });
      expect(rowElement(sidebar, key)?.textContent).toContain(expected.label);
      expect(data.sessionsResult?.sessions.map((row) => row.key)).toEqual([parentKey, key]);
      expect(rowElement(sidebar, other.key)).toBeNull();
      if (differentParents) {
        expect(data.activeSessionLineageRoot?.key).toBe(expected.spawnedBy);
        expect(rowElement(sidebar, expected.spawnedBy)).not.toBeNull();
      }
    } finally {
      disposeRoster({ provider, sessions });
      selectedRead.resolve({ session: described });
      repeatedSelectedRead.resolve({ session: described });
      parentRead.resolve({ session: describedParent });
      filteredRead.resolve(result([parent, filtered]));
      followupRead.resolve(result([parent, filtered]));
      await Promise.all([lineage, refresh]);
      await sidebar.updateComplete;
    }
  },
);
