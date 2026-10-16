/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult, SessionsPatchResult } from "../api/types.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import { activateSessionMenuValue } from "../test-helpers/app-sidebar-menu.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  findRow,
  rowElement,
  waitForRequest,
  mountRoster,
  human,
  disposeRoster,
  sessionRow,
} from "./app-sidebar-freshness.test-support.ts";
import "./app-sidebar.tsx";

const owner = human("ada", "Ada"),
  otherOwner = human("bob", "Bob");
const makeRow = (key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key,
  sessionId: `${key}-session`,
  kind: "direct",
  updatedAt: 1,
  owner: { actor: owner },
  ...fields,
});
const result = (rows: GatewaySessionRow[], ts = 3): SessionsListResult => ({
  ...sessionsResult(rows, ts),
  owners: [owner, otherOwner],
});
const other = makeRow("agent:main:other-owner", { owner: { actor: otherOwner } });
const rowKeys = (rows: GatewaySessionRow[] | undefined) => rows?.map((row) => row.key);

it.each([
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
])("preserves filtered membership across %s", async (mode) => {
  vi.useFakeTimers();
  const parentKey = "agent:main:parent";
  const key = "agent:main:dashboard:child";
  const metadata = mode === "metadata";
  const introduced = mode.startsWith("introduced");
  const overlap = mode === "introduced-overlap";
  const terminal = overlap || mode === "introduced-terminal";
  const newer = mode === "introduced-newer-local";
  const presentation = (label: string) => ({
    label: metadata ? undefined : label,
    derivedTitle: metadata ? label : undefined,
    lastMessagePreview: metadata ? `${label} preview` : undefined,
  });
  const latestTitle = "Latest filtered child";
  const latest = { ...presentation(latestTitle), status: "done" as const };
  const parent = makeRow(parentKey, { childSessions: [key] });
  const child = makeRow(key, {
    updatedAt: 2,
    spawnedBy: parentKey,
    label: metadata ? undefined : "Previous child",
  });
  const identity = { key, sessionId: child.sessionId };
  const initialRows = introduced ? [parent] : [parent, child];
  let filtered = result(initialRows);
  const primary = result([parent, other]);
  const children = deferred<SessionsListResult>();
  let query = deferred<SessionsListResult>();
  const markRead = deferred<SessionsPatchResult>();
  const reads = { children: 0, held: 0, patch: 0 };
  let hold = false;
  let refresh: Promise<void> | undefined;
  let readOperation: Promise<SessionsPatchResult | null> | undefined;
  const { sidebar, provider, sessions, harness, data } = await mountRoster(async (method, raw) => {
    const params = asOptionalRecord(raw);
    if (method === "sessions.patch") {
      reads.patch += 1;
      return markRead.promise;
    }
    if (method !== "sessions.list") {
      return method === "sessions.describe" ? { session: child } : {};
    }
    if (params?.spawnedBy === parentKey) {
      reads.children += 1;
      return children.promise;
    }
    if (params?.ownerId !== owner.id) {
      return primary;
    }
    if (!hold) {
      return filtered;
    }
    reads.held += 1;
    return query.promise;
  });
  const canonical = () => findRow(sessions.state.result, key);
  const selected = () => rowElement(sidebar, key);
  const text = () => selected()?.textContent?.replace(/\s+/g, " ").trim();
  const keys = () => rowKeys(data.sessionsResult?.sessions);
  const done = () => sidebar.querySelector(`[data-session-key="${key}"] [aria-label="Done"]`);
  try {
    await activateSessionMenuValue(sidebar, "owner:ada");
    await waitForFast(() => {
      expect(sidebar.sessionOwnerFilterId).toBe(owner.id);
      expect(data.sessionsLoading).toBe(false);
      expect(keys()).toEqual(rowKeys(initialRows));
    });
    // Finish the initial filter request before opening the held successor read.
    await data.refreshSidebarSessions();

    hold = true;
    refresh = data.refreshSidebarSessions();
    await waitForFast(() => expect(reads.held).toBe(1));

    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = key;
    await waitForFast(() =>
      expect(canonical()).toMatchObject({
        ...identity,
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
    if (introduced) {
      await waitForFast(() => expect(reads.children).toBe(1));
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
          ...identity,
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
        refresh = data.refreshSidebarSessions();
        await waitForFast(() => expect(reads.held).toBe(2));
      }
      if (mode === "introduced-read") {
        readOperation = sessions.patch(
          key,
          { unread: false },
          { agentId: "main", expectedMarkedUnreadAt: null },
        );
        await waitForFast(() => expect(reads.patch).toBe(1));
        expect(canonical()?.unread).toBe(false);
      } else if (mode === "introduced-local" || newer) {
        sessions.patchRowLocal(key, { thinkingLevel: "high" });
        expect(canonical()?.thinkingLevel).toBe("high");
      }
      filtered = result([
        parent,
        {
          ...child,
          updatedAt: newer ? 5 : 3,
          label: newer ? "Newer query child" : "Late introduced child",
        },
      ]);
    }
    hold = false;
    query.resolve(filtered);
    await refresh;
    await settleLitElement(sidebar);
    if (introduced) {
      expect(keys()).toEqual([parentKey, key]);
      expect(text()).toContain(newer ? "Newer query child" : "Current child");
      expect(rowElement(sidebar, other.key)).toBeNull();
      return;
    }

    expect(selected()?.textContent).toContain("Current child");

    await waitForFast(() => expect(reads.children).toBe(1));

    filtered = result([
      parent,
      {
        ...refreshed,
        sessionId: mode === "replacement" ? "replacement-child" : child.sessionId,
        updatedAt: 5,
        ...latest,
      },
    ]);
    await data.refreshSidebarSessions();
    await settleLitElement(sidebar);
    expect(selected()?.textContent).toContain(latestTitle);
    if (mode === "deletion") {
      harness.publishEvent("sessions.changed", {
        ...identity,
        agentId: "main",
        reason: "delete",
      });
      await settleLitElement(sidebar);
      expect(selected()).toBeNull();
    }
    const before = sessions.state.result;

    children.resolve(
      result([{ ...child, updatedAt: 3, ...presentation("Delayed child"), status: "running" }]),
    );
    await waitForFast(() => expect(data.loadingChildSessionKeys.has(parentKey)).toBe(false));

    await settleLitElement(sidebar);
    if (metadata) {
      expect(canonical()).toMatchObject({
        sessionId: child.sessionId,
        updatedAt: 5,
        ...latest,
      });
      expect(rowKeys(sessions.state.result?.sessions)).toEqual(rowKeys(before?.sessions));
      expect(sessions.state.result?.sessions.filter((row) => row.key !== key)).toEqual(
        before?.sessions.filter((row) => row.key !== key),
      );
    } else {
      expect(sessions.state.result).toBe(before);
    }
    if (mode === "deletion") {
      expect(selected()).toBeNull();
      expect(data.sessionsResult?.sessions.some((row) => row.key === key)).toBe(false);
      return;
    }
    expect(findRow(data.sessionsResult, key)).toMatchObject(latest);
    expect(done()).not.toBeNull();

    await waitForFast(() => expect(selected()?.textContent).toContain(latestTitle));
    expect(keys()).toEqual(rowKeys(initialRows));
    expect(rowElement(sidebar, other.key)).toBeNull();

    filtered = result([parent]);
    await data.refreshSidebarSessions();
    await settleLitElement(sidebar);
    expect(keys()).toEqual([parentKey]);
    expect(text()).toContain(latestTitle);
    expect(sidebar.findSidebarSessionByKey(key)).toMatchObject({
      sessionId: mode === "replacement" ? "replacement-child" : child.sessionId,
      label: latestTitle,
      ...(metadata ? { lastMessagePreview: `${latestTitle} preview` } : {}),
    });
  } finally {
    disposeRoster({ provider, sessions });
    markRead.resolve({ ok: true, path: "", key, entry: { sessionId: child.sessionId } });
    children.resolve(result([child]));
    query.resolve(filtered);
    await refresh;
    await children.promise;
    await readOperation;
  }
});

it("retains an untimed selected descriptor after cached ancestry completes", async () => {
  const key = "agent:main:cached-child";
  const parentKey = "agent:main:cached-parent";
  const rootKey = "agent:main:cached-root";
  const parent = makeRow(parentKey, {
    parentSessionKey: rootKey,
    childSessions: [key],
  });
  const child = makeRow(key, {
    spawnedBy: parentKey,
    label: "Earlier cached descriptor",
    status: "done",
    updatedAt: null,
  });
  const ancestor = sessionRow(rootKey, "cached-root-session", { updatedAt: 1 });
  const current = { ...child, label: "Current child descriptor" };
  let filteredRows: SessionsListResult["sessions"] = [parent, child];
  const rootRead = deferred<{ session: typeof ancestor }>();
  const childRead = deferred<SessionsListResult>();
  const request = vi.fn(async (method, params) => {
    if (method === "sessions.list") {
      const query = params as { spawnedBy?: string; ownerId?: string };
      return query.spawnedBy === parentKey
        ? childRead.promise
        : result(query.ownerId ? filteredRows : [parent, other], 5);
    }
    if (method === "sessions.describe") {
      expect(params).toEqual({ key: rootKey });
      return rootRead.promise;
    }
    return {};
  });
  const { sidebar, provider, sessions, data } = await mountRoster(request);
  let lineage: Promise<void> | undefined;
  let children: Promise<void> | undefined;
  try {
    await activateSessionMenuValue(sidebar, "owner:ada");
    await waitForFast(() => {
      expect(sidebar.sessionOwnerFilterId).toBe(owner.id);
      expect(data.sessionsResult?.sessions.some((row) => row.key === key)).toBe(true);
    });
    sidebar.activeRouteId = "chat";
    sidebar.sessionKey = key;
    lineage = data.loadActiveSessionLineage(key);
    await waitForRequest(request, "sessions.describe", { key: rootKey });
    children = data.loadChildSessions(parentKey);
    childRead.resolve(result([current], 5));
    await children;
    await waitForFast(() => expect(findRow(sessions.state.result, key)?.label).toBe(current.label));
    filteredRows = [parent];
    await data.refreshSidebarSessions();
    expect(rowKeys(data.sessionsResult?.sessions)).toEqual([parentKey]);
    rootRead.resolve({ session: ancestor });
    await lineage;
    await settleLitElement(sidebar);
    expect.soft(findRow(sessions.state.result, key)?.label).toBe(current.label);
    expect(rowElement(sidebar, key)?.textContent).toContain(current.label);
  } finally {
    disposeRoster({ provider, sessions });
    rootRead.resolve({ session: ancestor });
    childRead.resolve(result([current], 5));
    await Promise.all([lineage, children]);
    await settleLitElement(sidebar);
  }
});
