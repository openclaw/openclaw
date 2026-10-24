/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionsSearchResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { SessionsSearchParams } from "../../../../packages/gateway-protocol/src/schema/sessions-search.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { sessionRequest as mockSessionRequests } from "../../lib/sessions/hydration-family.test-support.ts";
import type { SessionPatchResult } from "../../lib/sessions/patch.ts";
import {
  createSessionCapabilityHarness,
  sessionChangedEvent,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createLiveSessionContext,
  createContext,
  createGateway,
  createManagedSessions,
  createRenderedPage,
  type TestSessionsPage,
  withNotifyingAgentSelection,
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
  return mockSessionRequests({ "sessions.list": list, ...methods });
}
const subscribed = () => ({ subscribed: true });
function escape(input: HTMLInputElement) {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

async function mountPage(
  client: GatewayBrowserClient,
  initial: SessionsListResult,
  deepLink: string | null = null,
) {
  const { connection, sessions, context } = createLiveSessionContext(client);
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
  const { connection, sessions, context } = createLiveSessionContext(client);
  const { changeScope: setScope } = withNotifyingAgentSelection(context, "main");
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
    setScope,
  };
}

async function mountDetailsPage(deepLink = false) {
  const row: GatewaySessionRow = {
    ...result("agent:main:details").sessions[0]!,
    sessionId: "details-session",
    rowMode: "compact",
  };
  const descriptor = createDeferred<{ session: GatewaySessionRow }>();
  const response = { promise: descriptor.promise };
  const request = listRequest(() => sessionsResult([row], 1), {
    "sessions.subscribe": subscribed,
    "sessions.groups.list": () => ({ groups: [], sectionOrder: [] }),
    "sessions.describe": () => response.promise,
  });
  const fixture = await mountPage(
    createTestGatewayClient(request),
    sessionsResult([row], 1),
    deepLink ? row.key : null,
  );
  const { page } = fixture;
  return {
    ...fixture,
    row,
    descriptor,
    request,
    response,
    calls: (method: string) => request.mock.calls.filter(([name]) => name === `sessions.${method}`),
    panel: () => page.querySelector(".session-details-panel"),
    toggle: async () => {
      click(page, ".session-details-toggle");
      await page.updateComplete;
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
      const group = page.querySelector<HTMLSelectElement>(".session-groupby__select")!;
      const previousGroup = group.value;
      cleanups.push(() => {
        group.value = previousGroup;
        group.dispatchEvent(new Event("change", { bubbles: true }));
      });
      group.value = "category";
      group.dispatchEvent(new Event("change", { bubbles: true }));
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
      const clear = page.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!;
      expect(clear).toMatchObject({ hidden: false, disabled: false });
      if (action === "click") {
        clear.focus();
        clear.click();
      } else {
        escape(input());
      }
      await page.updateComplete;
      expect(document.activeElement).toBe(input());
      expect(clear).toMatchObject({ hidden: true, disabled: true });
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
      expect([page.groupBy, page.statusFilter, page.includeGlobal]).toEqual([
        "category",
        "active",
        true,
      ]);
      escape(input());
      expect(page.querySelector(".sessions-filter-popover")?.matches(":popover-open")).toBe(false);
      expect(requests).toHaveLength(count + 1);
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
    const patchRequested = createDeferred();
    const older = createDeferred<SessionsListResult>();
    let pageRequests = 0;
    let mutationRefreshes = 0;
    const request = vi.fn(async (method: string, params?: { includeUnknown?: boolean }) => {
      if (method === "sessions.patch") {
        patchRequested.resolve();
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
    await patchRequested.promise;
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
  it("retries a failed descriptor inside the expanded panel", async () => {
    const { page, row, descriptor, request, response } = await mountDetailsPage();
    click(page, ".session-details-toggle");
    await advance();
    descriptor.reject(new Error("Descriptor unavailable"));
    await advance();
    await page.updateComplete;
    expect(page.querySelector('.session-details-panel [role="alert"]')?.textContent).toContain(
      "Descriptor unavailable",
    );
    response.promise = Promise.resolve({
      session: { ...row, rowMode: undefined, label: "Recovered" },
    });
    namedButton(page, "Retry")!.click();
    await advance();
    await page.updateComplete;
    expect(page.querySelector('.session-details-panel [role="alert"]')).toBeNull();
    expect(findInput(page, ".session-details-panel input").value).toBe("Recovered");
    expect(request.mock.calls.filter(([name]) => name === "sessions.describe")).toHaveLength(2);
  });

  it.each([
    { entry: "interactive", closeBeforeReply: false },
    { entry: "deep-link", closeBeforeReply: false },
    { entry: "interactive", closeBeforeReply: true },
  ])(
    "loads full settings for the expanded compact row ($entry, closed: $closeBeforeReply)",
    async ({ entry, closeBeforeReply }) => {
      const { connection, page, row, descriptor, response, calls, panel, toggle } =
        await mountDetailsPage(entry === "deep-link");
      const select = () => panel()?.querySelector<HTMLSelectElement>("select");
      const listReads = calls("list").length;
      if (entry === "interactive") {
        expect(calls("describe")).toHaveLength(0);
        await toggle();
      }
      await advance();
      expect(calls("describe")).toHaveLength(1);
      expect(select()?.disabled).toBe(true);
      click(page, '.session-data-row input[type="checkbox"]');
      await page.updateComplete;
      expect(namedButton(page, "Delete")?.disabled).toBe(false);
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
        response.promise = Promise.resolve({
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
        const draft = findInput(page, ".session-details-panel input");
        draft.value = "Uncommitted label";
        const failedRefresh = createDeferred<{ session: GatewaySessionRow }>();
        response.promise = failedRefresh.promise;
        connection.emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: { key: row.key, agentId: "main", reason: "patch" },
        });
        await advance();
        expect(findInput(page, ".session-details-panel input")).toBe(draft);
        expect(draft.disabled).toBe(true);
        failedRefresh.reject(new Error("Descriptor refresh failed"));
        await advance();
        await page.updateComplete;
        expect(findInput(page, ".session-details-panel input")).toBe(draft);
        expect(draft.value).toBe("Uncommitted label");
        expect(draft.disabled).toBe(false);
        expect(panel()?.textContent).toContain("Descriptor refresh failed");
      }
    },
  );
});

type SearchResponse = SessionsSearchResult & { sessions: GatewaySessionRow[] };
const sessionRow = (id: string, label: string): GatewaySessionRow => ({
  key: `agent:main:${id}`,
  kind: "direct",
  label,
});
const row = sessionRow("content", "Lunar museum itinerary");
const metadata = sessionRow("metadata", "Metadata-only task");
const matches = (snippet = "needle"): SearchResponse => ({
  sessions: [row],
  results: [
    {
      sessionKey: row.key,
      sessionId: "content",
      messageId: "message",
      role: "assistant",
      timestamp: 42,
      snippet,
      score: 1,
    },
  ],
});
async function mountSearch(
  request: ReturnType<typeof vi.fn<GatewayBrowserClient["request"]>>,
  allAgents = false,
) {
  const connection = createGateway({ request } as unknown as GatewayBrowserClient);
  connection.emit({ hello: gatewayHelloForMethods([]) });
  const managed = createManagedSessions();
  onTestFinished(() => expect(managed.sessions.list).not.toHaveBeenCalled());
  const context = createContext(connection.gateway, managed.sessions);
  context.agentSelection.state.scopeId = allAgents ? null : "main";
  const page = await createRenderedPage(context, sessionsResult([metadata], 1));
  const find = (part: string) =>
    page.querySelector<HTMLElement>(`.sessions-transcript-search__${part}`);
  const search = async (query: string) => {
    page.updateTranscriptSearchQuery(query);
    await page.runTranscriptSearch();
    await page.updateComplete;
  };
  return { page, managed, find, search };
}
const scope = {
  agentId: "main",
  excludeDock: true,
  includeGlobal: true,
  includeUnknown: false,
  configuredAgentsOnly: true,
};
const searchCall = (query: string, searchScope: SessionsSearchParams["scope"] = scope) =>
  ["sessions.search", { query, limit: 25, scope: searchScope }] as const;
const emptySearch = () =>
  vi.fn<GatewayBrowserClient["request"]>().mockResolvedValue({ results: [], sessions: [] });

describe("Sessions transcript search", () => {
  it("submits bounded cross-agent search and retains transcript results across metadata filtering", async () => {
    const response = createDeferred<SearchResponse>();
    const request = vi.fn<GatewayBrowserClient["request"]>().mockReturnValue(response.promise);
    const { page, managed, find } = await mountSearch(request, true);
    find("trigger")!.click();
    await page.updateComplete;
    editInput(
      page.querySelector<HTMLInputElement>(".sessions-transcript-search__input input")!,
      "  launch code  ",
    );
    await page.updateComplete;
    await vi.waitFor(() =>
      expect(
        find("form")?.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
      ).toBe(false),
    );
    find("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const { agentId: _agentId, ...allAgents } = scope;
    expect(request).toHaveBeenCalledWith(...searchCall("launch code", allAgents));
    await page.updateComplete;
    expect(find("status")?.getAttribute("aria-busy")).toBe("true");
    response.resolve({
      ...matches("The <launch code> is ready."),
      indexing: true,
      truncated: true,
      archivedTranscriptsExcluded: 3,
    });
    await vi.waitFor(() =>
      expect(find("snippet")?.textContent).toBe("The <launch code> is ready."),
    );
    await page.updateComplete;
    expect(page.transcriptSearchQuery).toBe("launch code");
    expect(find("result-header strong")?.textContent).toBe(row.label);
    expect(find("snippet")?.textContent).toBe("The <launch code> is ready.");
    expect(find("result")?.textContent).toContain("Assistant");
    expect(find("result")?.querySelector("launch")).toBeNull();
    expect(page.textContent).toContain(
      "3 archived transcripts excluded; open a session to restore its searchable history.",
    );
    expect(find("notice")?.textContent).toContain(t("sessionsView.transcriptSearchIndexing"));
    expect(find("summary")?.textContent).toContain(t("sessionsView.transcriptSearchTruncated"));
    expect(find("status")?.getAttribute("aria-busy")).toBe("false");
    expect(page.result?.sessions.map(({ key }) => key)).toEqual([metadata.key]);
    find("result")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(page.context.navigate).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/main/content" }),
    );
    editInput(searchInput(page), "metadata-only");
    await page.updateComplete;
    expect(find("result-header strong")?.textContent).toBe(row.label);
    await vi.waitFor(() =>
      expect(managed.refreshList).toHaveBeenCalledWith(
        expect.objectContaining({ search: "metadata-only" }),
      ),
    );
    const [query] = managed.subscribeList.mock.calls.at(-1)!;
    managed.publish(query, {
      result: sessionsResult([metadata], 2),
      agentId: null,
      loading: false,
      error: null,
    });
    await page.updateComplete;
    expect(page.result?.sessions.map(({ key }) => key)).toEqual([metadata.key]);
    expect(find("result-header strong")?.textContent).toBe(row.label);
    expect(find("snippet")?.textContent).toBe("The <launch code> is ready.");
    expect(request).toHaveBeenCalledOnce();
  });

  it("skips empty queries but submits search without method advertisement", async () => {
    const request = emptySearch();
    const { page, find, search } = await mountSearch(request);
    const submit = () => page.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await search("   ");
    expect(request).not.toHaveBeenCalled();
    expect(find("status")).toBeNull();
    expect(submit().disabled).toBe(false);
    page.updateTranscriptSearchQuery("not advertised");
    await vi.waitFor(() => expect(submit().disabled).toBe(false));
    find("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(find("empty")).not.toBeNull());
    expect(request).toHaveBeenCalledExactlyOnceWith(...searchCall("not advertised"));
  });

  it.each(["same", "clear", "replace", "archive"])(
    "keeps only current matches after %s during a request",
    async (action) => {
      const response = createDeferred<SearchResponse>();
      const request = vi
        .fn<GatewayBrowserClient["request"]>()
        .mockResolvedValue(matches("replacement needle"))
        .mockReturnValueOnce(response.promise);
      const { page, find } = await mountSearch(request);
      find("trigger")!.click();
      page.updateTranscriptSearchQuery("needle");
      const pending = page.runTranscriptSearch();
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      await page.updateComplete;
      if (action === "clear") {
        find("clear")!.click();
      } else if (action === "replace") {
        page.updateTranscriptSearchQuery("replacement needle");
        await page.runTranscriptSearch();
      } else if (action === "archive") {
        page.routeData = { expandedSessionKey: null, statusFilter: "archived" };
      } else {
        page.updateTranscriptSearchQuery("needle");
      }
      await page.updateComplete;
      response.resolve(matches("original needle"));
      await pending;
      await page.updateComplete;
      expect(request).toHaveBeenCalledTimes(action === "replace" ? 2 : 1);
      expect(find("snippet")?.textContent).toBe(
        action === "same"
          ? "original needle"
          : action === "replace"
            ? "replacement needle"
            : undefined,
      );
      if (action === "archive") {
        await vi.waitFor(() => expect(find("status")).toBeNull());
      } else if (action === "clear") {
        expect(find("status")).toBeNull();
      } else {
        expect(find("status")?.getAttribute("aria-busy")).toBe("false");
      }
      if (action === "archive") {
        expect([page.statusFilter, page.transcriptSearchQuery]).toEqual(["archived", "needle"]);
        expect(find("snippet")).toBeNull();
        request.mockResolvedValueOnce({ results: [], sessions: [] });
        await page.runTranscriptSearch();
        await page.updateComplete;
        expect(find("empty")).not.toBeNull();
        expect(request).toHaveBeenLastCalledWith(
          ...searchCall("needle", { ...scope, archived: true }),
        );
      }
    },
  );

  it("shows an unavailable search RPC and retries the submitted query", async () => {
    const request = vi
      .fn<GatewayBrowserClient["request"]>()
      .mockResolvedValue({ results: [], sessions: [] })
      .mockRejectedValueOnce(new Error("search unavailable"));
    const { find, search } = await mountSearch(request);
    await search("needle");
    expect(find("notice")?.textContent).toContain("search unavailable");
    expect(request).toHaveBeenCalledOnce();
    find("notice button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(find("empty")).not.toBeNull());
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(...searchCall("needle"));
    expect(find("notice")).toBeNull();
  });

  it("keeps the search input while edits retire a rejected request", async () => {
    const response = createDeferred<SearchResponse>();
    const replacement = createDeferred<SearchResponse>();
    const request = vi
      .fn<GatewayBrowserClient["request"]>()
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(matches("updated needle"))
      .mockReturnValueOnce(replacement.promise);
    const { page, find } = await mountSearch(request);
    const trigger = find("trigger")!;
    trigger.click();
    await page.updateComplete;
    const form = find("form");
    const input = page.querySelector<HTMLInputElement>(".sessions-transcript-search__input input")!;
    const expectControlsRetained = () => {
      expect(find("form")).toBe(form);
      expect(find("trigger")).toBe(trigger);
      expect(find("input input")).toBe(input);
    };
    page.updateTranscriptSearchQuery("needle");
    const pending = page.runTranscriptSearch();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;
    expect(find("form")).toBe(form);
    expect(find("status")?.getAttribute("aria-busy")).toBe("true");

    editInput(input, "updated needle");
    await page.updateComplete;
    response.reject(new Error("retired request failed"));
    await pending;
    await page.updateComplete;
    expect(find("status")).toBeNull();
    expectControlsRetained();
    expect(input.value).toBe("updated needle");

    await page.runTranscriptSearch();
    await vi.waitFor(() => expect(find("snippet")?.textContent).toBe("updated needle"));
    expectControlsRetained();

    const repeated = page.runTranscriptSearch();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await page.updateComplete;
    expect(find("status")?.getAttribute("aria-busy")).toBe("true");
    expect(find("snippet")).toBeNull();
    expectControlsRetained();
    replacement.resolve(matches("replacement needle"));
    await repeated;
    await vi.waitFor(() => expect(find("snippet")?.textContent).toBe("replacement needle"));
    expectControlsRetained();
  });

  it("searches changed membership without waiting for the metadata list", async () => {
    const refresh = createDeferred();
    const request = emptySearch();
    const { page, managed, find, search } = await mountSearch(request);
    managed.refreshList.mockReturnValueOnce(refresh.promise);
    const unknown = page.querySelector<HTMLInputElement>('input[name="includeUnknown"]')!;
    unknown.checked = true;
    unknown.dispatchEvent(new Event("change", { bubbles: true }));
    await page.updateComplete;
    expect(page.refreshing).toBe(true);
    await search("needle");
    expect(managed.refreshList).toHaveBeenCalledWith(
      expect.objectContaining({ includeUnknown: true }),
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      ...searchCall("needle", { ...scope, includeUnknown: true }),
    );
    expect(find("empty")).not.toBeNull();
    refresh.resolve();
    await vi.waitFor(() => expect(page.refreshing).toBe(false));
  });
});
