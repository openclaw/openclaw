/* @vitest-environment jsdom */

import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { loadChatHistory } from "../pages/chat/chat-history.ts";
import { createTestChatPane } from "../pages/chat/chat-pane.test-support.ts";
import { refreshPageChat } from "../pages/chat/chat-state-refresh.ts";
import { sessionsPageListQuery } from "../pages/sessions/route.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { createGateway, deferred, mountSidebar } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./app-sidebar.ts";

const requireRecord = createRequireRecord("object", "expected-label");

describe("sidebar routed-lineage freshness", () => {
  it.each(["sibling", "away and back", "during publication"] as const)(
    "keeps fetched siblings after selection changes (%s)",
    async (transition) => {
      const returnToFirst = transition === "away and back";
      const reentrant = transition === "during publication";
      const parentKey = "agent:main:route-switch-parent";
      const first: GatewaySessionRow = {
        key: "agent:main:route-switch-first",
        sessionId: "route-switch-first-session",
        agentId: "main",
        kind: "direct",
        spawnedBy: parentKey,
        label: "First child",
        archived: false,
        updatedAt: 10,
      };
      const second: GatewaySessionRow = {
        ...first,
        key: "agent:main:route-switch-second",
        sessionId: "route-switch-second-session",
        label: "New sibling from child list",
        updatedAt: 20,
      };
      const parent: GatewaySessionRow = {
        key: parentKey,
        sessionId: "route-switch-parent-session",
        agentId: "main",
        kind: "direct",
        label: "Parent",
        archived: false,
        updatedAt: 10,
        childSessions: [first.key],
      };
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
      const gateway = createGateway(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(gateway);
      await sessions.refresh({ agentId: "main", force: true });
      const { sidebar, provider } = await mountSidebar(gateway, sessions);
      const pending: Promise<unknown>[] = [];
      let stopReentry: () => void = () => undefined;
      try {
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = first.key;
        const firstLineage = sidebar.sessionData.loadActiveSessionLineage(first.key);
        const children = sidebar.sessionData.loadChildSessions(parentKey);
        pending.push(firstLineage, children);
        await firstLineage;
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith(
            "sessions.list",
            expect.objectContaining({ spawnedBy: parentKey }),
          ),
        );
        await sidebar.updateComplete;
        const toggle = sidebar.querySelector<HTMLButtonElement>(
          `[data-child-session-toggle="${parentKey}"]`,
        );
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
              sidebar.sessionKey = second.key;
              pending.push(sidebar.sessionData.loadActiveSessionLineage(second.key));
            }
          });
        } else {
          sidebar.sessionKey = second.key;
          const nextLineage = sidebar.sessionData.loadActiveSessionLineage(second.key);
          pending.push(nextLineage);
          await waitForFast(() =>
            expect(request).toHaveBeenCalledWith("sessions.describe", { key: second.key }),
          );
          secondDescribe.reject(new Error("Selected sibling describe temporarily unavailable"));
          await nextLineage;
          await sidebar.updateComplete;
        }
        if (returnToFirst) {
          sidebar.sessionKey = first.key;
          const replacementLineage = sidebar.sessionData.loadActiveSessionLineage(first.key);
          pending.push(replacementLineage);
          await replacementLineage;
          await sidebar.updateComplete;
        }
        const primaryKeys = [parentKey, first.key];
        expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual(primaryKeys);
        expect(sidebar.sessionData.loadingChildSessionKeys.has(parentKey)).toBe(true);

        childRead.resolve(listed);
        await children;
        await sidebar.updateComplete;
        expect(
          sidebar.sessionData.childSessionRowsByParent[parentKey]?.map((row) => row.key),
        ).toEqual(reentrant ? [first.key] : [first.key, second.key]);
        if (!reentrant) {
          expect(
            sidebar.querySelector(`[data-session-key="${second.key}"]`)?.textContent,
          ).toContain(second.label);
        }
        expect(sidebar.querySelector(`[data-session-key="${first.key}"]`)?.textContent).toContain(
          first.label,
        );
        expect(sidebar.sessionKey).toBe(returnToFirst ? first.key : second.key);
        expect(sessions.state.result?.sessions.find((row) => row.key === first.key)).toMatchObject(
          reentrant ? refreshedFirst : first,
        );
        if (reentrant) {
          expect(request).toHaveBeenCalledWith("sessions.describe", { key: second.key });
          expect(sidebar.sessionData.activeSessionLineageSelectedRow?.key).not.toBe(first.key);
          expect(sessions.state.result?.sessions).toHaveLength(primaryKeys.length);
        } else {
          expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual(primaryKeys);
          expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual(
            primaryKeys,
          );
        }
        expect(unexpectedMethods).toEqual([]);
      } finally {
        stopReentry();
        provider.remove();
        sessions.dispose();
        childRead.resolve(listed);
        secondDescribe.resolve({ session: second });
        await Promise.allSettled(pending);
        await sidebar.updateComplete;
      }
    },
  );

  it.each(
    [10, null].flatMap((updatedAt) =>
      [false, true].map((firstPageLoaded) => ({ firstPageLoaded, updatedAt })),
    ),
  )(
    "keeps a nonselected child's managed observation after paging (first page loaded: $firstPageLoaded, updatedAt: $updatedAt)",
    async ({ firstPageLoaded, updatedAt }) => {
      const parentKey = "agent:main:managed-parent";
      const children = Array.from({ length: 101 }, (_, index) => ({
        key: `agent:worker:managed-child-${index}`,
        sessionId: `managed-child-session-${index}`,
        kind: "direct" as const,
        spawnedBy: parentKey,
        label: `Previous child ${index}`,
        status: "done" as const,
        hasActiveRun: false,
        runtimeMs: 100,
        updatedAt,
      }));
      const child = children[0]!;
      const fresh = {
        ...child,
        label: "Accepted managed child",
        status: "running" as const,
        hasActiveRun: true,
        runtimeMs: 400,
      };
      const parent = {
        key: parentKey,
        sessionId: "managed-parent-session",
        kind: "direct" as const,
        updatedAt: 1,
        childSessions: children.map((row) => row.key),
      };
      const firstPage = deferred<SessionsListResult>();
      const secondPage = deferred<SessionsListResult>();
      const page = (offset: number): SessionsListResult => ({
        ...sessionsResult(children.slice(offset, offset + 100), 10),
        offset,
        totalCount: children.length,
        hasMore: offset === 0,
        nextOffset: offset === 0 ? 100 : null,
      });
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
      const gateway = createGateway(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(gateway);
      await sessions.refresh({ agentId: "main", force: true });
      const { sidebar, provider, context } = await mountSidebar(gateway, sessions, "panel", {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }, { id: "worker" }],
      });
      const query = sessionsPageListQuery(context, {
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
        childLoad = sidebar.sessionData.loadChildSessions(parentKey);
        sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")!.click();
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith(
            "sessions.list",
            expect.objectContaining({ spawnedBy: parentKey, limit: 100 }),
          ),
        );
        const primary = sessions.state.result;
        const canonicalRevision = sessions.canonicalListRevision;
        if (firstPageLoaded) {
          firstPage.resolve(page(0));
          await waitForFast(() =>
            expect(request).toHaveBeenCalledWith(
              "sessions.list",
              expect.objectContaining({ spawnedBy: parentKey, offset: 100 }),
            ),
          );
        }
        await sessions.refreshList({ ...query, force: true });
        expect(sessions.listSnapshot(query).result?.sessions).toEqual([fresh]);
        expect(sessions.canonicalListRevision).toBe(canonicalRevision);
        expect(sessions.state.result).toBe(primary);
        expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
          parentKey,
        ]);
        firstPage.resolve(page(0));
        secondPage.resolve(page(100));
        await childLoad;
        await sidebar.updateComplete;
        expect(
          sidebar.sessionData.childSessionRowsByParent[parentKey]?.map((row) => row.key),
        ).toEqual(children.map((row) => row.key));
        expect
          .soft(sidebar.querySelector(`[data-session-key="${child.key}"]`)?.textContent)
          .toContain(fresh.label);
        expect.soft(sidebar.findSidebarHovercardRowByKey(child.key)).toMatchObject(fresh);
        expect(
          sidebar
            .querySelector("[data-child-session-toggle]")
            ?.classList.contains("sidebar-child-session-toggle--running"),
        ).toBe(true);
        expect(sessions.state.result).toBe(primary);
      } finally {
        unsubscribe();
        provider.remove();
        sessions.dispose();
        firstPage.resolve(page(0));
        secondPage.resolve(page(100));
        await childLoad;
        await sidebar.updateComplete;
      }
    },
  );

  it.each(
    [10, null].flatMap((updatedAt) =>
      ([1, 2] as const).map((selectedPage) => ({ selectedPage, updatedAt })),
    ),
  )(
    "orders child page $selectedPage against an intervening history read (updatedAt: $updatedAt)",
    async ({ selectedPage, updatedAt }) => {
      const parentKey = "agent:main:paged-parent";
      const key = "agent:main:paged-child";
      const placement = (status: "available" | "offline") => ({
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
        runner: { kind: "device" as const, status },
      });
      const selected: GatewaySessionRow = {
        key,
        sessionId: "paged-child-session",
        kind: "direct",
        spawnedBy: parentKey,
        label: "Child page descriptor",
        status: "done",
        updatedAt,
        placement: placement("available"),
      };
      const siblings = Array.from({ length: 100 }, (_, index) => ({
        ...selected,
        key: `agent:main:paged-sibling-${index}`,
        sessionId: `paged-sibling-session-${index}`,
        label: `Sibling ${index}`,
      }));
      const parent = {
        key: parentKey,
        sessionId: "paged-parent-session",
        kind: "direct" as const,
        updatedAt: 1,
        childSessions: [key, ...siblings.map((row) => row.key)],
      };
      const historyRow = {
        ...selected,
        label: "History descriptor",
        placement: placement("offline"),
      };
      const firstRows = selectedPage === 1 ? [selected, ...siblings.slice(0, 99)] : siblings;
      const lastRows = selectedPage === 1 ? [siblings[99]!] : [selected];
      const firstPage = deferred<SessionsListResult>();
      const historyRead = deferred<{ messages: unknown[]; sessionInfo: GatewaySessionRow }>();
      const page = (rows: GatewaySessionRow[], offset: number): SessionsListResult => ({
        ...sessionsResult(rows, 10),
        offset,
        totalCount: 101,
        hasMore: offset === 0,
        nextOffset: offset === 0 ? 100 : null,
      });
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
      const client = createTestGatewayClient(request);
      const gateway = createGateway(client);
      const sessions = createTestSessionCapability(gateway);
      await sessions.refresh({ agentId: "main", force: true });
      const { sidebar, provider } = await mountSidebar(gateway, sessions);
      const { state } = createTestChatPane({ client, sessions });
      state.sessionKey = key;
      state.sessionsResult = sessions.state.result;
      state.sessionsResultAgentId = sessions.state.agentId;
      const pending: Promise<unknown>[] = [];
      try {
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = key;
        pending.push(sidebar.sessionData.loadActiveSessionLineage(key));
        const children = sidebar.sessionData.loadChildSessions(parentKey);
        pending.push(children);
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith(
            "sessions.list",
            expect.objectContaining({ spawnedBy: parentKey, limit: 100 }),
          ),
        );
        const canonicalRevision = sessions.canonicalListRevision;
        const loaded = refreshPageChat(state, {
          historyLoad: loadChatHistory(state, { deferBranches: true }),
          awaitHistory: true,
          scheduleScroll: false,
        });
        pending.push(loaded);
        historyRead.resolve({ messages: [], sessionInfo: historyRow });
        await loaded;
        expect(sessions.state.result?.sessions.find((row) => row.key === key)?.label).toBe(
          historyRow.label,
        );
        expect(sessions.canonicalListRevision).toBe(canonicalRevision);
        firstPage.resolve(page(firstRows, 0));
        await children;
        await sidebar.updateComplete;
        expect(
          request.mock.calls
            .filter(
              ([method, params]) =>
                method === "sessions.list" &&
                (params as { spawnedBy?: string }).spawnedBy === parentKey,
            )
            .map(([, params]) => (params as { offset?: number }).offset ?? 0),
        ).toEqual([0, 100]);
        expect(sidebar.sessionData.childSessionRowsByParent[parentKey]).toHaveLength(101);
        const expected = selectedPage === 1 ? historyRow : selected;
        expect(sessions.state.result?.sessions.find((row) => row.key === key)).toMatchObject({
          label: expected.label,
          placement: expected.placement,
        });
        expect(sidebar.querySelector(`[data-session-key="${key}"]`)?.textContent).toContain(
          expected.label,
        );
      } finally {
        provider.remove();
        sessions.dispose();
        firstPage.resolve(page(firstRows, 0));
        historyRead.resolve({ messages: [], sessionInfo: historyRow });
        await Promise.allSettled(pending);
        await sidebar.updateComplete;
      }
    },
  );

  it.each([
    { retained: false, historyFirst: false },
    { retained: true, historyFirst: false },
    { retained: false, historyFirst: true },
  ])(
    "adopts accepted history after rejected child reads in a filtered view (retained: $retained, history first: $historyFirst)",
    async ({ retained, historyFirst }) => {
      const parentKey = "agent:main:rejected-parent";
      const key = "agent:main:rejected-child";
      const owner = { type: "human" as const, id: "ada", label: "Ada" };
      const otherOwner = { type: "human" as const, id: "bob", label: "Bob" };
      const previous = {
        key,
        sessionId: "rejected-child-session",
        kind: "direct" as const,
        spawnedBy: parentKey,
        updatedAt: 2,
        label: "Previous sidebar descriptor",
        owner: { actor: owner },
      };
      const rejected = {
        ...previous,
        updatedAt: historyFirst ? 1 : previous.updatedAt,
        label: "Rejected child descriptor",
        derivedTitle: "Rejected child title",
        lastMessagePreview: "Rejected child preview",
      };
      const fresh = { ...previous, label: "Accepted history descriptor" };
      const sibling = {
        ...previous,
        key: "agent:main:rejected-sibling",
        sessionId: "rejected-sibling-session",
        label: "Loaded sibling",
      };
      const parent = {
        key: parentKey,
        sessionId: "rejected-parent-session",
        kind: "direct" as const,
        updatedAt: 1,
        childSessions: [key, sibling.key],
        owner: { actor: owner },
      };
      const result = (rows: SessionsListResult["sessions"]): SessionsListResult => ({
        ...sessionsResult(rows, 3),
        owners: [owner, otherOwner],
      });
      const described = deferred<{ session: GatewaySessionRow }>();
      const childRead = deferred<SessionsListResult>();
      const historyRead = deferred<{ messages: unknown[]; sessionInfo: GatewaySessionRow }>();
      const request = vi.fn(async (method, params) => {
        if (method === "sessions.list") {
          const query = requireRecord(params, "sessions.list params");
          if (query.spawnedBy === parentKey) {
            return childRead.promise;
          }
          return result(
            query.ownerId
              ? [parent]
              : [
                  parent,
                  {
                    key: "agent:main:other-owner",
                    sessionId: "other-owner-session",
                    kind: "direct",
                    updatedAt: 1,
                    owner: { actor: otherOwner },
                  },
                ],
          );
        }
        if (method === "sessions.describe") {
          expect(params).toEqual({ key });
          return described.promise;
        }
        return method === "chat.history" ? historyRead.promise : {};
      });
      const client = createTestGatewayClient(request);
      const gateway = createGateway(client);
      const sessions = createTestSessionCapability(gateway);
      await sessions.refresh({ agentId: "main", force: true });
      const { sidebar, provider } = await mountSidebar(gateway, sessions);
      const { state } = createTestChatPane({ client, sessions });
      state.sessionKey = key;
      state.sessionsResult = sessions.state.result;
      state.sessionsResultAgentId = sessions.state.agentId;
      const pending: Promise<unknown>[] = [];
      const loadFreshHistory = async () => {
        const loaded = refreshPageChat(state, {
          historyLoad: loadChatHistory(state, { deferBranches: true }),
          awaitHistory: true,
          scheduleScroll: false,
        });
        pending.push(loaded);
        historyRead.resolve({ messages: [], sessionInfo: fresh });
        await loaded;
      };
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
          expect(sidebar.sessionData.sessionsLoading).toBe(false);
        });
        if (historyFirst) {
          await loadFreshHistory();
        }
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = key;
        const lineage = sidebar.sessionData.loadActiveSessionLineage(key);
        const children = sidebar.sessionData.loadChildSessions(parentKey);
        pending.push(lineage, children);
        await waitForFast(() => {
          expect(request).toHaveBeenCalledWith("sessions.describe", { key });
          expect(request).toHaveBeenCalledWith(
            "sessions.list",
            expect.objectContaining({ spawnedBy: parentKey }),
          );
        });
        if (retained) {
          described.resolve({ session: previous });
          await lineage;
          await waitForFast(() =>
            expect(sidebar.querySelector(`[data-session-key="${key}"]`)?.textContent).toContain(
              previous.label,
            ),
          );
        }
        if (!historyFirst) {
          await loadFreshHistory();
        }
        expect(sessions.state.result?.sessions.find((row) => row.key === key)).toMatchObject(fresh);
        await waitForFast(() => expect(sidebar.sessionData.sessionsLoading).toBe(false));
        expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
          parentKey,
        ]);

        childRead.resolve(result([rejected, sibling]));
        await children;
        await sidebar.updateComplete;
        expect
          .soft(sidebar.querySelector(`[data-session-key="${key}"]`)?.textContent ?? "")
          .toContain(fresh.label);
        described.resolve({ session: rejected });
        await lineage;
        await sidebar.updateComplete;
        expect
          .soft(sidebar.querySelector(`[data-session-key="${key}"]`)?.textContent ?? "")
          .toContain(fresh.label);
        expect(sidebar.querySelector(`[data-session-key="${sibling.key}"]`)?.textContent).toContain(
          sibling.label,
        );
        expect(sidebar.findSidebarHovercardRowByKey(key)).toMatchObject({
          label: fresh.label,
          lastMessagePreview: undefined,
        });
        const accepted = sessions.state.result?.sessions.find((row) => row.key === key);
        expect(accepted).toMatchObject(fresh);
        expect(accepted).not.toHaveProperty("derivedTitle");
        expect(accepted).not.toHaveProperty("lastMessagePreview");
        expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
          parentKey,
        ]);
      } finally {
        provider.remove();
        sessions.dispose();
        described.resolve({ session: rejected });
        childRead.resolve(result([rejected, sibling]));
        historyRead.resolve({ messages: [], sessionInfo: fresh });
        await Promise.allSettled(pending);
        await sidebar.updateComplete;
      }
    },
  );
  it.each([
    ...[4, null].flatMap((updatedAt) =>
      [
        { first: "filtered list", primaryListed: false },
        { first: "describe", primaryListed: false },
        { first: "describe", primaryListed: true },
      ].map(({ first, primaryListed }) => ({
        first,
        primaryListed,
        updatedAt,
        differentParents: false,
      })),
    ),
    ...["filtered list", "describe"].map((first) => ({
      first,
      primaryListed: false,
      updatedAt: 4,
      differentParents: true,
    })),
    { first: "filtered list", primaryListed: true, updatedAt: 4, differentParents: true },
  ])(
    "uses the later selected-row read while ancestry waits ($first issued first, updatedAt: $updatedAt, primary listed: $primaryListed, different parents: $differentParents)",
    async ({ first, updatedAt, primaryListed, differentParents }) => {
      const key = "agent:main:observed-child";
      const parentKey = "agent:main:observed-parent";
      const describedParentKey = differentParents ? "agent:main:described-parent" : parentKey;
      const owner = { type: "human" as const, id: "ada", label: "Ada" };
      const otherOwner = { type: "human" as const, id: "bob", label: "Bob" };
      const parent = {
        key: parentKey,
        sessionId: "observed-parent-session",
        kind: "direct" as const,
        updatedAt: 1,
        owner: { actor: owner },
      };
      const describedParent = {
        ...parent,
        key: describedParentKey,
        sessionId: differentParents ? "described-parent-session" : parent.sessionId,
      };
      const described = {
        key,
        sessionId: "observed-child-session",
        kind: "direct" as const,
        spawnedBy: describedParentKey,
        label: "Described selected child",
        updatedAt,
        owner: { actor: owner },
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
      const filtered = {
        ...described,
        spawnedBy: parentKey,
        label: "Filtered selected child",
        placement: {
          ...described.placement,
          runner: { kind: "device" as const, status: "offline" as const },
        },
      };
      const initial = {
        key: "agent:main:initial-ada",
        sessionId: "initial-ada-session",
        kind: "direct" as const,
        updatedAt: 1,
        owner: { actor: owner },
      };
      const other = {
        ...initial,
        key: "agent:main:initial-bob",
        sessionId: "initial-bob-session",
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
      const gateway = createGateway(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(gateway);
      await sessions.refresh({ agentId: "main", force: true });
      const { sidebar, provider } = await mountSidebar(gateway, sessions);
      let lineage: Promise<void> | undefined;
      let refresh: Promise<void> | undefined;
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
          expect(sidebar.sessionData.sessionsLoading).toBe(false);
          expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
            initial.key,
          ]);
        });
        holdFiltered = true;
        if (first === "filtered list") {
          refresh = sidebar.sessionData.refreshSidebarSessions();
          await waitForFast(() => expect(heldReads).toBe(1));
        }
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = key;
        lineage = sidebar.sessionData.loadActiveSessionLineage(key);
        await waitForFast(() => expect(request).toHaveBeenCalledWith("sessions.describe", { key }));
        selectedRead.resolve({ session: described });
        if (primaryListed && differentParents) {
          parentRead.resolve({ session: describedParent });
          await waitForFast(() =>
            expect(
              sidebar.querySelector(`[data-session-key="${describedParentKey}"]`),
            ).not.toBeNull(),
          );
        }
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith("sessions.describe", { key: describedParentKey }),
        );
        expect(
          request.mock.calls.filter(
            ([method, params]) =>
              method === "sessions.describe" && (params as { key: string }).key === key,
          ),
        ).toHaveLength(1);
        if (first === "describe") {
          refresh = sidebar.sessionData.refreshSidebarSessions();
          await waitForFast(() => expect(heldReads).toBe(1));
        }
        filteredRead.resolve(result([parent, filtered]));
        await refresh;
        const expected = first === "filtered list" ? described : filtered;
        expect(
          sidebar.sessionData.sessionsResult?.sessions.find((row) => row.key === key)?.label,
        ).toBe(expected.label);
        parentRead.resolve({ session: describedParent });
        await lineage;
        await sidebar.updateComplete;
        expect.soft(sessions.state.result?.sessions.find((row) => row.key === key)).toMatchObject({
          label: expected.label,
          placement: expected.placement,
        });
        expect.soft(sidebar.findSidebarSessionByKey(key)).toMatchObject({
          label: expected.label,
          placementState: expected.placement.state,
        });
        expect(sidebar.querySelector(`[data-session-key="${key}"]`)?.textContent).toContain(
          expected.label,
        );
        expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([
          parentKey,
          key,
        ]);
        expect(sidebar.querySelector(`[data-session-key="${other.key}"]`)).toBeNull();
        if (differentParents) {
          expect(sidebar.sessionData.activeSessionLineageRoot?.key).toBe(expected.spawnedBy);
          expect(
            sidebar.querySelector(`[data-session-key="${expected.spawnedBy}"]`),
          ).not.toBeNull();
        }
      } finally {
        provider.remove();
        sessions.dispose();
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
});
