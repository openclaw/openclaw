/* @vitest-environment jsdom */

import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { ApplicationGatewaySnapshot } from "../app/context.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessions,
  mountSidebar,
  TWO_AGENTS,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import "./app-sidebar.ts";

const requireRecord = createRequireRecord("object", "expected-label");

describe("AppSidebar catalog scope replacement", () => {
  it("loads the newly selected agent after an old scope's automatic catalog read settles", async () => {
    vi.useFakeTimers();
    const previous = deferred<ReturnType<typeof catalogPage>>();
    const reads: string[] = [];
    const client = createTestGatewayClient(async (method, params) => {
      expect(method).toBe("sessions.catalog.list");
      const agentId = requireRecord(params, "catalog query").agentId;
      if (typeof agentId !== "string") {
        throw new Error("Catalog query has no agent owner");
      }
      reads.push(agentId);
      return agentId === "main"
        ? previous.promise
        : catalogPage([{ threadId: "research-thread", name: "Research catalog session" }]);
    });
    const gateway = createGatewayHarness(client);
    gateway.publish({
      hello: {
        features: { methods: ["sessions.catalog.list"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const { sidebar, context, provider } = await mountSidebar(
      gateway.gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    try {
      sidebar.connected = true;
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toEqual(["main"]);

      context.agentSelection.set("research");
      await sidebar.updateComplete;
      await vi.advanceTimersByTimeAsync(50);
      expect(sidebar.sessionData.sessionCatalogAgentId).toBe("research");
      previous.resolve(
        catalogPage([{ threadId: "stale-main", name: "Stale Main catalog session" }]),
      );
      await vi.advanceTimersByTimeAsync(50);
      await sidebar.updateComplete;

      expect(sidebar.textContent).not.toContain("Stale Main catalog session");
      expect(reads).toEqual(["main", "research"]);
      expect(sidebar.textContent).toContain("Research catalog session");
    } finally {
      previous.resolve(catalogPage([]));
      provider.remove();
      await sidebar.updateComplete;
      vi.useRealTimers();
    }
  });
});
