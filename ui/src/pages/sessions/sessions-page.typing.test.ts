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
  type TestSessionsPage,
} from "./sessions-page.test-support.ts";

const cleanups: Array<() => void | Promise<void>> = [];
const advance = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const findInput = (page: ParentNode, selector: string) =>
  page.querySelector<HTMLInputElement>(selector)!;
const click = (page: ParentNode, selector: string) =>
  page.querySelector<HTMLElement>(selector)!.click();
const namedButton = (page: ParentNode, name: string) =>
  [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === name,
  );
const resolveResult = async (
  task: ReturnType<typeof createDeferred<SessionsListResult>>,
  key: string,
) => {
  task.resolve(result(key));
  await advance();
};
const editSearch = async (page: TestSessionsPage, value: string) => {
  editInput(searchInput(page), value);
  await page.updateComplete;
};
const rows = (count: number, ascending = false): GatewaySessionRow[] =>
  Array.from({ length: count }, (_, index) => ({
    key: `agent:main:row-${index}`,
    kind: "direct",
    updatedAt: ascending ? index : 100 - index,
  }));
function listRequest<P>(list: (params?: P) => unknown, methods: Record<string, () => unknown>) {
  return vi.fn(async (method: string, params?: P) => {
    if (method === "sessions.list") {
      return list(params);
    }
    if (Object.hasOwn(methods, method)) {
      return methods[method]!();
    }
    throw new Error(`Unexpected request: ${method}`);
  });
}
const subscribed = () => ({ subscribed: true });

async function mountPage(
  client: GatewayBrowserClient,
  initial: SessionsListResult,
  deepLink: string | null = null,
) {
  const connection = createGateway(client);
  const sessions = createTestSessionCapability(connection.gateway);
  const context = createContext(connection.gateway, sessions);
  const page = await createRenderedPage(context, initial, "active", deepLink);
  cleanups.push(() => {
    page.remove();
    sessions.dispose();
  });
  return { connection, sessions, context, page };
}

function result(key: string): SessionsListResult {
  return sessionsResult([{ key, kind: "direct", updatedAt: 1 }], 1);
}

function editInput(input: HTMLInputElement, value: string, event = "input") {
  input.value = value;
  input.dispatchEvent(new Event(event, { bubbles: true }));
}

const searchInput = (page: ParentNode) =>
  page.querySelector<HTMLInputElement>(".sessions-filter-popover__search input")!;

async function mountTypingPage(initialResult = result("agent:main:initial")) {
  const pending: Array<ReturnType<typeof createDeferred<SessionsListResult>>> = [];
  const requests: unknown[] = [];
  const request = listRequest(
    (params?: { includeUnknown?: boolean }) => {
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
    },
    { "sessions.subscribe": subscribed },
  );
  const client = { request } as unknown as GatewayBrowserClient;
  let notifyScope: Parameters<ApplicationContext["agentSelection"]["subscribe"]>[0] = () =>
    undefined;
  const connection = createGateway(client);
  const sessions = createTestSessionCapability(connection.gateway);
  const context = createContext(connection.gateway, sessions);
  context.agentSelection.subscribe = (listener) => {
    notifyScope = listener;
    return () => undefined;
  };
  const page = await createRenderedPage(context, initialResult);
  const input = () => searchInput(page);
  cleanups.push(async () => {
    page.remove();
    sessions.dispose();
    pending.forEach((task) => task.resolve(result("cleanup")));
    await advance();
    expect(vi.getTimerCount()).toBe(0);
  });
  return {
    page,
    requests,
    pending,
    input,
    edit: (value: string) => editSearch(page, value),
    client,
    connection,
    context,
    setScope(this: void, scopeId: string | null) {
      context.agentSelection.state.scopeId = scopeId;
      notifyScope(context.agentSelection.state);
    },
  };
}

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  } finally {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("sessions page managed roster", () => {
  it("replaces a deep link with managed search and surfaces query errors", async () => {
    const deepLink = "agent:main:initial";
    const pending = new Map<string, ReturnType<typeof createDeferred<SessionsListResult>>>();
    const request = listRequest(
      (params?: { search?: string }) => {
        if (!params?.search || params.search === deepLink) {
          return result("agent:main:initial");
        }
        const task = createDeferred<SessionsListResult>();
        pending.set(params.search, task);
        return task.promise;
      },
      { "sessions.subscribe": subscribed, "agent.identity.get": () => ({ name: "Assistant" }) },
    );
    const { page } = await mountPage(
      { request } as unknown as GatewayBrowserClient,
      result(deepLink),
      deepLink,
    );
    cleanups.push(() => {
      for (const task of pending.values()) {
        task.resolve(result("cleanup"));
      }
    });
    const search = (value: string) => editSearch(page, value);
    page.selectedSessions = new Map([[deepLink, { key: deepLink }]]);
    await search("older");
    await vi.waitFor(() => expect(pending.has("older")).toBe(true));
    expect([page.result, page.selectedSessions.size]).toEqual([null, 0]);
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
  });

  it("appends the next matched server page through the managed owner", async () => {
    vi.useFakeTimers();
    const pageResult = (offset: number): SessionsListResult => ({
      ...sessionsResult(rows(57).slice(offset, offset + 50), 1),
      totalCount: 57,
      hasMore: offset === 0,
      nextOffset: offset === 0 ? 50 : null,
    });
    const request = listRequest((params?: { offset?: number }) => pageResult(params?.offset ?? 0), {
      "sessions.subscribe": subscribed,
    });
    const { page } = await mountPage({ request } as unknown as GatewayBrowserClient, pageResult(0));
    editInput(searchInput(page), "server-only metadata");
    await advance(200);
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ search: "server-only metadata", limit: 50 }),
    );
    expect(page.result?.sessions).toHaveLength(50);
    await page.updateComplete;
    const button = (name: string) =>
      namedButton(page.querySelector(".data-table-pagination")!, name)!;
    button("Load more sessions").click();
    await advance();
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
  });
});

describe("Sessions page typing and detail ownership", () => {
  beforeEach(() => vi.useFakeTimers());
  it.each(["click", "Escape"])(
    "retires selected rows and stale requests when clearing via %s",
    async (action) => {
      const { page, requests, pending, input, edit } = await mountTypingPage();
      click(page, ".sessions-filter-popover__trigger");
      const limit = findInput(page, ".session-filter-input--limit");
      editInput(limit, "25");
      await advance();
      await resolveResult(pending.at(-1)!, "agent:main:limited");
      page.selectedSessions = new Map([["agent:main:limited", { key: "agent:main:limited" }]]);
      await edit("older");
      await advance(200);
      const oldRequest = pending.at(-1)!;
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
      expect(document.activeElement).toBe(input());
      expect([input().value, page.selectedSessions.size, page.result]).toEqual(["", 0, null]);
      const count = requests.length;
      await advance(200);
      expect(requests).toHaveLength(count);
      await resolveResult(oldRequest, "agent:main:retired");
      expect(page.textContent).not.toContain("agent:main:retired");
      expect(requests).toHaveLength(count + 1);
      expect(requests.at(-1)).not.toHaveProperty("search");
      await resolveResult(pending.at(-1)!, "agent:main:cleared");
      expect(input().value).toBe("");
      expect(findInput(page, ".session-filter-input--limit").value).toBe("25");
      expect(requests.at(-1)).toMatchObject({ limit: 25 });
      expect(page.result?.sessions[0]?.key).toBe("agent:main:cleared");
    },
  );

  it.each(
    [
      { timing: "queued", resubscribe: true, hidden: false },
      { timing: "timer", resubscribe: false, hidden: false },
      { timing: "unsubscribed", resubscribe: true, hidden: true },
    ].flatMap((scenario) => [
      { ...scenario, reason: "update" },
      { ...scenario, reason: "create" },
    ]),
  )(
    "retires $timing $reason event work while unobserved and catches up on resubscribe=$resubscribe hidden=$hidden",
    async ({ timing, resubscribe, hidden, reason }) => {
      const visibility = vi.spyOn(document, "visibilityState", "get");
      const setVisibility = (state: DocumentVisibilityState) => {
        visibility.mockReturnValue(state);
        document.dispatchEvent(new Event("visibilitychange"));
      };
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
      const changed = sessionChangedEvent("agent:main:changed");
      changed.payload = { ...(changed.payload as Record<string, unknown>), reason };
      const snapshotKey = () => sessions.listSnapshot(query).result?.sessions[0]?.key;
      cleanups.push(async () => {
        active.resolve(result("agent:main:retired"));
        unsubscribe();
        sessions.dispose();
        await loading;
        expect(vi.getTimerCount()).toBe(0);
      });
      if (timing !== "unsubscribed") {
        emitEvent(changed);
        if (timing === "queued") {
          await advance(5_000);
        }
      }
      unsubscribe();
      if (timing === "unsubscribed") {
        emitEvent(changed);
      }
      setVisibility("hidden");
      setVisibility("visible");
      await advance(200);
      expect(filteredCalls).toBe(1);
      if (hidden) {
        setVisibility("hidden");
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
        await advance(1_000);
        expect(filteredCalls).toBe(1);
        setVisibility("visible");
        await advance();
      } else if (!resubscribe || timing === "queued") {
        await advance(4_999);
        expect(filteredCalls).toBe(1);
        if (resubscribe) {
          expect(snapshotKey()).toBe("agent:main:retired");
        }
        await advance(1);
      } else {
        await advance();
      }
      expect(filteredCalls).toBe(resubscribe ? 2 : 1);
      if (resubscribe) {
        await updatedObserved.promise;
        expect(snapshotKey()).toBe("agent:main:updated");
      }
    },
  );

  it("retains a rename refresh when search replaces an older page request", async () => {
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
    const { page, sessions } = await mountPage(
      { request } as unknown as GatewayBrowserClient,
      before,
    );
    const finishPatch = () =>
      patch.resolve({ ok: true, path: "", key, entry: { sessionId: "renamed-session" } });
    cleanups.push(async () => {
      page.remove();
      sessions.dispose();
      finishPatch();
      older.resolve(before);
      await advance();
      expect(vi.getTimerCount()).toBe(0);
    });
    click(page, ".session-details-toggle");
    await page.updateComplete;
    const label = findInput(page, ".session-overrides-grid input");
    expect(label.disabled).toBe(false);
    editInput(label, "After rename", "change");
    await advance();
    expect(request).toHaveBeenCalledWith(
      "sessions.patch",
      expect.objectContaining({ key, label: "After rename" }),
    );
    click(page, ".sessions-toolbar__refresh");
    await advance();
    expect(pageRequests).toBe(2);
    finishPatch();
    await advance();
    expect([mutationRefreshes, pageRequests, page.loading]).toEqual([1, 2, true]);
    const search = searchInput(page);
    for (const value of ["n", "ne", "new"]) {
      editInput(search, value);
      await page.updateComplete;
      await advance(40);
    }
    await advance(200);
    expect(pageRequests).toBe(2);
    older.resolve(before);
    await advance();
    expect(pageRequests).toBe(3);
    expect(request.mock.calls.findLast(([method]) => method === "sessions.list")).toEqual([
      "sessions.list",
      expect.objectContaining({ includeUnknown: false, search: "new" }),
    ]);
    expect(page.textContent).toContain("After rename");
    expect([page.result?.sessions[0]?.label, page.loading]).toEqual(["After rename", false]);
  });
  it.each(["detach", "reconnect", "client"])(
    "retires pending work on %s and starts the new owner's query without the old response",
    async (retirement) => {
      const { page, input, edit, requests, pending, connection, client } = await mountTypingPage();
      await edit("older");
      await advance(200);
      expect(requests).toHaveLength(2);
      await edit("latest");
      if (retirement === "detach") {
        page.remove();
      } else {
        connection.emit({ phase: "reconnecting" });
      }
      await advance(400);
      expect(requests).toHaveLength(2);
      if (retirement === "detach") {
        await resolveResult(pending[0]!, "agent:main:retired");
        expect([requests.length, page.isConnected]).toEqual([2, false]);
        return;
      }
      connection.emit({
        phase: "connected",
        client:
          retirement === "client"
            ? ({ request: client.request.bind(client) } as GatewayBrowserClient)
            : client,
      });
      await page.updateComplete;
      await advance();
      expect(requests).toHaveLength(3);
      expect(requests.at(-1)).toMatchObject({ search: "latest" });
      expect(input().value).toBe("latest");
      await resolveResult(pending[0]!, "agent:main:retired");
      expect([page.result, page.loading]).toEqual([null, true]);
      expect(page.textContent).not.toContain("agent:main:retired");
      await edit("newest");
      await advance(200);
      expect(requests).toHaveLength(3);
      await resolveResult(pending[1]!, "agent:main:superseded");
      expect(requests).toHaveLength(4);
      expect(requests.at(-1)).toMatchObject({ search: "newest" });
      await resolveResult(pending[2]!, "agent:main:final");
      expect(page.result?.sessions[0]?.key).toBe("agent:main:final");
    },
  );

  it("retains rows while loading more, then yields to the latest search", async () => {
    const initial = {
      ...result("agent:main:initial"),
      count: 50,
      hasMore: true,
      nextOffset: 50,
      totalCount: 51,
    };
    initial.sessions = rows(50, true);
    const { page, edit, pending, requests } = await mountTypingPage(initial);
    namedButton(page, "Load more sessions")!.click();
    await advance();
    await page.updateComplete;
    expect([requests.length, page.result?.sessions.length, page.loading]).toEqual([2, 50, true]);
    expect(requests.at(-1)).toMatchObject({ offset: 50 });
    await edit("latest");
    await advance(200);
    expect([requests.length, page.result]).toEqual([2, null]);
    await resolveResult(pending[0]!, "agent:main:retired");
    expect(requests).toHaveLength(3);
    expect(requests.at(-1)).toMatchObject({ search: "latest" });
    expect(requests.at(-1)).not.toHaveProperty("offset");
    expect(page.result).toBeNull();
    await resolveResult(pending[1]!, "agent:main:final");
    expect(page.result?.sessions.map((row) => row.key)).toEqual(["agent:main:final"]);
  });
  it("coalesces scope and status edits behind a request and lets explicit filters consume debounce", async () => {
    const { page, input, edit, requests, pending, setScope } = await mountTypingPage();
    await edit("older");
    await advance(200);
    await edit("latest");
    setScope(null);
    await page.updateComplete;
    const statusGroup = page.querySelector<HTMLElement>(".sessions-view-segment")!;
    statusGroup.querySelector<HTMLInputElement>('input[value="archived"]')!.click();
    await page.updateComplete;
    statusGroup.querySelector<HTMLInputElement>('input[value="all"]')!.click();
    await page.updateComplete;
    expect([requests.length, page.result]).toEqual([2, null]);
    await resolveResult(pending[0]!, "agent:main:retired");
    expect(requests).toHaveLength(3);
    expect(requests.at(-1)).toMatchObject({ search: "latest", archived: "all" });
    expect(requests.at(-1)).not.toHaveProperty("agentId");
    expect(input().value).toBe("latest");
    await resolveResult(pending[1]!, "agent:research:latest");
    await edit("immediate");
    setScope("research");
    await advance();
    expect(requests).toHaveLength(4);
    expect(requests.at(-1)).toMatchObject({
      search: "immediate",
      agentId: "research",
      archived: "all",
    });
  });
  it.each([
    { entry: "interactive", closeBeforeReply: false },
    { entry: "deep-link", closeBeforeReply: false },
    { entry: "interactive", closeBeforeReply: true },
  ])(
    "loads full settings for the expanded compact row ($entry, closed: $closeBeforeReply)",
    async ({ entry, closeBeforeReply }) => {
      const row: GatewaySessionRow = {
        ...result("agent:main:details").sessions[0]!,
        sessionId: "details-session",
        rowMode: "compact",
      };
      const descriptor = createDeferred<{ session: GatewaySessionRow }>();
      let description = descriptor.promise;
      const request = listRequest(() => sessionsResult([row], 1), {
        "sessions.subscribe": subscribed,
        "sessions.groups.list": () => ({ groups: [], sectionOrder: [] }),
        "sessions.describe": () => description,
      });
      const { connection, page } = await mountPage(
        createTestGatewayClient(request),
        sessionsResult([row], 1),
        entry === "deep-link" ? row.key : null,
      );
      const calls = (method: string) =>
        request.mock.calls.filter(([name]) => name === `sessions.${method}`);
      const panel = () => page.querySelector(".session-details-panel");
      const select = () => panel()?.querySelector<HTMLSelectElement>("select");
      const toggle = async () => {
        click(page, ".session-details-toggle");
        await page.updateComplete;
      };
      const listReads = calls("list").length;
      if (entry === "interactive") {
        expect(calls("describe")).toHaveLength(0);
        await toggle();
      }
      await advance();
      expect(calls("describe")).toHaveLength(1);
      expect(select()?.disabled).toBe(true);
      const held = page.result;
      if (closeBeforeReply) {
        await toggle();
      }

      const full: GatewaySessionRow = {
        ...row,
        rowMode: undefined,
        agentRuntime: { id: "claude-cli", fallback: "none", source: "agent" },
        thinkingLevels: ["off", "high"].map((id) => ({ id, label: id })),
        thinkingDefault: "high",
      };
      descriptor.resolve({ session: full });
      await advance();
      await page.updateComplete;
      expect(calls("list")).toHaveLength(listReads);
      if (closeBeforeReply) {
        expect(panel()).toBeNull();
        expect(page.result).toBe(held);
        return;
      }
      const thinking = select()!;
      expect(thinking.disabled).toBe(false);
      expect([...thinking.options].map((option) => option.textContent?.trim())).toEqual([
        "Inherited: High",
        "Off",
        "High",
      ]);
      expect(panel()?.textContent).toContain("claude-cli (fallback none)");
      if (entry === "interactive") {
        await toggle();
        await toggle();
        expect(calls("describe")).toHaveLength(1);
        description = Promise.resolve({
          session: { ...full, updatedAt: 2, thinkingDefault: "off" },
        });
        connection.emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: { key: row.key, agentId: "main", reason: "patch" },
        });
        await advance();
        await page.updateComplete;
        expect(calls("describe")).toHaveLength(2);
        expect(select()?.options[0]?.textContent?.trim()).toBe("Inherited: Off");
      }
    },
  );
});
