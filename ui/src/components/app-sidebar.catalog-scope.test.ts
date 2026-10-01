/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../test/helpers/record.js";
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
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
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
        auth: { role: "operator", scopes: ["operator.read"] },
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

describe("AppSidebar catalog authority", () => {
  it.each(["reply", "error", "page"] as const)(
    "retires cached and in-flight %s data on same-client scope loss",
    async (pendingKind) => {
      vi.useFakeTimers();
      const pending = deferred<ReturnType<typeof catalogPage>>();
      const request = vi
        .fn()
        .mockResolvedValue(
          catalogPage([{ threadId: "retained", name: "Retained catalog session" }], "page-2"),
        );
      const gateway = createGatewayHarness(createTestGatewayClient(request));
      const hello = gatewayHelloForMethods(["sessions.catalog.list"]);
      hello.features!.events = ["sessions.catalog.changed"];
      gateway.publish({ hello });
      const { sidebar, provider } = await mountSidebar(
        gateway.gateway,
        createSessions("main", ["agent:main:visitor-notes"]),
      );
      try {
        sidebar.connected = true;
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(0);
        await sidebar.updateComplete;
        expect(sidebar.textContent).toContain("Retained catalog session");
        expect(
          sidebar.querySelector('[data-session-key="agent:main:visitor-notes"]'),
        ).not.toBeNull();
        request.mockReturnValueOnce(pending.promise);
        const loading =
          pendingKind === "page"
            ? sidebar.sessionData.loadMoreSessionCatalog("codex")
            : sidebar.sessionData.refreshSessionCatalogs();
        const progressId = request.mock.calls.at(-1)?.[1]?.progressId;
        expect(request).toHaveBeenCalledTimes(2);

        gateway.publish({
          hello: { ...hello, auth: { role: "operator", scopes: ["operator.sessions.write"] } },
        });
        // No Lit render or promise turn separates authority loss from these events.
        gateway.publishEvent("sessions.catalog.host", {
          progressId,
          agentId: "main",
          catalog: catalogPage([{ threadId: "stale", name: "Late catalog session" }]).catalogs[0],
        });
        gateway.publishEvent("sessions.catalog.changed", { agentId: "main" });
        if (pendingKind === "error") {
          pending.reject(new Error("Stale catalog failure"));
        } else {
          pending.resolve(catalogPage([{ threadId: "stale", name: "Late catalog session" }]));
        }
        await loading;
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(600_000);
        await sidebar.updateComplete;
        expect(sidebar.textContent).not.toContain("Retained catalog session");
        expect(sidebar.textContent).not.toContain("Late catalog session");
        expect(sidebar.querySelector(".sidebar-session-catalog-error")).toBeNull();
        expect(sidebar.sessionData.sessionCatalogs).toEqual([]);
        expect(sidebar.sessionData.sessionCatalogPageDepths.size).toBe(0);
        expect(sidebar.sessionData.sessionCatalogRevisions.size).toBe(0);
        expect(sidebar.sessionData.loadingMoreSessionCatalogIds.size).toBe(0);
        expect(sidebar.sessionData.sessionCatalogLive.timer).toBeNull();
        expect(request).toHaveBeenCalledTimes(2);
        expect(
          sidebar.querySelector('[data-session-key="agent:main:visitor-notes"]'),
        ).not.toBeNull();

        gateway.publish({ hello });
        await sidebar.updateComplete;
        await vi.advanceTimersByTimeAsync(0);
        await sidebar.updateComplete;
        expect(request).toHaveBeenCalledTimes(3);
        expect(sidebar.textContent).toContain("Retained catalog session");
      } finally {
        pending.resolve(catalogPage([]));
        provider.remove();
        vi.useRealTimers();
      }
    },
  );
});
