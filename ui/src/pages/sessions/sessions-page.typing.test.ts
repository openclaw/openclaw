/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionPatchResult } from "../../lib/sessions/patch.ts";
import {
  createSessionCapabilityHarness,
  createTestSessionCapability,
  sessionChangedEvent,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createContext,
  createGateway,
  createRenderedPage,
  reconnectPage,
} from "./sessions-page.test-support.ts";

function result(key: string): SessionsListResult {
  return sessionsResult([{ key, kind: "direct", updatedAt: 1 }], 1);
}

async function mountTypingPage(initialResult = result("agent:main:initial")) {
  const pending: Array<ReturnType<typeof createDeferred<SessionsListResult>>> = [];
  const requests: unknown[] = [];
  const request = vi.fn(async (method: string, params?: { includeUnknown?: boolean }) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    if (params?.includeUnknown !== false) {
      return result("agent:main:sidebar");
    }
    requests.push(params);
    if (requests.length === 1) {
      return initialResult;
    }
    const task = createDeferred<SessionsListResult>();
    pending.push(task);
    return task.promise;
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const connection = createGateway(client);
  const sessions = createTestSessionCapability(connection.gateway);
  const context = createContext(connection.gateway, sessions);
  let notifyScope: Parameters<ApplicationContext["agentSelection"]["subscribe"]>[0] = () =>
    undefined;
  context.agentSelection.subscribe = (listener) => {
    notifyScope = listener;
    return () => undefined;
  };
  const page = await createRenderedPage(context, initialResult);
  const input = () => page.querySelector<HTMLInputElement>(".sessions-toolbar__search input")!;
  const edit = async (value: string) => {
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
  };
  return {
    page,
    requests,
    pending,
    input,
    edit,
    client,
    connection,
    context,
    setScope(this: void, scopeId: string | null) {
      context.agentSelection.state.scopeId = scopeId;
      notifyScope(context.agentSelection.state);
    },
    async cleanup(this: void) {
      page.remove();
      sessions.dispose();
      pending.forEach((task) => task.resolve(result("cleanup")));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sessions page managed roster", () => {
  it("replaces a deep link with managed search and surfaces query errors", async () => {
    const deepLink = "agent:main:initial";
    const pending = new Map<string, ReturnType<typeof createDeferred<SessionsListResult>>>();
    const request = vi.fn(async (method: string, params?: { search?: string }) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "agent.identity.get") {
        return { name: "Assistant" };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      if (!params?.search || params.search === deepLink) {
        return result("agent:main:initial");
      }
      const task = createDeferred<SessionsListResult>();
      pending.set(params.search, task);
      return task.promise;
    });
    const { gateway } = createGateway({ request } as unknown as GatewayBrowserClient);
    const sessions = createTestSessionCapability(gateway);
    const page = await createRenderedPage(
      createContext(gateway, sessions),
      result("agent:main:initial"),
      "active",
      deepLink,
    );
    const search = async (value: string) => {
      const input = page.querySelector<HTMLInputElement>(".sessions-toolbar__search input")!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await page.updateComplete;
    };
    try {
      page.selectedSessions = new Map([["agent:main:initial", { key: "agent:main:initial" }]]);
      await search("older");
      await vi.waitFor(() => expect(pending.has("older")).toBe(true));
      expect(page.result).toBeNull();
      expect(page.selectedSessions.size).toBe(0);
      expect(page.textContent).not.toContain("No sessions match your filters.");
      await search("latest");
      pending.get("older")!.resolve(result("agent:main:older"));
      await vi.waitFor(() => expect(pending.has("latest")).toBe(true));
      expect(page.result).toBeNull();
      pending.get("latest")!.resolve(result("agent:main:latest"));
      await vi.waitFor(() => expect(page.result?.sessions[0]?.key).toBe("agent:main:latest"));
      await page.updateComplete;
      await search("failed");
      await vi.waitFor(() => expect(pending.has("failed")).toBe(true));
      pending.get("failed")!.reject(new Error("synthetic query failure"));
      await vi.waitFor(() => expect(page.textContent).toContain("synthetic query failure"));
      expect(page.textContent).not.toContain("No sessions match your filters.");
      expect(page.result).toBeNull();
    } finally {
      for (const task of pending.values()) {
        task.resolve(result("cleanup"));
      }
      page.remove();
      sessions.dispose();
    }
  });

  it("appends the next matched server page through the managed owner", async () => {
    vi.useFakeTimers();
    const rows = Array.from({ length: 57 }, (_, index) => ({
      key: `agent:main:row-${index}`,
      kind: "direct" as const,
      updatedAt: 100 - index,
    }));
    const pageResult = (offset: number): SessionsListResult => ({
      ...sessionsResult(rows.slice(offset, offset + 50), 1),
      totalCount: 57,
      hasMore: offset === 0,
      nextOffset: offset === 0 ? 50 : null,
    });
    const request = vi.fn(async (method: string, params?: { offset?: number }) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return pageResult(params?.offset ?? 0);
    });
    const { gateway } = createGateway({ request } as unknown as GatewayBrowserClient);
    const sessions = createTestSessionCapability(gateway);
    const page = await createRenderedPage(createContext(gateway, sessions), pageResult(0));
    try {
      const input = page.querySelector<HTMLInputElement>(".sessions-toolbar__search input")!;
      input.value = "server-only metadata";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(200);
      expect(request).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ search: "server-only metadata", limit: 50 }),
      );
      expect(page.result?.sessions).toHaveLength(50);
      await page.updateComplete;
      const button = (name: string) =>
        [...page.querySelectorAll<HTMLButtonElement>(".data-table-pagination button")].find(
          (entry) => entry.textContent?.trim() === name,
        )!;
      button("Load more sessions").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(page.result?.sessions).toHaveLength(57);
      expect(request).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ search: "server-only metadata", offset: 50, limit: 50 }),
      );
      await page.updateComplete;
      button("Next").click();
      await page.updateComplete;
      button("Next").click();
      await page.updateComplete;
      expect(page.textContent).toContain("agent:main:row-56");
      expect(button("Load more sessions")).toBeUndefined();
    } finally {
      page.remove();
      sessions.dispose();
    }
  });
});

describe("Sessions page typing ownership", () => {
  it.each(["click", "Escape"])(
    "retires selected rows and stale requests when clearing via %s",
    async (action) => {
      vi.useFakeTimers();
      const { page, requests, pending, input, edit, cleanup } = await mountTypingPage();
      try {
        const limit = page.querySelector<HTMLInputElement>(".session-filter-input--limit")!;
        limit.value = "25";
        limit.dispatchEvent(new Event("input", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(0);
        pending.at(-1)!.resolve(result("agent:main:limited"));
        await vi.advanceTimersByTimeAsync(0);
        await edit("older");
        await vi.advanceTimersByTimeAsync(200);
        const oldRequest = pending.at(-1)!;
        page.selectedSessions = new Map([["agent:main:limited", { key: "agent:main:limited" }]]);
        await page.updateComplete;
        input().focus();
        if (action === "click") {
          const clear = page.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]');
          expect(clear).not.toBeNull();
          clear!.click();
        } else {
          input().dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
          );
        }
        await page.updateComplete;
        expect(input().value).toBe("");
        expect(document.activeElement).toBe(input());
        expect(page.selectedSessions.size).toBe(0);
        expect(page.result).toBeNull();
        const count = requests.length;
        await vi.advanceTimersByTimeAsync(200);
        expect(requests).toHaveLength(count);
        oldRequest.resolve(result("agent:main:retired"));
        await vi.advanceTimersByTimeAsync(0);
        expect(page.textContent).not.toContain("agent:main:retired");
        expect(requests).toHaveLength(count + 1);
        expect(requests.at(-1)).not.toHaveProperty("search");
        pending.at(-1)!.resolve(result("agent:main:cleared"));
        await vi.advanceTimersByTimeAsync(0);
        expect(input().value).toBe("");
        expect(page.querySelector<HTMLInputElement>(".session-filter-input--limit")?.value).toBe(
          "25",
        );
        expect(requests.at(-1)).toMatchObject({ limit: 25 });
        expect(page.result?.sessions[0]?.key).toBe("agent:main:cleared");
      } finally {
        await cleanup();
      }
    },
  );

  it.each([
    { timing: "queued", resubscribe: true, hidden: false },
    { timing: "timer", resubscribe: false, hidden: false },
    { timing: "unsubscribed", resubscribe: true, hidden: true },
  ])(
    "retires $timing event work while unobserved and catches up on resubscribe=$resubscribe hidden=$hidden",
    async ({ timing, resubscribe, hidden }) => {
      vi.useFakeTimers();
      const visibility = vi.spyOn(document, "visibilityState", "get");
      const active = createDeferred<SessionsListResult>();
      let filteredCalls = 0;
      const request = vi.fn(async (method: string, params?: { search?: string }) => {
        expect(method).toBe("sessions.list");
        if (params?.search === "retired") {
          filteredCalls += 1;
          return filteredCalls === 1 ? active.promise : result("agent:main:updated");
        }
        return result("agent:main:sidebar");
      });
      const { sessions, emitEvent } = createSessionCapabilityHarness(
        request as unknown as GatewayBrowserClient["request"],
      );
      const query = { search: "retired", includeDerivedTitles: false };
      let unsubscribe = sessions.subscribeList(query, vi.fn());
      const updatedObserved = createDeferred();
      const loading = sessions.refreshList(query);
      try {
        if (timing !== "unsubscribed") {
          emitEvent(sessionChangedEvent("agent:main:changed"));
          if (timing === "queued") {
            await vi.advanceTimersByTimeAsync(5_000);
          }
        }
        unsubscribe();
        if (timing === "unsubscribed") {
          emitEvent(sessionChangedEvent("agent:main:changed"));
        }
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(200);
        expect(filteredCalls).toBe(1);
        if (hidden) {
          visibility.mockReturnValue("hidden");
          document.dispatchEvent(new Event("visibilitychange"));
        }
        if (resubscribe) {
          unsubscribe = sessions.subscribeList(query, (next) => {
            if (next.result?.sessions[0]?.key === "agent:main:updated") {
              updatedObserved.resolve();
            }
          });
          expect(filteredCalls).toBe(1);
        }
        active.resolve(result("agent:main:retired"));
        await loading;
        if (hidden) {
          await vi.advanceTimersByTimeAsync(1_000);
          expect(filteredCalls).toBe(1);
          visibility.mockReturnValue("visible");
          document.dispatchEvent(new Event("visibilitychange"));
          await vi.advanceTimersByTimeAsync(0);
        } else if (!resubscribe || timing === "queued") {
          await vi.advanceTimersByTimeAsync(4_999);
          expect(filteredCalls).toBe(1);
          if (resubscribe) {
            expect(sessions.listSnapshot(query).result?.sessions[0]?.key).toBe(
              "agent:main:retired",
            );
          }
          await vi.advanceTimersByTimeAsync(1);
        } else {
          await vi.advanceTimersByTimeAsync(0);
        }
        expect(filteredCalls).toBe(resubscribe ? 2 : 1);
        if (resubscribe) {
          await updatedObserved.promise;
          expect(sessions.listSnapshot(query).result?.sessions[0]?.key).toBe("agent:main:updated");
        }
      } finally {
        active.resolve(result("agent:main:retired"));
        unsubscribe();
        sessions.dispose();
        await loading;
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      }
    },
  );

  it("retains a rename refresh when search replaces an older page request", async () => {
    vi.useFakeTimers();
    const key = "agent:main:rename";
    const before = result(key);
    before.sessions[0]!.label = "Before rename";
    const after: SessionsListResult = {
      ...before,
      sessions: [{ ...before.sessions[0]!, label: "After rename", updatedAt: 2 }],
    };
    const patch = createDeferred<SessionPatchResult>();
    const older = createDeferred<SessionsListResult>();
    let pageRequests = 0;
    let mutationRefreshes = 0;
    const request = vi.fn(async (method: string, params?: { includeUnknown?: boolean }) => {
      if (method === "sessions.patch") {
        return patch.promise;
      }
      expect(method).toBe("sessions.list");
      if (params?.includeUnknown !== false) {
        mutationRefreshes += 1;
        return after;
      }
      pageRequests += 1;
      return pageRequests === 1 ? before : pageRequests === 2 ? older.promise : after;
    });
    const { gateway } = createGateway({ request } as unknown as GatewayBrowserClient);
    const sessions = createTestSessionCapability(gateway);
    const page = await createRenderedPage(createContext(gateway, sessions), before);
    try {
      page.querySelector<HTMLButtonElement>(".session-details-toggle")!.click();
      await page.updateComplete;
      const label = page.querySelector<HTMLInputElement>(".session-overrides-grid input")!;
      expect(label.disabled).toBe(false);
      label.value = "After rename";
      label.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledWith(
        "sessions.patch",
        expect.objectContaining({ key, label: "After rename" }),
      );
      [...page.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Refresh")!
        .click();
      await vi.advanceTimersByTimeAsync(0);
      expect(pageRequests).toBe(2);
      patch.resolve({ ok: true, path: "", key, entry: { sessionId: "renamed-session" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(mutationRefreshes).toBe(1);
      expect(pageRequests).toBe(2);
      expect(page.loading).toBe(true);
      const search = page.querySelector<HTMLInputElement>(".sessions-toolbar__search input")!;
      for (const value of ["n", "ne", "new"]) {
        search.value = value;
        search.dispatchEvent(new Event("input", { bubbles: true }));
        await page.updateComplete;
        await vi.advanceTimersByTimeAsync(40);
      }
      await vi.advanceTimersByTimeAsync(200);
      expect(pageRequests).toBe(2);
      older.resolve(before);
      await vi.advanceTimersByTimeAsync(0);
      expect(pageRequests).toBe(3);
      expect(request.mock.calls.findLast(([method]) => method === "sessions.list")).toEqual([
        "sessions.list",
        expect.objectContaining({
          includeUnknown: false,
          search: "new",
        }),
      ]);
      expect(page.textContent).toContain("After rename");
      expect(page.result?.sessions[0]?.label).toBe("After rename");
      expect(page.loading).toBe(false);
    } finally {
      page.remove();
      sessions.dispose();
      patch.resolve({ ok: true, path: "", key, entry: { sessionId: "renamed-session" } });
      older.resolve(before);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
  it.each(["detach", "reconnect", "client", "context"])(
    "retires pending work on %s and starts the new owner's query without the old response",
    async (retirement) => {
      vi.useFakeTimers();
      const harness = await mountTypingPage();
      const { page, input, edit, requests, pending, connection, client } = harness;
      let replacementSessions: ReturnType<typeof createTestSessionCapability> | undefined;
      try {
        await edit("older");
        await vi.advanceTimersByTimeAsync(200);
        expect(requests).toHaveLength(2);
        await edit("latest");
        if (retirement === "detach") {
          page.remove();
        } else {
          connection.emit({ phase: "reconnecting" });
        }
        await vi.advanceTimersByTimeAsync(400);
        expect(requests).toHaveLength(2);
        if (retirement === "detach") {
          reconnectPage(page);
        } else if (retirement === "context") {
          const replacement = createGateway(client);
          replacementSessions = createTestSessionCapability(replacement.gateway);
          page.context = createContext(replacement.gateway, replacementSessions);
          page.requestUpdate();
        } else {
          connection.emit({
            phase: "connected",
            client:
              retirement === "client"
                ? ({ request: client.request.bind(client) } as GatewayBrowserClient)
                : client,
          });
        }
        await page.updateComplete;
        await vi.advanceTimersByTimeAsync(0);
        expect(requests).toHaveLength(3);
        expect(requests.at(-1)).toMatchObject({ search: "latest" });
        expect(input().value).toBe("latest");
        pending[0]!.resolve(result("agent:main:retired"));
        await vi.advanceTimersByTimeAsync(0);
        expect(page.result).toBeNull();
        expect(page.loading).toBe(true);
        expect(page.textContent).not.toContain("agent:main:retired");
        await edit("newest");
        await vi.advanceTimersByTimeAsync(200);
        expect(requests).toHaveLength(3);
        pending[1]!.resolve(result("agent:main:superseded"));
        await vi.advanceTimersByTimeAsync(0);
        expect(requests).toHaveLength(4);
        expect(requests.at(-1)).toMatchObject({ search: "newest" });
        pending[2]!.resolve(result("agent:main:final"));
        await vi.advanceTimersByTimeAsync(0);
        expect(page.result?.sessions[0]?.key).toBe("agent:main:final");
      } finally {
        replacementSessions?.dispose();
        await harness.cleanup();
      }
    },
  );

  it("retains rows while loading more, then yields to the latest search", async () => {
    vi.useFakeTimers();
    const initial = {
      ...result("agent:main:initial"),
      count: 50,
      hasMore: true,
      nextOffset: 50,
      totalCount: 51,
    };
    initial.sessions = Array.from({ length: 50 }, (_, index) => ({
      key: `agent:main:row-${index}`,
      kind: "direct",
      updatedAt: index,
    }));
    const harness = await mountTypingPage(initial);
    const { page, edit, pending, requests } = harness;
    try {
      [...page.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === "Load more sessions")!
        .click();
      await vi.advanceTimersByTimeAsync(0);
      page.context = { ...harness.context };
      page.requestUpdate();
      await page.updateComplete;
      expect(requests).toHaveLength(2);
      expect(page.result?.sessions).toHaveLength(50);
      expect(page.loading).toBe(true);
      expect(requests.at(-1)).toMatchObject({ offset: 50 });
      await edit("latest");
      await vi.advanceTimersByTimeAsync(200);
      expect(requests).toHaveLength(2);
      expect(page.result).toBeNull();
      pending[0]!.resolve(result("agent:main:retired"));
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toHaveLength(3);
      expect(requests.at(-1)).toMatchObject({ search: "latest" });
      expect(requests.at(-1)).not.toHaveProperty("offset");
      expect(page.result).toBeNull();
      pending[1]!.resolve(result("agent:main:final"));
      await vi.advanceTimersByTimeAsync(0);
      expect(page.result?.sessions.map((row) => row.key)).toEqual(["agent:main:final"]);
    } finally {
      await harness.cleanup();
    }
  });
  it("coalesces scope and status edits behind a request and lets explicit filters consume debounce", async () => {
    vi.useFakeTimers();
    const harness = await mountTypingPage();
    const { page, input, edit, requests, pending, setScope } = harness;
    try {
      await edit("older");
      await vi.advanceTimersByTimeAsync(200);
      await edit("latest");
      setScope(null);
      await page.updateComplete;
      const statusGroup = page.querySelector<HTMLElement>(".sessions-view-segment")!;
      statusGroup.querySelector<HTMLInputElement>('input[value="archived"]')!.click();
      await page.updateComplete;
      statusGroup.querySelector<HTMLInputElement>('input[value="all"]')!.click();
      await page.updateComplete;
      expect(requests).toHaveLength(2);
      expect(page.result).toBeNull();
      pending[0]!.resolve(result("agent:main:retired"));
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toHaveLength(3);
      expect(requests.at(-1)).toMatchObject({ search: "latest", archived: "all" });
      expect(requests.at(-1)).not.toHaveProperty("agentId");
      expect(input().value).toBe("latest");
      pending[1]!.resolve(result("agent:research:latest"));
      await vi.advanceTimersByTimeAsync(0);
      await edit("immediate");
      setScope("research");
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toHaveLength(4);
      expect(requests.at(-1)).toMatchObject({
        search: "immediate",
        agentId: "research",
        archived: "all",
      });
    } finally {
      await harness.cleanup();
    }
  });
});

describe("Sessions page details", () => {
  beforeEach(() => vi.useFakeTimers());

  it.each([
    { entry: "interactive", closeBeforeReply: false },
    { entry: "deep-link", closeBeforeReply: false },
    { entry: "interactive", closeBeforeReply: true },
  ])(
    "loads full settings for the expanded compact row ($entry, closed: $closeBeforeReply)",
    async ({ entry, closeBeforeReply }) => {
      const row: GatewaySessionRow = {
        key: "agent:main:details",
        sessionId: "details-session",
        kind: "direct",
        updatedAt: 1,
        rowMode: "compact",
      };
      const descriptor = createDeferred<{ session: GatewaySessionRow }>();
      let description = descriptor.promise;
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.list") {
          return sessionsResult([row], 1);
        }
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method === "sessions.groups.list") {
          return { names: [], sectionOrder: [] };
        }
        if (method === "sessions.describe") {
          return description;
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const connection = createGateway(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(connection.gateway);
      const page = await createRenderedPage(
        createContext(connection.gateway, sessions),
        sessionsResult([row], 1),
        "active",
        entry === "deep-link" ? row.key : null,
      );
      const listReads = request.mock.calls.filter(([method]) => method === "sessions.list").length;
      if (entry === "interactive") {
        expect(
          request.mock.calls.filter(([method]) => method === "sessions.describe"),
        ).toHaveLength(0);
        page.querySelector<HTMLButtonElement>(".session-details-toggle")!.click();
        await page.updateComplete;
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(request.mock.calls.filter(([method]) => method === "sessions.describe")).toHaveLength(
        1,
      );
      expect(page.querySelector<HTMLSelectElement>(".session-details-panel select")?.disabled).toBe(
        true,
      );
      const held = page.result;
      if (closeBeforeReply) {
        page.querySelector<HTMLButtonElement>(".session-details-toggle")!.click();
        await page.updateComplete;
      }

      const full: GatewaySessionRow = {
        ...row,
        rowMode: undefined,
        agentRuntime: { id: "claude-cli", fallback: "none", source: "agent" },
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "high", label: "high" },
        ],
        thinkingDefault: "high",
      };
      descriptor.resolve({ session: full });
      await vi.advanceTimersByTimeAsync(0);
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(
        listReads,
      );
      if (closeBeforeReply) {
        expect(page.querySelector(".session-details-panel")).toBeNull();
        expect(page.result).toBe(held);
        return;
      }
      const thinking = page.querySelector<HTMLSelectElement>(".session-details-panel select")!;
      expect(thinking.disabled).toBe(false);
      expect([...thinking.options].map((option) => option.textContent?.trim())).toEqual([
        "Inherited: High",
        "Off",
        "High",
      ]);
      expect(page.querySelector(".session-details-panel")?.textContent).toContain(
        "claude-cli (fallback none)",
      );
      if (entry === "interactive") {
        page.querySelector<HTMLButtonElement>(".session-details-toggle")!.click();
        await page.updateComplete;
        page.querySelector<HTMLButtonElement>(".session-details-toggle")!.click();
        await page.updateComplete;
        expect(
          request.mock.calls.filter(([method]) => method === "sessions.describe"),
        ).toHaveLength(1);
        description = Promise.resolve({
          session: { ...full, updatedAt: 2, thinkingDefault: "off" },
        });
        connection.emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: { key: row.key, agentId: "main", reason: "patch" },
        });
        await vi.advanceTimersByTimeAsync(0);
        await page.updateComplete;
        expect(
          request.mock.calls.filter(([method]) => method === "sessions.describe"),
        ).toHaveLength(2);
        expect(
          page
            .querySelector<HTMLSelectElement>(".session-details-panel select")
            ?.options[0]?.textContent?.trim(),
        ).toBe("Inherited: Off");
      }
    },
  );
});
