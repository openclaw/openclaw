/* @vitest-environment jsdom */
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { makeBootRecord } from "../app/bootstrap.test-support.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import type { BootRoster } from "../lib/sessions/session-boot-roster.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import * as snapshotPrewarm from "../pages/chat/session-snapshot-prewarm.ts";
import { createContext, createGatewayHarness, TWO_AGENTS } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { sidebarBootSnapshot } from "../test-helpers/sidebar-boot-snapshot.test-support.ts";
import { createSessionDataHost } from "./session-data-controller.test-support.ts";
import { publishSidebarSessionList } from "./session-data-events.ts";
import { SessionDataOwner } from "./session-data.ts";

afterEach(() => vi.restoreAllMocks());

function row(key: string, updatedAt: number, extra: Partial<GatewaySessionRow> = {}) {
  return { key: `agent:main:${key}`, kind: "direct" as const, updatedAt, ...extra };
}

function gatewayFor(list: (params: unknown) => unknown) {
  const request = vi.fn((method: string, params?: unknown) => {
    switch (method) {
      case "sessions.list":
        return list(params);
      case "sessions.subscribe":
        return { subscribed: true };
      case "sessions.groups.list":
        return { names: [], groups: [], sectionOrder: [] };
      default:
        throw new Error(`Unexpected Gateway request: ${method}`);
    }
  });
  return { request, gateway: createGatewayHarness(createTestGatewayClient(request)) };
}

it("selects current and cached agent windows without reviving a retired current result", () => {
  const gateway = createGatewayHarness(createTestGatewayClient(vi.fn()));
  const sessions = createTestSessionCapability(gateway.gateway);
  const owner = new SessionDataOwner(
    createSessionDataHost(createContext(gateway.gateway, sessions, TWO_AGENTS)),
    () => undefined,
  );
  const main = sessionsResult([row("main", 1)]);
  const research = sessionsResult([{ key: "agent:research:work", kind: "direct" }]);
  const publish = (agentId: string | null, result: SessionsListResult | null) =>
    publishSidebarSessionList(owner, { agentId, result, loading: false, error: null });

  publish("main", main);
  publish("research", research);
  expect(owner.resultForAgent(" MAIN ")).toBe(main);
  expect(owner.resultForAgent("research")).toBe(research);
  expect(owner.resultForAgent("unseen")).toBeNull();

  publish("research", null);
  expect(owner.resultForAgent("research")).toBeNull();
  expect(owner.resultForAgent("main")).toBe(main);

  publish(null, research);
  expect(owner.resultForAgent("main")).toBe(research);
});

it("applies the saved roster filter before its first read and releases it with the data owner", async () => {
  const rows = [row("mine", 1), row("other", 2)];
  const rosterFilters: unknown[] = [];
  const { gateway } = gatewayFor((params) => {
    if (
      params &&
      typeof params === "object" &&
      "source" in params &&
      params.source === "agent-roster"
    ) {
      const involvingMe = "involvingMe" in params ? params.involvingMe : undefined;
      rosterFilters.push(involvingMe);
      return sessionsResult(involvingMe ? [rows[0]!] : rows, 1);
    }
    return sessionsResult([], 1);
  });
  const sessions = createTestSessionCapability(gateway.gateway);
  const context = createContext(gateway.gateway, sessions, TWO_AGENTS);
  let involvingMe = true;
  const host = createSessionDataHost(context, {
    sidebarAgentsMode: "roster",
    sessionCatalogRowsVisible: false,
    sidebarSessionOwnerFilter: () => ({ ownerId: null, involvingMe }),
  });
  const owner = new SessionDataOwner(host, () => undefined);
  const roster = rosterActivityStore(context);
  try {
    owner.connect();
    await vi.waitFor(() =>
      expect(owner.sessionsResult?.sessions.map((session) => session.key)).toEqual([
        "agent:main:mine",
      ]),
    );
    expect(rosterFilters).toEqual([true]);

    involvingMe = false;
    owner.synchronize();
    await vi.waitFor(() =>
      expect(owner.sessionsResult?.sessions.map((session) => session.key)).toEqual([
        "agent:main:mine",
        "agent:main:other",
      ]),
    );

    involvingMe = true;
    owner.synchronize();
    expect(roster.snapshot.involvingMe).toBe(true);
    owner.disconnect(true);
    expect(roster.snapshot.involvingMe).toBe(false);
  } finally {
    owner.disconnect();
    sessions.dispose();
  }
});

it.each([
  ["before controller binding", "before", false],
  ["after controller binding", "after", false],
  ["before filtered live rows win bootstrap", "after", true],
] as const)(
  "leaves routing cache loaded %s to its owner and renders only live rows",
  async (_name, cacheTiming, filtered) => {
    const cached = sessionsResult([row("kept", 1), row("deleted", 1)], 1);
    const live = sessionsResult([row("kept", 2, { sessionId: "kept-session" })], 2);
    const archived = sessionsResult([row("archived", 2, { archived: true })], 2);
    const firstList = createDeferred<SessionsListResult>();
    const reconnectList = createDeferred<SessionsListResult>();
    const responses = [firstList, reconnectList];
    const { request, gateway } = gatewayFor((params) => {
      if (params && typeof params === "object" && "archived" in params) {
        return archived;
      }
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected extra session list");
      }
      return response.promise;
    });
    gateway.publish({ phase: "connecting", hello: null });
    const cachedRoster = createDeferred<BootRoster>();
    vi.spyOn(snapshotPrewarm, "readSidebarBootSnapshot").mockImplementation(async () =>
      sidebarBootSnapshot(await cachedRoster.promise),
    );
    const sessions = createSessionCapability(
      gateway.gateway,
      { state: { selectedId: "main" }, subscribe: () => () => undefined },
      {
        bootRecord: makeBootRecord(gatewayCredentialScope(gateway.gateway.connection.gatewayUrl), {
          recoveryScope: "synthetic-account",
          profileId: null,
          agents: TWO_AGENTS,
        }),
      },
    );
    let statusFilter: "active" | "archived" = "active";
    const host = createSessionDataHost(createContext(gateway.gateway, sessions, TWO_AGENTS), {
      sidebarSessionStatusFilter: () => statusFilter,
    });
    const controller = new SessionDataOwner(host, () => undefined);
    try {
      if (cacheTiming === "after") {
        controller.connect();
      }
      cachedRoster.resolve({
        agentId: "main",
        result: cached,
        groups: [],
        groupSettings: [],
        sectionOrder: [],
      });
      await sessions.whenCachedRosterSettled();
      if (cacheTiming === "before") {
        controller.connect();
      }

      expect(controller).toMatchObject({ sessionsResult: null, sessionsAgentId: null });
      expect(request).not.toHaveBeenCalled();

      if (filtered) {
        statusFilter = "archived";
        controller.resetSessionList();
      }
      gateway.publish({ phase: "connected", selfUser: null });
      if (filtered) {
        await controller.refreshSidebarSessions();
        expect(controller.sessionsResult?.sessions).toEqual(archived.sessions);
      }
      firstList.resolve(live);
      await vi.waitFor(() => expect(sessions.canonicalListRevision).toBe(1));
      expect(controller.sessionResultsByAgent.main?.sessions).toEqual(
        filtered ? archived.sessions : live.sessions,
      );
      if (filtered) {
        expect(controller.sessionsResult?.sessions).toEqual(archived.sessions);
        statusFilter = "active";
        controller.resetSessionList();
      }
      expect(controller.sessionsResult?.sessions).toEqual(live.sessions);

      gateway.publish({ phase: "reconnecting" });
      expect(controller.sessionsResult?.sessions).toEqual(live.sessions);
      gateway.publish({ phase: "connected" });
      sessions.reconcile(row("partial", 3, { sessionId: "partial-session" }), live.defaults);
      expect(sessions.canonicalListRevision).toBe(1);
      expect(controller.sessionsResult?.sessions).toEqual(live.sessions);

      const refreshed = sessionsResult([row("replacement", 4)], 4);
      reconnectList.resolve(refreshed);
      await vi.waitFor(() => expect(sessions.canonicalListRevision).toBe(2));
      expect(controller.sessionsResult?.sessions).toEqual(refreshed.sessions);
    } finally {
      controller.disconnect();
      sessions.dispose();
    }
  },
);
