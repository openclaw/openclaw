/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { childSessionListQuery } from "../lib/sessions/child-session-data.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
} from "../test-helpers/app-sidebar.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../test-helpers/gateway-client.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import * as sidebarAgentSessionRows from "./app-sidebar-agent-session-rows.ts";
import {
  childToggle,
  disposeRoster,
  mountRoster,
  rowElement,
} from "./app-sidebar-freshness.test-support.ts";
import { SidebarSessionProjection } from "./app-sidebar-session-projection.ts";
import "./app-sidebar.tsx";

const parentKey = "agent:main:parent";
const childKey = "agent:worker:child";
const childQuery = childSessionListQuery(parentKey);
const parentRow = { key: parentKey, kind: "direct" as const, childSessions: [childKey] };
const child = {
  key: childKey,
  spawnedBy: parentKey,
  kind: "direct" as const,
  label: "Original child",
  updatedAt: 1,
};

function result(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return { ...sessionsResult(sessions, 10), path: "" };
}

function childRequest(
  parent: GatewaySessionRow,
  list: (params: { offset?: number }) => unknown,
  other: GatewayRequestHandler = () => ({}),
): GatewayRequestHandler {
  return (method, params) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      const query = params as { spawnedBy?: string; offset?: number };
      return query?.spawnedBy ? list(query) : result([parent]);
    }
    return other(method, params);
  };
}

async function mountChildren(...args: Parameters<typeof childRequest>) {
  return mountRoster(childRequest(...args));
}

function expandCollapsed(sidebar: SidebarLifecycleState) {
  const toggle = childToggle(sidebar)!;
  if (toggle.getAttribute("aria-expanded") !== "true") {
    toggle.click();
  }
}

async function mountParent() {
  const harness = createSessionsHarness("main", [parentKey]);
  const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
  // Baseline the existing child before mounting; publishing it later now auto-expands.
  harness.publishList({ result: result([parentRow]) });
  const { sidebar } = await mountSidebar(gatewayHarness.gateway, harness.sessions);
  const data = sidebar.sessionData;
  await sidebar.updateComplete;
  const expand = () => childToggle(sidebar)!.click();
  const publishChildChanged = async (delay = 5_000) => {
    gatewayHarness.publishEvent("sessions.changed", {
      sessionKey: childKey,
      agentId: "worker",
      reason: "patch",
      spawnedBy: parentKey,
    });
    await vi.advanceTimersByTimeAsync(delay);
  };
  const retry = async (row = child) => {
    harness.list.mockResolvedValueOnce(result([row]));
    data.retryChildSessions(parentKey);
    await vi.advanceTimersByTimeAsync(0);
    await sidebar.updateComplete;
    expect(sidebar.textContent).toContain(row.label);
    expect(data.childSessionErrorsByParent.has(parentKey)).toBe(false);
  };
  return { harness, sidebar, data, publishChildChanged, expand, retry };
}

it("hydrates a connection replacement while an old child page is pending", async () => {
  const children = Array.from({ length: 101 }, (_, index) => ({
    ...child,
    key: `agent:main:old-child-${index}`,
    sessionId: `old-child-${index}`,
    label: `Old child ${index}`,
  }));
  const parent = {
    ...parentRow,
    sessionId: "parent-session",
    childSessions: children.map((row) => row.key),
  };
  const tail = deferred<SessionsListResult>();
  const tailResult = {
    ...result([children[100]!]),
    totalCount: 101,
    hasMore: false,
    nextOffset: null,
  };
  const { sidebar, provider, sessions, data, harness } = await mountChildren(
    parent,
    ({ offset }) =>
      offset
        ? tail.promise
        : { ...result(children.slice(0, 100)), totalCount: 101, hasMore: true, nextOffset: 100 },
  );
  let oldLoad: Promise<void> | undefined;
  try {
    childToggle(sidebar)!.click();
    oldLoad = data.loadChildSessions(parentKey);
    await waitForFast(() =>
      expect(sessions.listSnapshot(childQuery).result?.sessions).toHaveLength(100),
    );
    const replacement = { ...children[0]!, label: "Replacement child", updatedAt: 30 };
    const newRequest = childRequest(
      { ...parent, label: "Replacement parent", childSessions: [replacement.key] },
      () => result([replacement]),
    );
    harness.publish({ client: createTestGatewayClient(newRequest) });
    // Wait for the replacement parent, not the old toggle awaiting retirement.
    await waitForFast(() =>
      expect(sidebar.querySelector(`[data-session-key="${parentKey}"]`)?.textContent).toContain(
        "Replacement parent",
      ),
    );
    await sidebar.updateComplete;
    const replacementToggle = childToggle(sidebar)!;
    expect(replacementToggle.getAttribute("aria-expanded")).toBe("false");
    replacementToggle.click();
    await waitForFast(() => expect(sidebar.textContent).toContain("Replacement child"));
    expect(data.loadingChildSessionKeys.has(parentKey)).toBe(false);
    tail.resolve(tailResult);
    await oldLoad;
    await sidebar.updateComplete;
    expect(sidebar.textContent).toContain("Replacement child");
  } finally {
    disposeRoster({ provider, sessions });
    tail.resolve(tailResult);
    await oldLoad;
  }
});

it("keeps a selected child query across unrelated publications", async () => {
  vi.useFakeTimers();
  const queryChildKey = "agent:main:selected-child";
  const parent = { ...parentRow, sessionId: "parent-session", childSessions: [queryChildKey] };
  let currentChild: GatewaySessionRow = {
    ...child,
    key: queryChildKey,
    sessionId: "child-session",
  };
  let runtimeSample = 0;
  const childList = vi.fn(async () => {
    currentChild = {
      ...currentChild,
      status: "running",
      hasActiveRun: true,
      runtimeMs: ++runtimeSample * 10,
    };
    return { ...result([currentChild]), totalCount: 1, hasMore: false, nextOffset: null };
  });
  const { sidebar, provider, context, sessions, data, harness } = await mountChildren(
    parent,
    childList,
    (method, params) =>
      method === "sessions.describe"
        ? { session: (params as { key?: string })?.key === parentKey ? parent : currentChild }
        : {},
  );
  const projectRows = vi.spyOn(sidebarAgentSessionRows, "projectSidebarAgentSessionRows");
  const projectSections = vi.spyOn(SidebarSessionProjection.prototype, "project");
  const bootstrapRun = vi.spyOn(context.connectionBootstrap, "run");
  sidebar.activeRouteId = "chat";
  sidebar.sessionKey = queryChildKey;
  await sidebar.updateComplete;
  expandCollapsed(sidebar);
  await waitForFast(() => expect(sidebar.textContent).toContain("Original child"));
  expect(childList).toHaveBeenCalledTimes(1);
  // The newer child list already covers the initial selected descriptor.
  await vi.advanceTimersByTimeAsync(5_000);
  expect(childList).toHaveBeenCalledTimes(1);
  await settleLitElement(sidebar);
  const childScope = data.childSessionScope;
  projectRows.mockClear();
  projectSections.mockClear();
  bootstrapRun.mockClear();

  for (let index = 0; index < 3; index++) {
    await sessions.refresh({ agentId: "main", force: true });
    await settleLitElement(sidebar);
  }
  expect(childList).toHaveBeenCalledTimes(1);
  expect(bootstrapRun.mock.calls.filter(([key]) => key === childScope)).toHaveLength(0);
  // Settled observations need at most the full projection for each render.
  expect(projectSections.mock.calls.length).toBeGreaterThan(0);
  expect(projectRows.mock.calls.length).toBeLessThanOrEqual(projectSections.mock.calls.length);
  expect(rowElement(sidebar, queryChildKey)?.textContent).toContain("Original child");

  currentChild = { ...currentChild, label: "Changed child", updatedAt: 20 };
  harness.publishEvent("sessions.changed", {
    sessionKey: queryChildKey,
    agentId: "main",
    reason: "patch",
    spawnedBy: parentKey,
  });
  await vi.advanceTimersByTimeAsync(5_000);
  await sidebar.updateComplete;
  expect(sidebar.textContent).toContain("Changed child");
  expect(childList).toHaveBeenCalledTimes(2);
  provider.remove();
  const readsBeforeDisconnect = childList.mock.calls.length;
  await data.loadChildSessions(parentKey);
  expect(childList).toHaveBeenCalledTimes(readsBeforeDisconnect);
});

it("retires collapsed child state after an event refresh finishes", async () => {
  const { harness, sidebar, data, publishChildChanged, expand } = await mountParent();
  harness.list.mockResolvedValueOnce(result([{ ...child, status: "running", hasActiveRun: true }]));
  expand();
  await waitForFast(() => expect(sidebar.textContent).toContain(child.label));
  const refresh = deferred<SessionsListResult>();
  harness.list.mockReturnValueOnce(refresh.promise);
  vi.useFakeTimers();
  try {
    await publishChildChanged();
    expect(data.loadingChildSessionKeys.has(parentKey)).toBe(true);
    expand();
    await sidebar.updateComplete;
    refresh.resolve(result([{ ...child, status: "done", hasActiveRun: false }]));
    await vi.advanceTimersByTimeAsync(0);
    harness.publishList({
      result: result([{ ...parentRow, hasActiveSubagentRun: false }]),
    });
    await settleLitElement(sidebar);
    expect(data.loadingChildSessionKeys.has(parentKey)).toBe(false);
    expect(childToggle(sidebar)?.classList.contains("sidebar-child-session-toggle--running")).toBe(
      false,
    );
    expect(harness.list).toHaveBeenCalledTimes(2);
  } finally {
    refresh.resolve(result([child]));
  }
});

it("keeps loaded children visible while a child event revalidates them", async () => {
  const { harness, sidebar, publishChildChanged, expand } = await mountParent();

  const sibling = { ...child, key: "agent:worker:sibling", label: "Removed sibling" };
  harness.list.mockResolvedValueOnce(result([child, sibling]));
  expand();
  await waitForFast(() =>
    expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2),
  );

  const refresh = deferred<SessionsListResult>();
  harness.list.mockReturnValue(refresh.promise);
  vi.useFakeTimers();
  await publishChildChanged();
  expect(harness.list).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
  await sidebar.updateComplete;
  expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2);
  expect(sidebar.querySelector(".sidebar-session-tree__loading")).toBeNull();
  expect(rowElement(sidebar, childKey)?.textContent).toContain("Original child");

  refresh.resolve(result([{ ...child, label: "Updated child", updatedAt: 20 }]));
  await waitForFast(() =>
    expect(rowElement(sidebar, childKey)?.textContent).toContain("Updated child"),
  );
  expect(sidebar.querySelectorAll(`[data-session-key="${childKey}"]`)).toHaveLength(1);
  expect(rowElement(sidebar, sibling.key)).toBeNull();
});

it.each(["shared rejection", "incomplete window"] as const)(
  "keeps a failed child query dormant until explicit retry (%s)",
  async (failure) => {
    const { harness, sidebar, publishChildChanged, expand, retry } = await mountParent();
    const sharedFailure = failure === "shared rejection";
    const message = sharedFailure ? "Shared child failure" : "kept changing";
    if (sharedFailure) {
      harness.list.mockRejectedValueOnce(new Error(message));
      const shared = harness.sessions.observeList(childQuery, () => {});
      onTestFinished(() => shared.dispose());
      await expect(shared.refresh()).rejects.toThrow(message);
    } else {
      harness.list.mockResolvedValue({ ...result([child]), totalCount: 2, hasMore: false });
    }
    expand();
    await waitForFast(() => expect(sidebar.textContent).toContain(message));
    vi.useFakeTimers();
    const reads = sharedFailure ? 1 : 4;
    expect(harness.list).toHaveBeenCalledTimes(reads);
    if (!sharedFailure) {
      await publishChildChanged();
      expect(harness.list).toHaveBeenCalledTimes(reads);
      expect(sidebar.textContent).toContain(message);
    }
    await retry();
    expect(harness.list).toHaveBeenCalledTimes(reads + 1);
  },
);

it("keeps a complete child window healthy while deletion is pending and after confirmation", async () => {
  const removed = { ...child, sessionId: "removed-child" };
  const kept = {
    ...child,
    key: "agent:worker:kept",
    sessionId: "kept-child",
    label: "Kept child",
  };
  let children = [removed, kept];
  const parent = {
    ...parentRow,
    sessionId: "parent-session",
    childSessions: children.map((row) => row.key),
  };
  const deletion = deferred<{ ok: true; deleted: boolean }>();
  const childList = vi.fn(() => ({
    ...result(children),
    totalCount: children.length,
    hasMore: false,
  }));
  const gateway = createGatewayHarness(
    createTestGatewayClient(
      childRequest(parent, childList, (method) =>
        method === "sessions.delete" ? deletion.promise : {},
      ),
    ),
  );
  const sessions = createTestSessionCapability(gateway.gateway);
  await sessions.refresh({ force: true });
  const { sidebar, provider } = await mountSidebar(gateway.gateway, sessions);
  const data = sidebar.sessionData;
  let removal: Promise<unknown> | undefined;
  try {
    childToggle(sidebar)!.click();
    await data.loadChildSessions(parentKey);
    await sidebar.updateComplete;
    expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2);
    removal = sessions.delete(removed.key, { expectedSessionId: removed.sessionId });
    childList.mockClear();
    for (const confirmed of [false, true]) {
      if (confirmed) {
        children = [kept];
        deletion.resolve({ ok: true, deleted: true });
        await removal;
      }
      await sessions.refreshList(childQuery);
      await data.loadChildSessions(parentKey);
      await sidebar.updateComplete;
      if (!confirmed) {
        expect(childList).toHaveBeenCalledOnce();
      }
      expect(data.childSessionErrorsByParent.has(parentKey)).toBe(false);
      expect(sidebar.querySelector("[data-child-session-error]")).toBeNull();
      expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(1);
      expect(sidebar.textContent).toContain(kept.label);
    }
  } finally {
    deletion.resolve({ ok: true, deleted: false });
    await removal;
    disposeRoster({ provider, sessions });
  }
});

it("retains a queued child refresh failure until explicit retry", async () => {
  const { harness, sidebar, data, publishChildChanged, expand, retry } = await mountParent();
  const initial = deferred<SessionsListResult>();
  const queued = deferred<SessionsListResult>();
  harness.list.mockReturnValueOnce(initial.promise).mockReturnValueOnce(queued.promise);
  const load = data.loadChildSessions(parentKey);
  expand();
  await sidebar.updateComplete;
  vi.useFakeTimers();
  try {
    await publishChildChanged();
    expect(harness.list).toHaveBeenCalledTimes(1);
    initial.resolve(result([child]));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.list).toHaveBeenCalledTimes(2);
    await load;
    queued.reject(new Error("Child refresh failed"));
    await vi.advanceTimersByTimeAsync(0);
    await sidebar.updateComplete;
    expect(data.childSessionErrorsByParent.get(parentKey)).toBe("Child refresh failed");
    expect(sidebar.querySelector("[data-child-session-error]")?.textContent).toContain(
      "Child refresh failed",
    );
    expect(data.loadedChildSessionKeys.has(parentKey)).toBe(false);

    await publishChildChanged(1_000);
    expect(harness.list).toHaveBeenCalledTimes(2);
    expect(data.childSessionErrorsByParent.get(parentKey)).toBe("Child refresh failed");

    await retry({ ...child, label: "Recovered child", updatedAt: 30 });
  } finally {
    initial.resolve(result([child]));
    queued.resolve(result([child]));
    await load;
  }
});
