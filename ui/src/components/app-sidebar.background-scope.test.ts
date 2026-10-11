/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../api/types.ts";
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
} from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../test-helpers/gateway-client.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import { storeSidebarSessionOwnerFilter } from "./app-sidebar-session-types.ts";
import "./app-sidebar.ts";

async function mountSessionRoster(request: GatewayRequestHandler) {
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  const sessions = createTestSessionCapability(gateway.gateway);
  await sessions.refresh({ agentId: "main", force: true });
  return {
    ...(await mountSidebar(gateway.gateway, sessions, "panel", TWO_AGENTS)),
    sessions,
  };
}

describe("AppSidebar automatic list scope replacement", () => {
  it("discovers current child parents after background work was queued", async () => {
    const previousParent: GatewaySessionRow = {
      key: "agent:main:previous-parent",
      kind: "direct",
      label: "Previous parent",
      childSessions: ["agent:main:previous-child"],
    };
    const nextParent: GatewaySessionRow = {
      key: "agent:main:next-parent",
      kind: "direct",
      label: "Next parent",
      childSessions: ["agent:main:next-child"],
    };
    const mainParent: GatewaySessionRow = {
      key: "agent:main:main",
      kind: "direct",
      childSessions: ["agent:main:main-child"],
    };
    const children: GatewaySessionRow[] = [previousParent, nextParent, mainParent].map(
      (parent) => ({
        key: parent.childSessions![0]!,
        kind: "direct",
        label: `${parent.key} child`,
        spawnedBy: parent.key,
      }),
    );
    let roots = [previousParent];
    const parents: unknown[] = [];
    const { sidebar, context, provider, sessions } = await mountSessionRoster(
      async (method, raw) => {
        const params = asOptionalRecord(raw);
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method === "sessions.describe") {
          return {
            session: [...roots, ...children].find((row) => row.key === params?.key) ?? null,
          };
        }
        if (method !== "sessions.list") {
          return {};
        }
        if (params?.spawnedBy) {
          parents.push(params.spawnedBy);
          return sessionsResult(
            children.filter((row) => row.spawnedBy === params.spawnedBy),
            2,
          );
        }
        return sessionsResult(roots, 1);
      },
    );
    try {
      context.connectionBootstrap.setForegroundRoute(undefined);
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = previousParent.key;
      await settleLitElement(sidebar);
      expect(parents).toEqual([]);

      roots = [previousParent, nextParent, mainParent];
      sidebar.sessionKey = nextParent.key;
      await sessions.refresh({ agentId: "main", force: true });
      await settleLitElement(sidebar);
      expect(parents).toEqual([]);
      expect(
        sidebar
          .querySelector(`[data-child-session-toggle="${previousParent.key}"]`)
          ?.getAttribute("aria-expanded"),
      ).toBe("false");

      context.connectionBootstrap.setForegroundRoute(null);
      await waitForFast(() =>
        expect(parents).toEqual(expect.arrayContaining([nextParent.key, mainParent.key])),
      );
      await settleLitElement(sidebar);
      expect(parents).toHaveLength(2);
      expect(sidebar.sessionData.childSessionRowsByParent[previousParent.key]).toBeUndefined();
      expect(sidebar.sessionData.childSessionRowsByParent[mainParent.key]?.[0]?.key).toBe(
        mainParent.childSessions![0],
      );
      const expand = sidebar.querySelector<HTMLButtonElement>(
        `[data-child-session-toggle="${nextParent.key}"]`,
      );
      expect(expand?.getAttribute("aria-expanded")).toBe("false");
      expand!.click();
      await settleLitElement(sidebar);
      expect(sidebar.textContent).toContain(`${nextParent.key} child`);
      expect(parents).toHaveLength(2);
    } finally {
      provider.remove();
      context.connectionBootstrap.reset();
      sessions.dispose();
    }
  });

  it("loads the selected filtered roster after an earlier automatic scope read settles", async () => {
    vi.useFakeTimers();
    const previous = deferred<ReturnType<typeof sessionsResult>>();
    const targets: unknown[] = [];
    let mainReads = 0;
    const archived = (agentId: string, label: string) =>
      sessionsResult(
        [{ key: `agent:${agentId}:archived`, kind: "direct", archived: true, label }],
        1,
      );
    const { sidebar, context, provider, sessions } = await mountSessionRoster(
      async (method, raw) => {
        const params = asOptionalRecord(raw);
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method !== "sessions.list") {
          return {};
        }
        if (params?.archived !== true) {
          return sessionsResult([], 0);
        }
        targets.push(params.agentId);
        if (params.agentId === "research") {
          return previous.promise;
        }
        return archived("main", `Main archived ${++mainReads}`);
      },
    );
    try {
      sidebar.connected = true;
      await sidebar.updateComplete;
      sidebar.sessionOrganizer.setSessionsStatusFilter("archived");
      await vi.advanceTimersByTimeAsync(0);
      await sidebar.updateComplete;
      expect(sidebar.textContent).toContain("Main archived 1");

      context.agentSelection.set("research");
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(50);
      expect(targets).toEqual(["main", "research"]);
      context.agentSelection.set("main");
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(50);
      previous.resolve(archived("research", "Stale Research archived"));
      await vi.advanceTimersByTimeAsync(50);
      await sidebar.updateComplete;

      expect(sidebar.textContent).not.toContain("Stale Research archived");
      expect(targets).toEqual(["main", "research", "main"]);
      expect(sidebar.textContent).toContain("Main archived 2");
    } finally {
      previous.resolve(sessionsResult([], 0));
      provider.remove();
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["research", "main"])(
    "loads the next active parent's children when its agent is %s",
    async (nextAgent) => {
      vi.useFakeTimers();
      const mainParent = "agent:main:parent";
      const researchParent = `agent:${nextAgent}:next-parent`;
      const mainChild = "agent:main:child";
      const researchChild = `agent:${nextAgent}:next-child`;
      const rows: GatewaySessionRow[] = [
        { key: mainParent, kind: "direct", label: "Main parent", childSessions: [mainChild] },
        {
          key: researchParent,
          kind: "direct",
          label: "Next parent",
          childSessions: [researchChild],
        },
        { key: mainChild, kind: "direct", label: "Stale Main child", spawnedBy: mainParent },
        { key: researchChild, kind: "direct", label: "Next child", spawnedBy: researchParent },
      ];
      const previous = deferred<ReturnType<typeof sessionsResult>>();
      const parents: unknown[] = [];
      let primaryReads = 0;
      const { sidebar, context, provider, sessions } = await mountSessionRoster(
        async (method, raw) => {
          const params = asOptionalRecord(raw);
          if (method === "sessions.subscribe") {
            return { subscribed: true };
          }
          if (method === "sessions.describe") {
            return { session: rows.find((row) => row.key === params?.key) ?? null };
          }
          if (method !== "sessions.list") {
            return {};
          }
          if (params?.spawnedBy) {
            parents.push(params.spawnedBy);
            return params.spawnedBy === mainParent
              ? previous.promise
              : sessionsResult(
                  rows.filter((row) => row.spawnedBy === params.spawnedBy),
                  2,
                );
          }
          primaryReads += 1;
          const knownParents =
            nextAgent === "main"
              ? [mainParent, researchParent]
              : [params?.agentId === "research" ? researchParent : mainParent];
          return sessionsResult(
            rows.filter((row) => knownParents.includes(row.key)),
            1,
          );
        },
      );
      try {
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = mainParent;
        sidebar.connected = true;
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(50);
        expect(parents).toEqual([mainParent]);

        context.agentSelection.set(nextAgent);
        sidebar.sessionKey = researchParent;
        if (nextAgent !== "main") {
          await sessions.refresh({ agentId: nextAgent, force: true });
        }
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(50);
        expect(primaryReads).toBe(nextAgent === "main" ? 1 : 2);
        previous.resolve(
          sessionsResult(
            rows.filter((row) => row.key === mainChild),
            1,
          ),
        );
        await vi.advanceTimersByTimeAsync(50);
        await sidebar.updateComplete;

        if (nextAgent !== "main") {
          expect(sidebar.textContent).not.toContain("Stale Main child");
        }
        expect(parents).toEqual([mainParent, researchParent]);
        const expand = sidebar.querySelector<HTMLButtonElement>(
          `[data-child-session-toggle="${researchParent}"]`,
        );
        expect(expand).not.toBeNull();
        expect(expand?.getAttribute("aria-expanded")).toBe("false");
        expand!.click();
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(0);
        expect(sidebar.textContent).toContain("Next child");
        expect(parents).toEqual([mainParent, researchParent]);
      } finally {
        previous.resolve(sessionsResult([], 0));
        provider.remove();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );
});

describe("AppSidebar initial managed-list hydration", () => {
  it.each([
    { name: "ordinary overlap", holdSecondSlot: false, invalidate: false, filter: "mine" },
    { name: "queued initial fill", holdSecondSlot: true, invalidate: false, filter: "mine" },
    {
      name: "queued initial fill with a later event",
      holdSecondSlot: true,
      invalidate: true,
      filter: "mine",
    },
    { name: "saved All owner", holdSecondSlot: true, invalidate: false, filter: "owner" },
    {
      name: "saved All involving me",
      holdSecondSlot: true,
      invalidate: false,
      filter: "involving-me",
    },
  ])("keeps only required filtered reads during $name", async (scenario) => {
    const { holdSecondSlot, invalidate, filter } = scenario;
    const matchesFilter = (query: Record<string, unknown> | null | undefined) =>
      filter === "involving-me"
        ? query?.involvingMe === true
        : query?.ownerId === "synthetic-operator";
    const primary = deferred<ReturnType<typeof sessionsResult>>();
    const filtered = deferred<ReturnType<typeof sessionsResult>>();
    const groups = deferred<{ names: string[]; groups: never[]; sectionOrder: string[] }>();
    const unrelatedBootstrap = deferred();
    const laterBootstrap = deferred();
    const order: string[] = [];
    const listQueries: Record<string, unknown>[] = [];
    const primaryResult = sessionsResult(
      [{ key: "agent:main:primary", kind: "direct", label: "Canonical session" }],
      1,
    );
    const filteredResult = sessionsResult(
      [
        {
          key: "agent:main:mine",
          kind: "direct",
          label: "My session",
          owner: { actor: { type: "human", id: "synthetic-operator" } },
        },
      ],
      1,
    );
    const emptyGroups = { names: [], groups: [], sectionOrder: [] };
    const gateway = createGatewayHarness(
      createTestGatewayClient(async (method, raw) => {
        const params = asOptionalRecord(raw);
        if (method === "sessions.subscribe") {
          order.push("subscribe");
          return { subscribed: true };
        }
        if (method === "sessions.groups.list") {
          order.push("groups:start");
          return groups.promise;
        }
        if (method !== "sessions.list") {
          return {};
        }
        if (params?.includeOwnerSessionCounts) {
          return { ...primaryResult, totalCount: 1, ownerSessionCounts: [] };
        }
        listQueries.push({ ...params });
        if (matchesFilter(params)) {
          order.push("filtered:start");
          if (invalidate && listQueries.filter(matchesFilter).length > 1) {
            return sessionsResult(
              [
                {
                  key: "agent:main:mine",
                  kind: "direct",
                  label: "Updated session",
                  owner: { actor: { type: "human", id: "synthetic-operator" } },
                },
              ],
              2,
            );
          }
          return filtered.promise;
        }
        order.push("primary:start");
        return primary.promise;
      }),
    );
    gateway.publish({
      phase: "connecting",
      selfUser: { id: "synthetic-operator" },
      hello: gatewayHelloForMethods([...SESSION_MUTATION_TEST_METHODS, "sessions.groups.list"]),
    });
    const connectionBootstrap = createConnectionBootstrapCoordinator();
    const stopBootstrap = gateway.gateway.subscribe((snapshot) =>
      connectionBootstrap.synchronize({
        client: snapshot.client,
        connected: snapshot.phase === "connected",
      }),
    );
    const sessions = createSessionCapability(
      gateway.gateway,
      { state: { selectedId: "main" }, subscribe: () => () => undefined },
      { connectionBootstrap },
    );
    const context = {
      ...createContext(gateway.gateway, sessions, TWO_AGENTS),
      connectionBootstrap,
    };
    gateway.publish({ phase: "connected" });
    const heldBootstrap = holdSecondSlot
      ? connectionBootstrap.run("unrelated-bootstrap", async () => {
          order.push("unrelated:start");
          await unrelatedBootstrap.promise;
        })
      : Promise.resolve();
    const provider = createApplicationContextProvider(context);
    const sidebar = document.createElement("openclaw-app-sidebar");
    if (!(sidebar instanceof AppSidebarSessionNavigationElement)) {
      throw new Error("Expected registered sidebar");
    }
    sidebar.navigationScope = filter === "mine" ? "mine" : "all";
    if (filter !== "mine") {
      storeSidebarSessionOwnerFilter(gateway.gateway.connection.gatewayUrl, "synthetic-operator", {
        ownerId: filter === "owner" ? "synthetic-operator" : null,
        involvingMe: filter === "involving-me",
      });
    }
    provider.append(sidebar);
    document.body.append(provider);
    await sidebar.updateComplete;
    const heldLater = invalidate
      ? connectionBootstrap.run("later-bootstrap", async () => {
          order.push("later:start");
          await laterBootstrap.promise;
        })
      : Promise.resolve();
    try {
      sidebar.connected = true;
      await sidebar.updateComplete;
      expect(listQueries).toHaveLength(1);
      expect(listQueries[0]).toMatchObject({ ownerFirst: true, agentId: "main" });
      expect(order.includes("groups:start")).toBe(!holdSecondSlot);

      order.push("primary:resolve");
      primary.resolve(primaryResult);
      await vi.waitFor(() => expect(order).toContain("groups:start"));
      await vi.waitFor(() =>
        expect(sessions.state.result?.sessions[0]?.label).toBe("Canonical session"),
      );
      if (holdSecondSlot) {
        expect(listQueries).toHaveLength(1);
      }

      order.push("groups:resolve");
      groups.resolve(emptyGroups);
      await vi.waitFor(() => expect(order).toContain("filtered:start"));
      expect(listQueries).toHaveLength(2);
      expect(listQueries[1]).toMatchObject({ agentId: "main" });
      expect(matchesFilter(listQueries[1])).toBe(true);

      order.push("filtered:resolve");
      filtered.resolve(filteredResult);
      if (invalidate) {
        await vi.waitFor(() => expect(order).toContain("later:start"));
        expect(sidebar.textContent).toContain("My session");
        vi.useFakeTimers();
        order.push("session:changed");
        gateway.publishEvent("sessions.changed", {
          sessionKey: "agent:main:unlisted",
          key: "agent:main:unlisted",
          agentId: "main",
          reason: "create",
        });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(listQueries.filter(matchesFilter)).toHaveLength(1);
        laterBootstrap.resolve();
        await heldLater;
      }
      await connectionBootstrap.run("queue-drained", async () => {
        order.push("queue-drained");
      });
      await sidebar.updateComplete;
      console.info("bootstrap RPC order", JSON.stringify({ order, listQueries }));
      expect(listQueries.filter(matchesFilter)).toHaveLength(invalidate ? 2 : 1);
      expect(sidebar.textContent).toContain(invalidate ? "Updated session" : "My session");
      expect(sessions.state.result?.sessions[0]?.label).toBe("Canonical session");
    } finally {
      primary.resolve(primaryResult);
      filtered.resolve(filteredResult);
      groups.resolve(emptyGroups);
      unrelatedBootstrap.resolve();
      laterBootstrap.resolve();
      await heldBootstrap;
      await heldLater;
      provider.remove();
      sessions.dispose();
      stopBootstrap();
      connectionBootstrap.reset();
      vi.useRealTimers();
    }
  });
});
