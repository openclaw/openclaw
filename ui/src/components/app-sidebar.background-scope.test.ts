/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { createConnectionBootstrapCoordinator } from "../app/connection-bootstrap.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { createFrameClock } from "../test-helpers/animation-frame-clock.ts";
import {
  createContext,
  createGatewayHarness,
  createSidebarElement,
  type SidebarLifecycleState,
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
import { childToggle, mountRoster } from "./app-sidebar-freshness.test-support.ts";
import "./app-sidebar.tsx";
import {
  storeSidebarSessionOwnerFilter,
  storeSidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";

type Query = NonNullable<ReturnType<typeof asOptionalRecord>>;
const makeRow = (key: string, fields: Partial<GatewaySessionRow>): GatewaySessionRow => ({
  key,
  kind: "direct",
  ...fields,
});
async function advance(sidebar: SidebarLifecycleState, ms = 50) {
  await vi.advanceTimersByTimeAsync(ms);
  await settleLitElement(sidebar);
}
function mountSessionRoster(
  list: (params: Query) => unknown,
  describeSession?: (params: Query) => unknown,
) {
  const request: GatewayRequestHandler = async (method, raw) => {
    const params = asOptionalRecord(raw) ?? {};
    if (method === "sessions.list") {
      return list(params);
    }
    if (method === "sessions.describe") {
      return describeSession?.(params) ?? {};
    }
    return method === "sessions.subscribe" ? { subscribed: true } : {};
  };
  return mountRoster(request, TWO_AGENTS);
}

describe("AppSidebar automatic list scope replacement", () => {
  it("publishes a pending status-filter list before its data frame and restores identical rows", async () => {
    vi.useFakeTimers();
    storeSidebarSessionStatusFilter("all");
    const archivedRow = makeRow("agent:main:archived", {
      displayName: "Archived conversation",
      archived: true,
    });
    const response = sessionsResult([archivedRow], 1);
    const pending = deferred<ReturnType<typeof sessionsResult>>();
    const { sidebar, sessions } = await mountSessionRoster((params) =>
      params.archived === true
        ? pending.promise
        : params.archived === "all"
          ? response
          : sessionsResult([], 0),
    );
    let unsubscribe: (() => void) | undefined;
    try {
      sidebar.connected = true;
      await advance(sidebar);
      expect(sidebar.textContent).toContain(archivedRow.displayName);

      const framesClock = createFrameClock();
      vi.stubGlobal("requestAnimationFrame", framesClock.request);
      vi.stubGlobal("cancelAnimationFrame", framesClock.cancel);
      sidebar.sessionOrganizer.setSessionsStatusFilter("archived");
      await settleLitElement(sidebar);
      expect(sidebar.textContent).not.toContain(archivedRow.displayName);

      const published = deferred();
      unsubscribe = sessions.subscribeList(
        sidebar.sessionData.sessionListQuery("main"),
        (snapshot) => {
          if (!snapshot.loading && snapshot.result) {
            published.resolve();
          }
        },
      );
      pending.resolve(response);
      await published.promise;
      framesClock.flush(performance.now());
      await settleLitElement(sidebar);
      expect(sidebar.textContent).toContain(archivedRow.displayName);
    } finally {
      unsubscribe?.();
      pending.resolve(response);
    }
  });

  it("discovers current child parents after background work was queued", async () => {
    const makeParent = (name: string, childName: string, label?: string) =>
      makeRow(`agent:main:${name}`, {
        label,
        childSessions: [`agent:main:${childName}`],
      });
    const previousParent = makeParent("previous-parent", "previous-child", "Previous parent");
    const nextParent = makeParent("next-parent", "next-child", "Next parent");
    const mainParent = makeParent("main", "main-child");
    const children: GatewaySessionRow[] = [previousParent, nextParent, mainParent].map((parent) =>
      makeRow(parent.childSessions![0]!, {
        label: `${parent.key} child`,
        spawnedBy: parent.key,
      }),
    );
    let roots = [previousParent];
    const parents: unknown[] = [];
    const { sidebar, context, sessions } = await mountSessionRoster(
      (params) => {
        if (params.spawnedBy) {
          parents.push(params.spawnedBy);
          return sessionsResult(
            children.filter((row) => row.spawnedBy === params.spawnedBy),
            2,
          );
        }
        return sessionsResult(roots, 1);
      },
      ({ key }) => ({ session: [...roots, ...children].find((row) => row.key === key) ?? null }),
    );
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
    expect(childToggle(sidebar, previousParent.key)?.getAttribute("aria-expanded")).toBe("false");

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
    const expand = childToggle(sidebar, nextParent.key);
    expect(expand?.getAttribute("aria-expanded")).toBe("true");
    expect(sidebar.textContent).toContain(`${nextParent.key} child`);
    expect(parents).toHaveLength(2);
  });

  it("queues automatic filtered rosters but loads deliberate selection before chat readiness", async () => {
    vi.useFakeTimers();
    const previous = deferred<ReturnType<typeof sessionsResult>>();
    const targets: unknown[] = [];
    let mainReads = 0;
    const archived = (agentId: string, label: string) =>
      sessionsResult(
        [{ key: `agent:${agentId}:archived`, kind: "direct", archived: true, label }],
        1,
      );
    const { sidebar, context } = await mountSessionRoster((params) => {
      if (params.archived !== true) {
        return sessionsResult([], 0);
      }
      targets.push(params.agentId);
      if (params.agentId === "research") {
        return previous.promise;
      }
      return archived("main", `Main archived ${++mainReads}`);
    });
    try {
      sidebar.connected = true;
      await settleLitElement(sidebar);
      sidebar.sessionOrganizer.setSessionsStatusFilter("archived");
      await vi.advanceTimersByTimeAsync(0);
      await settleLitElement(sidebar);
      expect(sidebar.textContent).toContain("Main archived 1");

      context.connectionBootstrap.setForegroundRoute("agent:research:pending");
      context.agentSelection.set("main");
      context.agentSelection.set("research", { background: true });
      await settleLitElement(sidebar);
      await vi.advanceTimersByTimeAsync(50);
      expect(targets).toEqual(["main"]);
      expect(sidebar.textContent).not.toContain("Main archived 1");
      context.connectionBootstrap.setForegroundRoute(null);
      await vi.advanceTimersByTimeAsync(50);
      expect(targets).toEqual(["main", "research"]);
      context.connectionBootstrap.setForegroundRoute("agent:main:pending");
      context.agentSelection.set("main");
      await settleLitElement(sidebar);
      await vi.advanceTimersByTimeAsync(50);
      previous.resolve(archived("research", "Stale Research archived"));
      await advance(sidebar);

      expect(sidebar.textContent).not.toContain("Stale Research archived");
      expect(targets).toEqual(["main", "research", "main"]);
      expect(sidebar.textContent).toContain("Main archived 2");
    } finally {
      previous.resolve(sessionsResult([], 0));
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
      const rows = [
        makeRow(mainParent, { label: "Main parent", childSessions: [mainChild] }),
        makeRow(researchParent, { label: "Next parent", childSessions: [researchChild] }),
        makeRow(mainChild, { label: "Stale Main child", spawnedBy: mainParent }),
        makeRow(researchChild, { label: "Next child", spawnedBy: researchParent }),
      ];
      const previous = deferred<ReturnType<typeof sessionsResult>>();
      const parents: unknown[] = [];
      let primaryReads = 0;
      const { sidebar, context, sessions } = await mountSessionRoster(
        (params) => {
          if (params.spawnedBy) {
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
        ({ key }) => ({ session: rows.find((row) => row.key === key) ?? null }),
      );
      try {
        sidebar.activeRouteId = "chat";
        sidebar.sessionKey = mainParent;
        sidebar.connected = true;
        await settleLitElement(sidebar);
        await vi.advanceTimersByTimeAsync(50);
        expect(parents).toEqual([mainParent]);

        context.agentSelection.set(nextAgent);
        sidebar.sessionKey = researchParent;
        if (nextAgent !== "main") {
          await sessions.refresh({ agentId: nextAgent, force: true });
        }
        await settleLitElement(sidebar);
        await vi.advanceTimersByTimeAsync(50);
        expect(primaryReads).toBe(nextAgent === "main" ? 1 : 2);
        previous.resolve(
          sessionsResult(
            rows.filter((row) => row.key === mainChild),
            1,
          ),
        );
        await advance(sidebar);

        if (nextAgent !== "main") {
          expect(sidebar.textContent).not.toContain("Stale Main child");
        }
        expect(parents).toEqual([mainParent, researchParent]);
        const expand = childToggle(sidebar, researchParent);
        expect(expand).not.toBeNull();
        expect(expand?.getAttribute("aria-expanded")).toBe(nextAgent === "main" ? "false" : "true");
        if (nextAgent === "main") {
          expand!.click();
        }
        await settleLitElement(sidebar);
        await vi.advanceTimersByTimeAsync(0);
        expect(sidebar.textContent).toContain("Next child");
        expect(parents).toEqual([mainParent, researchParent]);
      } finally {
        previous.resolve(sessionsResult([], 0));
      }
    },
  );
});

describe("AppSidebar initial managed-list hydration", () => {
  it.each([
    ["ordinary overlap", false, false, "self"],
    ["queued initial fill", true, false, "self"],
    ["queued initial fill with a later event", true, true, "self"],
    ["saved owner", true, false, "owner"],
    ["saved involving me", true, false, "involving-me"],
  ] as const)(
    "paints filtered sessions before group metadata during %s",
    async (_name, holdSecondSlot, invalidate, filter) => {
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
        [makeRow("agent:main:primary", { label: "Canonical session" })],
        1,
      );
      const ownRow = (label: string) =>
        makeRow("agent:main:mine", {
          label,
          owner: { actor: { type: "human", id: "synthetic-operator" } },
        });
      const filteredResult = sessionsResult([ownRow("My session")], 1);
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
              return sessionsResult([ownRow("Updated session")], 2);
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
      const sidebar = await createSidebarElement();
      if (filter !== "self") {
        storeSidebarSessionOwnerFilter(
          gateway.gateway.connection.gatewayUrl,
          "synthetic-operator",
          {
            ownerId: filter === "owner" ? "synthetic-operator" : null,
            involvingMe: filter === "involving-me",
          },
        );
      }
      provider.append(sidebar.hostElement);
      document.body.append(provider);
      await settleLitElement(sidebar);
      const heldLater = invalidate
        ? connectionBootstrap.run("later-bootstrap", async () => {
            order.push("later:start");
            await laterBootstrap.promise;
          })
        : Promise.resolve();
      try {
        sidebar.connected = true;
        await settleLitElement(sidebar);
        expect(listQueries).toHaveLength(holdSecondSlot ? 1 : 2);
        expect(listQueries[0]).toMatchObject({ ownerFirst: true, agentId: "main" });
        expect(order).not.toContain("groups:start");

        primary.resolve(primaryResult);
        await vi.waitFor(() => expect(order).toContain("filtered:start"));
        await vi.waitFor(() =>
          expect(sessions.state.result?.sessions[0]?.label).toBe("Canonical session"),
        );
        expect(listQueries).toHaveLength(2);
        expect(listQueries[1]?.agentId).toBe(filter === "involving-me" ? "main" : undefined);
        expect(matchesFilter(listQueries[1])).toBe(true);

        filtered.resolve(filteredResult);
        await vi.waitFor(() => expect(sidebar.textContent).toContain("My session"));
        await vi.waitFor(() => expect(order).toContain("groups:start"));
        groups.resolve(emptyGroups);
        if (invalidate) {
          await vi.waitFor(() => expect(order).toContain("later:start"));
          expect(sidebar.textContent).toContain("My session");
          vi.useFakeTimers();
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
        await connectionBootstrap.run("queue-drained", async () => {});
        await settleLitElement(sidebar);
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
    },
  );
});
