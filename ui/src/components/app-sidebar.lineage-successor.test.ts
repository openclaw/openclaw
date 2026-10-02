/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult, SessionsPatchResult } from "../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { activateSessionMenuValue } from "../test-helpers/app-sidebar-menu.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { createGatewayHarness, mountSidebar } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./app-sidebar.ts";

async function mount(request: Parameters<typeof createTestGatewayClient>[0]) {
  const harness = createGatewayHarness(createTestGatewayClient(request));
  const sessions = createTestSessionCapability(harness.gateway);
  await sessions.refresh({ agentId: "main", force: true });
  return { ...(await mountSidebar(harness.gateway, sessions)), sessions, harness };
}

it.each([
  "rejected refresh",
  "introduced-read",
  "introduced-local",
  "introduced-newer-local",
  "introduced-terminal",
  "introduced-overlap",
  "introduced-event",
  "introduced-swarm",
  "metadata",
  "replacement",
  "deletion",
  "root",
])("preserves filtered membership across %s", async (mode) => {
  vi.useFakeTimers();
  const parentKey = "agent:main:parent";
  const key = "agent:main:dashboard:child";
  const otherKey = "agent:main:other-owner";
  const owner = { type: "human", id: "ada", label: "Ada" } satisfies NonNullable<
    GatewaySessionRow["owner"]
  >["actor"];
  const otherOwner = { ...owner, id: "bob", label: "Bob" };
  const metadata = mode === "metadata";
  const pending = mode !== "rejected refresh";
  const introduced = mode.startsWith("introduced");
  const overlap = mode === "introduced-overlap";
  const terminal = overlap || mode === "introduced-terminal";
  const newer = mode === "introduced-newer-local";
  const presentation = (label: string) => ({
    label: metadata ? undefined : label,
    derivedTitle: metadata ? label : undefined,
    lastMessagePreview: metadata ? `${label} preview` : undefined,
  });
  const parent: GatewaySessionRow = {
    key: parentKey,
    sessionId: "session-filtered-parent",
    kind: "direct",
    updatedAt: 1,
    childSessions: mode === "root" ? [] : [key],
    owner: { actor: owner },
  };
  const child = {
    key,
    sessionId: "session-filtered-child",
    kind: "direct",
    updatedAt: 2,
    spawnedBy: mode === "root" ? undefined : parentKey,
    label: metadata ? undefined : "Previous child",
    owner: { actor: owner },
  } satisfies GatewaySessionRow;
  const result = (rows: GatewaySessionRow[]): SessionsListResult => ({
    ...sessionsResult(rows, 3),
    owners: [owner, otherOwner],
  });
  const initialRows = introduced ? [parent] : [parent, child];
  let filtered = result(initialRows);
  const primary = result([
    parent,
    {
      key: otherKey,
      sessionId: "session-other-owner",
      kind: "direct",
      updatedAt: 1,
      owner: { actor: otherOwner },
    },
  ]);
  const children = deferred<SessionsListResult>();
  let query = deferred<SessionsListResult>();
  const markRead = deferred<SessionsPatchResult>();
  let childReads = 0,
    heldReads = 0,
    rejectedReads = 0,
    patchReads = 0;
  let hold = false,
    reject = false;
  let refresh: Promise<void> | undefined;
  let readOperation: Promise<SessionsPatchResult | null> | undefined;
  const { sidebar, provider, sessions, harness } = await mount(async (method, raw) => {
    const params = asOptionalRecord(raw);
    if (method === "sessions.patch") {
      patchReads += 1;
      return markRead.promise;
    }
    if (method === "sessions.list") {
      if (params?.spawnedBy === parentKey) {
        childReads += 1;
        return children.promise;
      }
      if (params?.ownerId === owner.id) {
        if (hold) {
          heldReads += 1;
          return query.promise;
        }
        if (reject) {
          rejectedReads += 1;
          throw new Error("Filtered session refresh unavailable");
        }
        return filtered;
      }
      return primary;
    }
    return method === "sessions.describe" ? { session: child } : {};
  });
  const canonical = () => sessions.state.result?.sessions.find((row) => row.key === key);
  const selected = () => sidebar.querySelector(`[data-session-key="${key}"]`);
  const text = () => selected()?.textContent?.replace(/\s+/g, " ").trim();
  const keys = () => sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key);
  const done = () => sidebar.querySelector(`[data-session-key="${key}"] [aria-label="Done"]`);
  try {
    await activateSessionMenuValue(sidebar, "owner:ada");
    await waitForFast(() => {
      expect(sidebar.sessionOwnerFilterId).toBe(owner.id);
      expect(sidebar.sessionData.sessionsLoading).toBe(false);
      expect(keys()).toEqual(initialRows.map((row) => row.key));
    });
    if (pending) {
      hold = true;
      refresh = sidebar.sessionData.refreshSidebarSessions();
      await waitForFast(() => expect(heldReads).toBe(1));
    }
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = key;
    await waitForFast(() =>
      expect(canonical()).toMatchObject({
        key,
        sessionId: child.sessionId,
        ...(metadata ? {} : { label: child.label }),
      }),
    );
    const refreshed: GatewaySessionRow = {
      ...child,
      updatedAt: 4,
      unread: mode === "introduced-read",
      ...presentation("Current child"),
      ...(terminal
        ? {
            hasActiveRun: true,
            status: "running",
            activeRunIds: overlap ? ["finishing-run", "remaining-run"] : ["finishing-run"],
          }
        : {}),
      ...(mode === "introduced-swarm" ? { swarmGroupId: "synthetic-group" } : {}),
    };
    filtered = result(introduced ? [parent] : [parent, refreshed]);
    reject = !pending;
    if (introduced) {
      await waitForFast(() => expect(childReads).toBe(1));
      children.resolve(result([refreshed]));
      await waitForFast(() => expect(canonical()?.label).toBe("Current child"));
      if (terminal) {
        expect(
          sessions.reconcileRunTerminal({
            sessionKeys: [key],
            runId: "finishing-run",
            status: "done",
            endedAt: 5,
          }),
        ).toBe(true);
        expect(canonical()).toMatchObject({
          status: overlap ? "running" : "done",
          activeRunIds: overlap ? ["remaining-run"] : [],
        });
      } else if (mode === "introduced-event") {
        harness.publishEvent("sessions.changed", {
          key,
          sessionId: child.sessionId,
          updatedAt: 5,
          hasActiveRun: true,
          status: "running",
          archived: false,
        });
        expect(canonical()?.status).toBe("running");
      } else if (mode === "introduced-swarm") {
        harness.publishEvent("sessions.changed", {
          swarmGroupId: "synthetic-group",
          kind: "log",
          text: "Synthetic progress",
        });
        expect(canonical()?.swarmLog).toBe("Synthetic progress");
      }
      if (newer) {
        hold = false;
        query.resolve(result([parent]));
        await refresh;
        query = deferred<SessionsListResult>();
        hold = true;
        refresh = sidebar.sessionData.refreshSidebarSessions();
        await waitForFast(() => expect(heldReads).toBe(2));
      }
      if (mode === "introduced-read") {
        readOperation = sessions.patch(
          key,
          { unread: false },
          { agentId: "main", expectedMarkedUnreadAt: null },
        );
        await waitForFast(() => expect(patchReads).toBe(1));
        expect(canonical()?.unread).toBe(false);
      } else if (mode === "introduced-local" || newer) {
        sessions.patchRowLocal(key, { thinkingLevel: "high" });
        expect(canonical()?.thinkingLevel).toBe("high");
      }
      hold = false;
      filtered = result([
        parent,
        {
          ...child,
          updatedAt: newer ? 5 : 3,
          label: newer ? "Newer query child" : "Late introduced child",
        },
      ]);
      query.resolve(filtered);
      await refresh;
      await sidebar.updateComplete;
      expect(keys()).toEqual([parentKey, key]);
      expect(text()).toContain(newer ? "Newer query child" : "Current child");
      expect(sidebar.querySelector(`[data-session-key="${otherKey}"]`)).toBeNull();
      return;
    }
    if (pending) {
      hold = false;
      query.resolve(filtered);
      await refresh;
      await sidebar.updateComplete;
      expect(selected()?.textContent).toContain("Current child");
      if (mode !== "root") {
        await waitForFast(() => expect(childReads).toBe(1));
      }
      filtered = result([
        parent,
        {
          ...refreshed,
          sessionId: mode === "replacement" ? "replacement-child" : child.sessionId,
          updatedAt: 5,
          ...presentation("Latest filtered child"),
          status: "done",
        },
      ]);
      await sidebar.sessionData.refreshSidebarSessions();
      await sidebar.updateComplete;
      expect(selected()?.textContent).toContain("Latest filtered child");
      if (mode === "deletion") {
        harness.publishEvent("sessions.changed", {
          key,
          sessionId: child.sessionId,
          agentId: "main",
          reason: "delete",
        });
        await sidebar.updateComplete;
        expect(selected()).toBeNull();
      }
      const before = sessions.state.result;
      if (mode !== "root") {
        children.resolve(
          result([{ ...child, updatedAt: 3, ...presentation("Delayed child"), status: "running" }]),
        );
        await waitForFast(() =>
          expect(sidebar.sessionData.loadingChildSessionKeys.has(parentKey)).toBe(false),
        );
      }
      await sidebar.updateComplete;
      if (metadata) {
        const current = canonical();
        const expected = presentation("Latest filtered child");
        expect(current).toMatchObject({ sessionId: child.sessionId, updatedAt: 5, status: "done" });
        expect(current?.label).toBe(expected.label);
        expect(current?.derivedTitle).toBe(expected.derivedTitle);
        expect(current?.lastMessagePreview).toBe(expected.lastMessagePreview);
        expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual(
          before?.sessions.map((row) => row.key),
        );
        expect(sessions.state.result?.sessions.filter((row) => row.key !== key)).toEqual(
          before?.sessions.filter((row) => row.key !== key),
        );
      } else {
        expect(sessions.state.result).toBe(before);
      }
      if (mode === "deletion") {
        expect(selected()).toBeNull();
        expect(sidebar.sessionData.sessionsResult?.sessions.some((row) => row.key === key)).toBe(
          false,
        );
        return;
      }
      const listed = sidebar.sessionData.sessionsResult?.sessions.find((row) => row.key === key);
      expect({
        label: listed?.label,
        derivedTitle: listed?.derivedTitle,
        lastMessagePreview: listed?.lastMessagePreview,
        status: listed?.status,
      }).toStrictEqual({ ...presentation("Latest filtered child"), status: "done" });
      if (mode === "root") {
        expect(sidebar.findSidebarSessionByKey(key)?.status).toBe("done");
      } else {
        expect(done()).not.toBeNull();
      }
    } else {
      children.resolve(result([refreshed]));
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(selected()?.textContent).toContain("Current child");
      harness.publishEvent("sessions.changed", {
        sessionKey: key,
        agentId: "main",
        reason: "patch",
        spawnedBy: parentKey,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(rejectedReads).toBe(1);
      expect(sidebar.textContent).toContain("Filtered session refresh unavailable");
    }
    await waitForFast(() =>
      expect(selected()?.textContent).toContain(
        pending ? "Latest filtered child" : "Current child",
      ),
    );
    if (!pending) {
      expect(canonical()?.label).toBe("Current child");
    }
    expect(keys()).toEqual(initialRows.map((row) => row.key));
    expect(sidebar.querySelector(`[data-session-key="${otherKey}"]`)).toBeNull();
    if (pending) {
      filtered = result([parent]);
      await sidebar.sessionData.refreshSidebarSessions();
      await sidebar.updateComplete;
      expect(keys()).toEqual([parentKey]);
      expect(text()).toContain("Latest filtered child");
      expect(sidebar.findSidebarSessionByKey(key)).toMatchObject({
        sessionId: mode === "replacement" ? "replacement-child" : child.sessionId,
        label: "Latest filtered child",
        ...(metadata ? { lastMessagePreview: "Latest filtered child preview" } : {}),
      });
    }
  } finally {
    provider.remove();
    sessions.dispose();
    markRead.resolve({ ok: true, path: "", key, entry: { sessionId: child.sessionId } });
    children.resolve(result([child]));
    query.resolve(filtered);
    await refresh;
    await children.promise;
    await readOperation;
  }
});

it("retains an untimed selected descriptor after cached ancestry completes", async () => {
  const updatedAt = null;
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
  const { sidebar, provider, sessions } = await mount(request);
  let lineage: Promise<void> | undefined;
  let children: Promise<void> | undefined;
  try {
    await activateSessionMenuValue(sidebar, "owner:ada");
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
    expect(sidebar.sessionData.sessionsResult?.sessions.map((row) => row.key)).toEqual([parentKey]);
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
});
