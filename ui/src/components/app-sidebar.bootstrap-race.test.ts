/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { createConnectionBootstrapCoordinator } from "../app/connection-bootstrap.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createContext,
  createGatewayHarness,
  mountSidebarContext,
  TWO_AGENTS,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../test-helpers/gateway-methods.ts";
import { storeSidebarSessionOwnerFilter } from "./app-sidebar-session-types.ts";
import "./app-sidebar.ts";

describe("AppSidebar initial managed-list hydration", () => {
  it.each([
    { name: "ordinary overlap", holdSecondSlot: false, invalidate: false },
    { name: "queued initial fill", holdSecondSlot: true, invalidate: false },
    { name: "queued initial fill with a later event", holdSecondSlot: true, invalidate: true },
  ])("keeps only required filtered reads during $name", async ({ holdSecondSlot, invalidate }) => {
    const primary = createDeferred<ReturnType<typeof sessionsResult>>();
    const filtered = createDeferred<ReturnType<typeof sessionsResult>>();
    const groups = createDeferred<{ names: string[]; groups: never[]; sectionOrder: string[] }>();
    const unrelatedBootstrap = createDeferred();
    const laterBootstrap = createDeferred();
    const order: string[] = [];
    const listQueries: Record<string, unknown>[] = [];
    const primaryResult = sessionsResult(
      [{ key: "agent:main:primary", kind: "direct", label: "Canonical session" }],
      1,
    );
    const filteredResult = sessionsResult(
      [{ key: "agent:main:mine", kind: "direct", label: "My session" }],
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
        listQueries.push({ ...params });
        if (params?.involvingMe === true) {
          order.push("filtered:start");
          if (invalidate && listQueries.filter((query) => query.involvingMe === true).length > 1) {
            return sessionsResult(
              [{ key: "agent:main:mine", kind: "direct", label: "Updated session" }],
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
    storeSidebarSessionOwnerFilter(gateway.gateway.connection.gatewayUrl, "synthetic-operator", {
      ownerId: null,
      involvingMe: true,
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
    const { sidebar, provider } = await mountSidebarContext(context);
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
      expect(listQueries[1]).toMatchObject({ involvingMe: true, agentId: "main" });

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
        await vi.advanceTimersByTimeAsync(200);
        expect(listQueries.filter((query) => query.involvingMe === true)).toHaveLength(1);
        laterBootstrap.resolve();
        await heldLater;
      }
      await connectionBootstrap.run("queue-drained", async () => {
        order.push("queue-drained");
      });
      await sidebar.updateComplete;
      console.info("bootstrap RPC order", JSON.stringify({ order, listQueries }));
      expect(listQueries.filter((query) => query.involvingMe === true)).toHaveLength(
        invalidate ? 2 : 1,
      );
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
