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
    cell.textContent?.trim(),
  );
}

function names(sidebar: SidebarLifecycleState) {
  return Array.from(
    sidebar.querySelectorAll(".sidebar-online__person-name"),
    (entry) => entry.textContent,
  );
}

function totals(sidebar: SidebarLifecycleState) {
  return Array.from(sidebar.querySelectorAll("[data-session-total]"), (entry) =>
    entry.textContent?.trim(),
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

  it("uses one complete cross-agent summary, not the paginated or owner-filtered sidebar", async () => {
    const pending = createDeferred<SessionsListResult>();
    const { sidebar, sessions, context, request, summaryRequest } = await mountWorkload(
      () => pending.promise,
    );
    expect(counts(sidebar, "ada")).toEqual(["—", "—"]);
    expect(counts(sidebar, "cy")).toEqual(["—", "—"]);
    expect(totals(sidebar)).toEqual(["—", "—"]);
    expect(sidebar.querySelector<HTMLButtonElement>(".sidebar-online__filter")?.disabled).toBe(
      true,
    );
    expect(summaryRequest).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("sessions.list", {
      configuredAgentsOnly: true,
      includeOwnerSessionCounts: "only",
      limit: 1,
      includeGlobal: false,
      includeUnknown: false,
      excludeSubagents: true,
      excludeCron: true,
      excludeSystem: true,
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
    expect(counts(sidebar, "ada")).toEqual(["7", "1"]);
    expect(counts(sidebar, "bea")).toEqual(["3", "2"]);
    expect(counts(sidebar, "cy")).toEqual(["0", "0"]);
    expect(totals(sidebar)).toEqual(["10", "3"]);
    expect(person(sidebar, "bea").dataset.presenceActivity).toBe("idle");
    expect(person(sidebar, "bea").getAttribute("aria-description")).toContain("2 running");
  });

  it("keeps raw/profile collisions unknown and filters and sorts workload independently of presence", async () => {
    const { sidebar } = await mountWorkload(undefined, true);
    expect(counts(sidebar, "ada")).toEqual(["7", "1"]);
    expect(counts(sidebar, "Raw Ada")).toEqual(["—", "—"]);
    expect(totals(sidebar)).toEqual(["—", "—"]);
    expect(names(sidebar)).toEqual(["ada", "cy", "bea", "Raw Ada"]);

    await click(sidebar, '.sidebar-online__column[aria-label="Sort people by running sessions"]');
    expect(names(sidebar)).toEqual(["bea", "ada", "cy", "Raw Ada"]);
    await click(sidebar, ".sidebar-online__filter");
    expect(names(sidebar)).toEqual(["bea", "ada"]);
    expect(totals(sidebar)).toEqual(["10", "3"]);
    expect(person(sidebar, "bea").dataset.presenceActivity).toBe("idle");

    await click(sidebar, '.sidebar-online__column[aria-label="Sort people by open sessions"]');
    expect(names(sidebar)).toEqual(["ada", "bea"]);
    await click(sidebar, ".sidebar-online__filter");
    expect(names(sidebar)).toEqual(["ada", "bea", "cy", "Raw Ada"]);
    await click(sidebar, '.sidebar-online__column[aria-label="Sort people by open sessions"]');
    expect(names(sidebar)).toEqual(["ada", "cy", "bea", "Raw Ada"]);
  });

  it("does not turn a failed summary into zero and recovers through the visible retry", async () => {
    const response = vi
      .fn<() => Promise<SessionsListResult>>()
      .mockRejectedValueOnce(new Error("Summary unavailable"))
      .mockResolvedValue(summary([]));
    const { sidebar, summaryRequest } = await mountWorkload(response);
    expect(sidebar.sessionData.ownerCounts.error).toContain("Summary unavailable");
    expect(counts(sidebar, "cy")).toEqual(["—", "—"]);
    await click(sidebar, ".sidebar-online__retry");
    expect(summaryRequest).toHaveBeenCalledTimes(2);
    expect(sidebar.sessionData.ownerCounts.error).toBeNull();
    expect(sidebar.querySelector(".sidebar-online__retry")).toBeNull();
    expect(counts(sidebar, "cy")).toEqual(["0", "0"]);
    expect(totals(sidebar)).toEqual(["0", "0"]);
    await click(sidebar, ".sidebar-online__filter");
    expect(names(sidebar)).toEqual([]);
    expect(sidebar.querySelector(".sidebar-online__empty")).not.toBeNull();
  });

  it("clears the previous viewer's counts on the same client before adopting a fresh summary", async () => {
    const stale = createDeferred<SessionsListResult>();
    const current = createDeferred<SessionsListResult>();
    const response = vi
      .fn<() => Promise<SessionsListResult>>()
      .mockResolvedValueOnce(summary())
      .mockReturnValueOnce(stale.promise)
      .mockReturnValue(current.promise);
    const { sidebar, gateway, summaryRequest } = await mountWorkload(response);
    expect(counts(sidebar, "ada")).toEqual(["7", "1"]);
    void sidebar.sessionData.ownerCounts.refresh();
    expect(summaryRequest).toHaveBeenCalledTimes(2);
    gateway.publish({
      selfUser: {
        id: "replacement-viewer",
        identity: { type: "profile", id: "replacement-viewer" },
      },
    });
    await settle(sidebar);
    expect(counts(sidebar, "ada")).toEqual(["—", "—"]);
    expect(totals(sidebar)).toEqual(["—", "—"]);

    stale.resolve(summary([{ profileId: "ada", open: 99, running: 99 }]));
    await settle(sidebar);
    expect(counts(sidebar, "ada")).toEqual(["—", "—"]);
    expect(summaryRequest).toHaveBeenCalledTimes(3);
    current.resolve(summary([{ profileId: "ada", open: 2, running: 0 }]));
    await settle(sidebar);
    expect(counts(sidebar, "ada")).toEqual(["2", "0"]);
  });

  it.each(["disconnect", "scope replacement", "presence reset", "unmount"] as const)(
    "retires prior counts and ignores an in-flight reply after %s",
    async (boundary) => {
      const late = createDeferred<SessionsListResult>();
      const response = vi
        .fn<() => Promise<SessionsListResult>>()
        .mockResolvedValueOnce(summary())
        .mockReturnValue(late.promise);
      const { sidebar, gateway, provider, summaryRequest } = await mountWorkload(response);
      expect(counts(sidebar, "ada")).toEqual(["7", "1"]);
      void sidebar.sessionData.ownerCounts.refresh();
      expect(summaryRequest).toHaveBeenCalledTimes(2);

      if (boundary === "disconnect") {
        gateway.publish({ phase: "reconnecting" });
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
      if (boundary !== "scope replacement") {
        expect(sidebar.sessionData.ownerCounts.counts).toBeNull();
      } else {
        expect(counts(sidebar, "ada")).toEqual(["2", "0"]);
      }
      late.resolve(summary([{ profileId: "ada", open: 99, running: 99 }]));
      await settle(sidebar);
      if (boundary !== "scope replacement") {
        expect(sidebar.sessionData.ownerCounts.counts).toBeNull();
      } else {
        expect(counts(sidebar, "ada")).toEqual(["2", "0"]);
      }
    },
  );
});
