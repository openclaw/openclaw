/* @vitest-environment jsdom */

import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionsListParamsSchema } from "../../../packages/gateway-protocol/src/schema/sessions-list.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PresenceEntry, SessionsListResult } from "../api/types.ts";
import { createConnectionBootstrapCoordinator } from "../app/connection-bootstrap.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createContext,
  createGatewayHarness,
  mountSidebar,
  TWO_AGENTS,
  type SidebarLifecycleState,
} from "../test-helpers/app-sidebar.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import "./app-sidebar.ts";
import { SidebarOwnerSessionCounts } from "./sidebar-owner-session-counts.ts";

const NOW = 1_800_000_000_000;
const COUNTS = [
  { profileId: "ada", open: 7, running: 1 },
  { profileId: "bea", open: 3, running: 2 },
];
const PAGE = {
  ...sessionsResult(
    [
      {
        key: "agent:main:visible",
        kind: "direct",
        updatedAt: NOW,
        owner: { actor: { type: "human", id: "ada", identity: { type: "profile", id: "ada" } } },
      },
    ],
    NOW,
  ),
  totalCount: 10,
  hasMore: true,
  nextOffset: 1,
} satisfies SessionsListResult;

function presence(includeRaw = false): PresenceEntry[] {
  const profiles: PresenceEntry[] = ["ada", "bea", "cy"].map((id) => ({
    instanceId: "tab-" + id,
    ts: NOW,
    lastActivityAt: id === "bea" ? NOW - 180_000 : NOW,
    user: { id, identity: { type: "profile", id }, name: id },
  }));
  return includeRaw
    ? [...profiles, { instanceId: "raw", ts: NOW, user: { id: "ada", name: "Raw Ada" } }]
    : profiles;
}

function summary(ownerSessionCounts = COUNTS): SessionsListResult {
  return { ...PAGE, ownerSessionCounts };
}

async function settle(sidebar: SidebarLifecycleState) {
  await vi.advanceTimersByTimeAsync(0);
  await sidebar.updateComplete;
}

function createWorkloadGateway(readSummary: () => Promise<SessionsListResult>, includeRaw = false) {
  const summaryRequest = vi.fn(readSummary);
  const request = createGatewayRequestMock(async (method, params) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.groups.list") {
      return { names: [], sectionOrder: [] };
    }
    if (method === "sessions.list") {
      if (!Value.Check(SessionsListParamsSchema, params)) {
        throw new Error("Invalid sessions.list request");
      }
      return params.includeOwnerSessionCounts ? summaryRequest() : PAGE;
    }
    throw new Error("Unexpected Gateway request: " + method);
  });
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({
    selfUser: { id: "ada", identity: { type: "profile", id: "ada" }, name: "ada" },
    hello: {
      ...gatewayHelloForMethods(["sessions.list", "sessions.subscribe", "sessions.groups.list"]),
      snapshot: { presence: presence(includeRaw) },
    },
  });
  const sessions = createTestSessionCapability(gateway.gateway);
  return { gateway, sessions, request, summaryRequest };
}

async function mountWorkload(readSummary = async () => summary(), includeRaw = false) {
  const harness = createWorkloadGateway(readSummary, includeRaw);
  await harness.sessions.refresh({ agentId: "main", limit: 1 });
  const mounted = await mountSidebar(
    harness.gateway.gateway,
    harness.sessions,
    "panel",
    TWO_AGENTS,
  );
  mounted.sidebar.connected = true;
  await mounted.sidebar.updateComplete;
  await vi.dynamicImportSettled();
  await settle(mounted.sidebar);
  return { ...harness, ...mounted };
}

function person(sidebar: SidebarLifecycleState, name: string): HTMLElement {
  const row = Array.from(sidebar.querySelectorAll<HTMLElement>(".sidebar-online__person")).find(
    (entry) => entry.querySelector(".sidebar-online__person-name")?.textContent === name,
  );
  if (!row) {
    throw new Error("Missing person: " + name);
  }
  return row;
}

function counts(sidebar: SidebarLifecycleState, name: string) {
  return Array.from(person(sidebar, name).querySelectorAll("[data-session-count]"), (cell) =>
    cell.textContent?.trim().replace(/\s+/gu, " "),
  );
}

function names(sidebar: SidebarLifecycleState) {
  return Array.from(
    sidebar.querySelectorAll(".sidebar-online__person-name"),
    (entry) => entry.textContent,
  );
}

async function click(sidebar: SidebarLifecycleState, selector: string) {
  const button = sidebar.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  button!.click();
  await settle(sidebar);
}

describe("sidebar people workload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it.each([false, true])(
    "holds automatic counts behind the selected transcript and fences queued retirement (%s)",
    async (retired) => {
      const { gateway, summaryRequest } = createWorkloadGateway(async () => summary());
      const client = gateway.gateway.snapshot.client;
      const bootstrap = createConnectionBootstrapCoordinator();
      bootstrap.synchronize({ client, connected: true });
      bootstrap.setForegroundRoute("agent:main:main");
      const sessions = createSessionCapability(
        gateway.gateway,
        { state: { selectedId: "main" }, subscribe: () => () => undefined },
        { connectionBootstrap: bootstrap },
      );
      const owner = new SidebarOwnerSessionCounts(() => undefined);
      try {
        owner.synchronize(sessions, "ada", bootstrap);
        await vi.advanceTimersByTimeAsync(0);
        expect(summaryRequest).not.toHaveBeenCalled();
        expect(owner.counts).toBeNull();
        if (retired) {
          owner.dispose();
        }
        bootstrap.setForegroundPane({}, { sessionKey: "agent:main:main", client, ready: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(summaryRequest).toHaveBeenCalledTimes(retired ? 0 : 1);
        expect(owner.counts?.get("ada") ?? null).toEqual(retired ? null : { open: 7, running: 1 });
      } finally {
        owner.dispose();
        sessions.dispose();
        bootstrap.reset();
      }
    },
  );

  it("keeps a single deduplicated self visible in the roster and collapsed facepile", async () => {
    const { sidebar, gateway } = await mountWorkload();
    const self = presence()[0]!;
    gateway.publishEvent("presence", {
      presence: [self, { ...self, instanceId: "second-self-tab" }],
    });
    await settle(sidebar);
    expect(names(sidebar)).toEqual(["ada"]);
    expect(counts(sidebar, "ada")).toEqual(["1", "7"]);
    await click(sidebar, ".sidebar-online .sidebar-session-group-toggle");
    const facepile = sidebar.querySelector("openclaw-viewer-facepile");
    expect(facepile?.staticUsers?.map((user) => user.id)).toEqual(["ada"]);
    gateway.publishEvent("presence", { presence: [{ ...self, reason: "disconnect" }] });
    await settle(sidebar);
    expect(sidebar.querySelector(".sidebar-online")).toBeNull();
  });

  it("uses one complete cross-agent summary, including self, not the paginated or owner-filtered sidebar", async () => {
    const pending = createDeferred<SessionsListResult>();
    const { sidebar, sessions, context, request, summaryRequest } = await mountWorkload(
      () => pending.promise,
    );
    expect(counts(sidebar, "ada")).toEqual([]);
    expect(counts(sidebar, "cy")).toEqual([]);
    expect(person(sidebar, "cy").getAttribute("aria-description")).toContain(
      "Session counts unavailable",
    );
    expect(summaryRequest).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("sessions.list", {
      rowMode: "compact",
      source: "sidebar",
      configuredAgentsOnly: true,
      includeOwnerSessionCounts: true,
      limit: 1,
      includeGlobal: false,
      includeUnknown: false,
      excludeSubagents: true,
      excludeCron: true,
      excludeSystem: true,
      excludeDock: true,
    });

    sidebar.setSessionOwnerFilter("cy");
    context.agentSelection.state.selectedId = "research";
    context.agentSelection.state.scopeId = "research";
    sidebar.requestUpdate();
    await settle(sidebar);
    pending.resolve(summary());
    await settle(sidebar);

    expect(summaryRequest).toHaveBeenCalledOnce();
    expect(sessions.state.result?.sessions).toHaveLength(1);
    expect(counts(sidebar, "ada")).toEqual(["1", "7"]);
    expect(counts(sidebar, "bea")).toEqual(["2", "3"]);
    expect(counts(sidebar, "cy")).toEqual([]);
    expect(person(sidebar, "bea").dataset.presenceActivity).toBe("idle");
    expect(person(sidebar, "bea").getAttribute("aria-description")).toContain("2 running");
  });

  it("filters and sorts people locally using full workload counts", async () => {
    const { sidebar, gateway, request } = await mountWorkload(undefined, true);
    gateway.publishEvent("presence", {
      presence: [...presence(), { instanceId: "raw", ts: NOW, user: { id: "raw", name: "Aaron" } }],
    });
    const reads = request.mock.calls.length;
    const view = sidebar.sidebarMenus.host.people;
    view.setSortMode("running");
    await settle(sidebar);
    expect(names(sidebar)).toEqual(["bea", "ada", "cy", "Aaron"]);
    view.setSortMode("name");
    await settle(sidebar);
    expect(names(sidebar)).toEqual(["Aaron", "ada", "bea", "cy"]);
    view.setSortMode("open");
    await settle(sidebar);
    expect(names(sidebar)).toEqual(["ada", "bea", "cy", "Aaron"]);
    view.setStatusFilter("running");
    await settle(sidebar);
    expect(names(sidebar)).toEqual(["ada", "bea"]);
    expect(counts(sidebar, "ada")).toEqual(["1", "7"]);
    expect(counts(sidebar, "bea")).toEqual(["2", "3"]);
    expect(request).toHaveBeenCalledTimes(reads);
  });

  it("keeps the filter recoverable for unavailable counts and empty matches", async () => {
    const pending = createDeferred<SessionsListResult>();
    const { sidebar } = await mountWorkload(() => pending.promise);
    sidebar.sidebarMenus.host.people.setStatusFilter("running");
    await settle(sidebar);
    expect(names(sidebar)).toEqual([]);
    expect(sidebar.querySelector(".sidebar-session-empty-hint")?.textContent).toBe(
      "Session counts unavailable",
    );
    pending.resolve(summary([]));
    await settle(sidebar);
    expect(names(sidebar)).toEqual([]);
    expect(sidebar.querySelector(".sidebar-online .sidebar-session-empty-hint")?.textContent).toBe(
      "No people match this filter",
    );
    expect(sidebar.querySelector(".sidebar-online [aria-haspopup=dialog]")).not.toBeNull();
    sidebar.sidebarMenus.host.people.resetView();
    await settle(sidebar);
    expect(names(sidebar)).toEqual(["ada", "cy", "bea"]);
  });

  it("dismisses compact people menus on selection and only offers reset for changed settings", async () => {
    const { sidebar } = await mountWorkload();
    const open = async () => {
      await click(sidebar, ".sidebar-online__filter-toggle");
      await vi.dynamicImportSettled();
      await settle(sidebar);
    };
    await open();
    expect(sidebar.querySelector("#sidebar-people-reset")).toBeNull();
    expect(sidebar.querySelector("#sidebar-people-status")?.textContent).toContain("All");
    await click(sidebar, "#sidebar-people-status");
    await click(
      sidebar,
      'openclaw-select-picker:has(#sidebar-people-status) [data-value="running"]',
    );
    expect(sidebar.querySelector('[role="dialog"]')).toBeNull();
    expect(names(sidebar)).toEqual(["ada", "bea"]);
    await open();
    await click(sidebar, "#sidebar-people-sort");
    await click(sidebar, 'openclaw-select-picker:has(#sidebar-people-sort) [data-value="running"]');
    expect(sidebar.querySelector('[role="dialog"]')).toBeNull();
    expect(names(sidebar)).toEqual(["bea", "ada"]);
    await open();
    await click(sidebar, "#sidebar-people-reset");
    expect(sidebar.querySelector('[role="dialog"]')).toBeNull();
    expect(names(sidebar)).toEqual(["ada", "cy", "bea"]);
    await open();
    expect(sidebar.querySelector("#sidebar-people-reset")).toBeNull();
  });

  it("keeps all mixed Active, Idle, and Online-only people, including zero counts, in presence order", async () => {
    const { sidebar, gateway } = await mountWorkload(undefined, true);
    const entries = presence(true);
    gateway.publishEvent("presence", {
      presence: [
        {
          instanceId: "tab-zoe",
          ts: NOW,
          user: { id: "zoe", identity: { type: "profile", id: "zoe" }, name: "zoe" },
        },
        entries[1],
        entries[3],
        entries[2],
        entries[0],
      ],
    });
    await settle(sidebar);
    expect(counts(sidebar, "ada")).toEqual(["1", "7"]);
    expect(counts(sidebar, "Raw Ada")).toEqual([]);
    expect(person(sidebar, "Raw Ada").title).toBe("Session counts unavailable");
    expect(person(sidebar, "ada").querySelector(".session-run-spinner")).not.toBeNull();
    expect(person(sidebar, "ada").querySelector(".sidebar-online__open svg")).not.toBeNull();
    expect(person(sidebar, "cy").querySelector(".sidebar-online__counts")).toBeNull();
    expect(person(sidebar, "Raw Ada").querySelector(".sidebar-online__counts")).toBeNull();
    expect(
      person(sidebar, "ada").querySelector('[data-session-count="open"]')?.getAttribute("title"),
    ).toBe("7\u00a0open");
    expect(counts(sidebar, "cy")).toEqual([]);
    expect(names(sidebar)).toEqual(["ada", "cy", "bea", "Raw Ada", "zoe"]);
    expect(counts(sidebar, "zoe")).toEqual([]);
    expect(person(sidebar, "zoe").getAttribute("aria-description")).toBe(
      "Online · 0 open sessions, 0 running",
    );
    expect(
      sidebar.querySelector(
        ".sidebar-online__columns, .sidebar-online__filter, .sidebar-online__totals",
      ),
    ).toBeNull();
    expect(sidebar.querySelector(".sidebar-online__person-status")).toBeNull();
    for (const [name, activity, description] of [
      ["ada", "active", "Online · Active"],
      ["bea", "idle", "Online · Idle"],
      ["Raw Ada", "unknown", "Online · Session counts unavailable"],
      ["zoe", "unknown", "Online · 0 open sessions, 0 running"],
    ] as const) {
      const row = person(sidebar, name);
      expect(row.dataset.presenceActivity).toBe(activity);
      expect(row.getAttribute("aria-description")).toContain(description);
      expect(
        row.querySelector('.sidebar-online__avatar[aria-hidden="true"] openclaw-viewer-avatar'),
      ).not.toBeNull();
    }
    expect(person(sidebar, "cy").getAttribute("aria-description")).toContain(
      "0 open sessions, 0 running",
    );
  });

  it("lists running people first within each presence group, by name and never by count", async () => {
    const { sidebar, gateway } = await mountWorkload(async () =>
      summary([
        { profileId: "zed", open: 1, running: 1 },
        { profileId: "bruno", open: 17, running: 17 },
        { profileId: "agata", open: 2, running: 2 },
      ]),
    );
    const people = [
      ["bruno", "bruno", NOW - 180_000],
      ["amy", "amy", NOW],
      ["agata", "Ágata", NOW - 180_000],
      ["zed", "Zed", NOW],
    ] as const;
    gateway.publishEvent("presence", {
      presence: people.map(([id, name, lastActivityAt]) => ({
        instanceId: "tab-" + id,
        ts: NOW,
        lastActivityAt,
        user: { id, identity: { type: "profile", id }, name },
      })),
    });
    await settle(sidebar);
    expect(names(sidebar)).toEqual(["Zed", "amy", "Ágata", "bruno"]);
  });

  it("does not turn a failed summary into zero and recovers through the visible retry", async () => {
    const response = vi
      .fn<() => Promise<SessionsListResult>>()
      .mockRejectedValueOnce(new Error("Summary unavailable"))
      .mockResolvedValue(summary([]));
    const { sidebar, summaryRequest } = await mountWorkload(response);
    expect(sidebar.sessionData.ownerCounts.error).toContain("Summary unavailable");
    expect(counts(sidebar, "cy")).toEqual([]);
    await click(sidebar, ".sidebar-online__retry");
    expect(summaryRequest).toHaveBeenCalledTimes(2);
    expect(sidebar.sessionData.ownerCounts.error).toBeNull();
    expect(sidebar.querySelector(".sidebar-online__retry")).toBeNull();
    expect(counts(sidebar, "cy")).toEqual([]);
    expect(names(sidebar)).toEqual(["ada", "cy", "bea"]);
    expect(person(sidebar, "cy").getAttribute("aria-description")).toContain(
      "0 open sessions, 0 running",
    );
  });

  it.each([
    "disconnect",
    "scope replacement",
    "viewer replacement",
    "presence reset",
    "unmount",
  ] as const)("retires prior counts and ignores an in-flight reply after %s", async (boundary) => {
    const late = createDeferred<SessionsListResult>();
    const current = createDeferred<SessionsListResult>();
    const response = vi
      .fn<() => Promise<SessionsListResult>>()
      .mockResolvedValueOnce(summary())
      .mockReturnValueOnce(late.promise)
      .mockReturnValue(boundary === "viewer replacement" ? current.promise : late.promise);
    const { sidebar, gateway, provider, summaryRequest } = await mountWorkload(response);
    expect(counts(sidebar, "ada")).toEqual(["1", "7"]);
    void sidebar.sessionData.ownerCounts.refresh();
    expect(summaryRequest).toHaveBeenCalledTimes(2);

    if (boundary === "disconnect") {
      gateway.publish({ phase: "reconnecting" });
    } else if (boundary === "viewer replacement") {
      gateway.publish({
        selfUser: {
          id: "replacement-viewer",
          identity: { type: "profile", id: "replacement-viewer" },
        },
      });
    } else if (boundary === "presence reset") {
      gateway.publishEvent("presence", { presence: [] });
    } else if (boundary === "unmount") {
      sidebar.remove();
    } else {
      const replacement = createWorkloadGateway(async () =>
        summary([{ profileId: "ada", open: 2, running: 0 }]),
      );
      provider.setContext(
        createContext(replacement.gateway.gateway, replacement.sessions, TWO_AGENTS),
      );
    }
    await settle(sidebar);
    if (boundary === "viewer replacement") {
      expect(counts(sidebar, "ada")).toEqual([]);
    } else if (boundary !== "scope replacement") {
      expect(sidebar.sessionData.ownerCounts.counts).toBeNull();
    } else {
      expect(counts(sidebar, "ada")).toEqual(["2"]);
    }
    late.resolve(summary([{ profileId: "ada", open: 99, running: 99 }]));
    await settle(sidebar);
    if (boundary === "viewer replacement") {
      expect(counts(sidebar, "ada")).toEqual([]);
    } else if (boundary !== "scope replacement") {
      expect(sidebar.sessionData.ownerCounts.counts).toBeNull();
    } else {
      expect(counts(sidebar, "ada")).toEqual(["2"]);
    }
    if (boundary === "viewer replacement") {
      expect(summaryRequest).toHaveBeenCalledTimes(3);
      current.resolve(summary([{ profileId: "ada", open: 2, running: 0 }]));
      await settle(sidebar);
      expect(counts(sidebar, "ada")).toEqual(["2"]);
    }
  });
});
