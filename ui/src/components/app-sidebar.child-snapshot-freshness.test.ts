/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { childSessionListQuery } from "../lib/sessions/child-session-data.ts";
import { createTestSessionCapability } from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import * as sidebarAgentSessionRows from "./app-sidebar-agent-session-rows.ts";
import { SidebarSessionProjection } from "./app-sidebar-session-projection.ts";
import "./app-sidebar.ts";

const parentKey = "agent:main:parent";
const childKey = "agent:worker:child";
const parentRow = { key: parentKey, kind: "direct" as const, childSessions: [childKey] };
const child = {
  key: childKey,
  spawnedBy: parentKey,
  kind: "direct" as const,
  label: "Original child",
  updatedAt: 1,
};

function result(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: 10,
    path: "",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

async function mountParent() {
  const harness = createSessionsHarness("main", [parentKey]);
  const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
  const { sidebar } = await mountSidebar(gatewayHarness.gateway, harness.sessions);
  harness.publishList({ result: result([parentRow]) });
  await sidebar.updateComplete;
  const expand = () =>
    sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")!.click();
  const publishChildChanged = () =>
    gatewayHarness.publishEvent("sessions.changed", {
      sessionKey: childKey,
      agentId: "worker",
      reason: "patch",
      spawnedBy: parentKey,
    });
  const retry = async (row = child) => {
    harness.list.mockResolvedValue(result([row]));
    sidebar.sessionData.retryChildSessions(parentKey);
    await vi.advanceTimersByTimeAsync(0);
    await sidebar.updateComplete;
    expect(sidebar.textContent).toContain(row.label);
    expect(sidebar.sessionData.childSessionErrorsByParent.has(parentKey)).toBe(false);
  };
  return { harness, sidebar, publishChildChanged, expand, retry };
}

describe("sidebar child snapshot freshness", () => {
  it("hydrates a connection replacement while an old child page is pending", async () => {
    const children = Array.from({ length: 101 }, (_, index) => ({
      ...child,
      key: `agent:main:old-child-${index}`,
      sessionId: `old-child-${index}`,
      label: `Old child ${index}`,
    }));
    const parent = {
      key: parentKey,
      sessionId: "parent-session",
      kind: "direct" as const,
      childSessions: children.map((row) => row.key),
    };
    const tail = deferred<SessionsListResult>();
    const oldClient = createTestGatewayClient(async (method, params) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method !== "sessions.list") {
        return {};
      }
      const query = params as { spawnedBy?: string; offset?: number };
      if (!query.spawnedBy) {
        return result([parent]);
      }
      return query.offset
        ? tail.promise
        : { ...result(children.slice(0, 100)), totalCount: 101, hasMore: true, nextOffset: 100 };
    });
    const gatewayHarness = createGatewayHarness(oldClient);
    const sessions = createTestSessionCapability(gatewayHarness.gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const { sidebar, provider } = await mountSidebar(gatewayHarness.gateway, sessions);
    let oldLoad: Promise<void> | undefined;
    try {
      sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")!.click();
      oldLoad = sidebar.sessionData.loadChildSessions(parentKey);
      await waitForFast(() =>
        expect(
          sessions.listSnapshot(childSessionListQuery(parentKey)).result?.sessions,
        ).toHaveLength(100),
      );
      const replacement = { ...children[0]!, label: "Replacement child", updatedAt: 30 };
      const newRequest = vi.fn(async (method: string, params?: unknown) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method !== "sessions.list") {
          return {};
        }
        return (params as { spawnedBy?: string })?.spawnedBy
          ? result([replacement])
          : result([{ ...parent, childSessions: [replacement.key] }]);
      });
      gatewayHarness.publish({ client: createTestGatewayClient(newRequest) });
      // A different connection identity intentionally resets manual expansion.
      await waitForFast(() =>
        expect(sidebar.querySelector("[data-child-session-toggle]")).not.toBeNull(),
      );
      await sidebar.updateComplete;
      const replacementToggle = sidebar.querySelector<HTMLButtonElement>(
        "[data-child-session-toggle]",
      )!;
      if (replacementToggle.getAttribute("aria-expanded") !== "true") {
        replacementToggle.click();
      }
      await waitForFast(() => expect(sidebar.textContent).toContain("Replacement child"));
      expect(sidebar.sessionData.loadingChildSessionKeys.has(parentKey)).toBe(false);
      tail.resolve({
        ...result([children[100]!]),
        totalCount: 101,
        hasMore: false,
        nextOffset: null,
      });
      await oldLoad;
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Replacement child");
    } finally {
      provider.remove();
      sessions.dispose();
      tail.resolve({
        ...result([children[100]!]),
        totalCount: 101,
        hasMore: false,
        nextOffset: null,
      });
      await oldLoad;
    }
  });

  it("keeps a selected child query across unrelated publications", async () => {
    vi.useFakeTimers();
    const queryChildKey = "agent:main:selected-child";
    const parent = {
      key: parentKey,
      sessionId: "parent-session",
      kind: "direct" as const,
      childSessions: [queryChildKey],
    };
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
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        return (params as { spawnedBy?: string })?.spawnedBy ? childList() : result([parent]);
      }
      if (method === "sessions.describe") {
        return {
          session: (params as { key?: string })?.key === parentKey ? parent : currentChild,
        };
      }
      return {};
    });
    const gatewayHarness = createGatewayHarness(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gatewayHarness.gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const { sidebar, provider, context } = await mountSidebar(gatewayHarness.gateway, sessions);
    const projectRows = vi.spyOn(sidebarAgentSessionRows, "projectSidebarAgentSessionRows");
    const projectSections = vi.spyOn(SidebarSessionProjection.prototype, "project");
    const bootstrapRun = vi.spyOn(context.connectionBootstrap, "run");
    try {
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = queryChildKey;
      await sidebar.updateComplete;
      const toggle = sidebar.querySelector<HTMLButtonElement>("[data-child-session-toggle]")!;
      if (toggle.getAttribute("aria-expanded") !== "true") {
        toggle.click();
      }
      await waitForFast(() => expect(sidebar.textContent).toContain("Original child"));
      expect(childList).toHaveBeenCalledTimes(1);
      // The initial selected descriptor is a fresh read and still invalidates membership.
      await vi.advanceTimersByTimeAsync(5_000);
      const initialReads = 2;
      expect(childList).toHaveBeenCalledTimes(initialReads);
      await settleLitElement(sidebar);
      const childScope = sidebar.sessionData.childSessionScope;
      projectRows.mockClear();
      projectSections.mockClear();
      bootstrapRun.mockClear();

      for (let index = 0; index < 3; index++) {
        await sessions.refresh({ agentId: "main", force: true });
        await settleLitElement(sidebar);
      }
      expect(childList).toHaveBeenCalledTimes(initialReads);
      expect(bootstrapRun.mock.calls.filter(([key]) => key === childScope)).toHaveLength(0);
      // Settled observations need at most the full projection for each render.
      expect(projectSections.mock.calls.length).toBeGreaterThan(0);
      expect(projectRows.mock.calls.length).toBeLessThanOrEqual(projectSections.mock.calls.length);
      expect(sidebar.querySelector(`[data-session-key="${queryChildKey}"]`)?.textContent).toContain(
        "Original child",
      );

      const reconcileHistory = sessions.captureReconcile();
      reconcileHistory({
        key: "agent:main:unrelated-chat",
        sessionId: "unrelated-session",
        kind: "direct",
        label: "Unrelated history",
        updatedAt: 30,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(childList).toHaveBeenCalledTimes(initialReads);

      currentChild = { ...currentChild, label: "Changed child", updatedAt: 20 };
      gatewayHarness.publishEvent("sessions.changed", {
        sessionKey: queryChildKey,
        agentId: "main",
        reason: "patch",
        spawnedBy: parentKey,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Changed child");
      expect(childList).toHaveBeenCalledTimes(initialReads + 1);
      provider.remove();
      const readsBeforeDisconnect = childList.mock.calls.length;
      await sidebar.sessionData.loadChildSessions(parentKey);
      expect(childList).toHaveBeenCalledTimes(readsBeforeDisconnect);
    } finally {
      provider.remove();
      sessions.dispose();
      bootstrapRun.mockRestore();
      projectSections.mockRestore();
      projectRows.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retires collapsed child state after an event refresh finishes", async () => {
    const { harness, sidebar, publishChildChanged, expand } = await mountParent();
    harness.list.mockResolvedValueOnce(
      result([{ ...child, status: "running", hasActiveRun: true }]),
    );
    expand();
    await waitForFast(() => expect(sidebar.textContent).toContain(child.label));
    const refresh = deferred<SessionsListResult>();
    harness.list.mockReturnValueOnce(refresh.promise);
    vi.useFakeTimers();
    try {
      publishChildChanged();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sidebar.sessionData.loadingChildSessionKeys.has(parentKey)).toBe(true);
      expand();
      await sidebar.updateComplete;
      refresh.resolve(result([{ ...child, status: "done", hasActiveRun: false }]));
      await vi.advanceTimersByTimeAsync(0);
      harness.publishList({
        result: result([{ ...parentRow, hasActiveSubagentRun: false }]),
      });
      await sidebar.updateComplete;
      await sidebar.updateComplete;
      expect(sidebar.sessionData.loadingChildSessionKeys.has(parentKey)).toBe(false);
      expect(
        sidebar
          .querySelector("[data-child-session-toggle]")
          ?.classList.contains("sidebar-child-session-toggle--running"),
      ).toBe(false);
      expect(harness.list).toHaveBeenCalledTimes(2);
    } finally {
      refresh.resolve(result([child]));
      vi.useRealTimers();
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
    try {
      publishChildChanged();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.list).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    await sidebar.updateComplete;
    expect(sidebar.querySelectorAll(".sidebar-recent-session--child")).toHaveLength(2);
    expect(sidebar.querySelector(".sidebar-session-tree__loading")).toBeNull();
    expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)?.textContent).toContain(
      "Original child",
    );

    refresh.resolve(result([{ ...child, label: "Updated child", updatedAt: 20 }]));
    await waitForFast(() =>
      expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)?.textContent).toContain(
        "Updated child",
      ),
    );
    expect(sidebar.querySelectorAll(`[data-session-key="${childKey}"]`)).toHaveLength(1);
    // A child the server no longer lists (deleted or archived) leaves with the refresh.
    expect(sidebar.querySelector(`[data-session-key="${sibling.key}"]`)).toBeNull();
  });

  it("retries a synchronously failed retained shared query", async () => {
    const { harness, sidebar, expand, retry } = await mountParent();
    harness.list.mockRejectedValueOnce(new Error("Shared child failure"));
    const shared = harness.sessions.observeList(childSessionListQuery(parentKey), () => {});
    await expect(shared.refresh()).rejects.toThrow("Shared child failure");
    expand();
    await waitForFast(() => expect(sidebar.textContent).toContain("Shared child failure"));
    vi.useFakeTimers();
    try {
      expect(harness.list).toHaveBeenCalledTimes(1);

      await retry();
      expect(harness.list).toHaveBeenCalledTimes(2);
    } finally {
      shared.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps incomplete child windows dormant until explicit retry", async () => {
    const { harness, sidebar, publishChildChanged, expand, retry } = await mountParent();
    harness.list.mockResolvedValue({ ...result([child]), totalCount: 2, hasMore: false });
    expand();
    await waitForFast(() => expect(sidebar.textContent).toContain("kept changing"));
    expect(harness.list).toHaveBeenCalledTimes(4);
    vi.useFakeTimers();
    try {
      publishChildChanged();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.list).toHaveBeenCalledTimes(4);
      expect(sidebar.textContent).toContain("kept changing");

      await retry();
      expect(harness.list).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a queued child refresh failure until explicit retry", async () => {
    const { harness, sidebar, publishChildChanged, expand } = await mountParent();
    const initial = deferred<SessionsListResult>();
    const queued = deferred<SessionsListResult>();
    harness.list.mockReturnValueOnce(initial.promise).mockReturnValueOnce(queued.promise);
    const load = sidebar.sessionData.loadChildSessions(parentKey);
    expand();
    await sidebar.updateComplete;
    vi.useFakeTimers();
    try {
      publishChildChanged();
      await vi.advanceTimersByTimeAsync(5_000);
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
      expect(sidebar.sessionData.childSessionErrorsByParent.get(parentKey)).toBe(
        "Child refresh failed",
      );
      expect(sidebar.querySelector("[data-child-session-error]")?.textContent).toContain(
        "Child refresh failed",
      );
      expect(sidebar.sessionData.loadedChildSessionKeys.has(parentKey)).toBe(false);

      publishChildChanged();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.list).toHaveBeenCalledTimes(2);
      expect(sidebar.sessionData.childSessionErrorsByParent.get(parentKey)).toBe(
        "Child refresh failed",
      );

      harness.list.mockResolvedValueOnce(
        result([{ ...child, label: "Recovered child", updatedAt: 30 }]),
      );
      sidebar.sessionData.retryChildSessions(parentKey);
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.sessionData.childSessionErrorsByParent.has(parentKey)).toBe(false);
      expect(sidebar.textContent).toContain("Recovered child");
    } finally {
      initial.resolve(result([child]));
      queued.resolve(result([child]));
      await load;
      vi.useRealTimers();
    }
  });
});
