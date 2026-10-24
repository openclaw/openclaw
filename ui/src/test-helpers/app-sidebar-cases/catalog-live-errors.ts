import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { catalogPage, createSessions, mountSidebar } from "../app-sidebar.ts";
import { domProbe } from "../dom-probe.ts";
import "../../components/app-sidebar.tsx";
import {
  agentList,
  catalogGateway,
  mountCatalog,
  startCatalog,
  settleCatalog,
} from "./compact.test-support.ts";

describe("AppSidebar session catalog request errors", () => {
  beforeEach(() => vi.useFakeTimers());
  it.each([
    ["hello default", "roboclaw", "roboclaw", null, "roboclaw"],
    ["pre-roster conflict", "roboclaw", "main", null, null],
    ["unknown selection", "main", "main", agentList([{ id: "roboclaw" }], "roboclaw"), "roboclaw"],
    ["missing default", null, "main", null, null],
  ] as const)(
    "resolves the catalog agent: %s",
    async (_name, assistantAgentId, selectedId, agents, expected) => {
      const request = vi.fn().mockResolvedValue({ catalogs: [] });
      await mountCatalog({ request } as unknown as GatewayBrowserClient, {
        snapshot: { assistantAgentId },
        sessions: createSessions(selectedId, [`agent:${selectedId}:main`]),
        agents,
      });
      if (expected) {
        expect(request).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledWith(
          "sessions.catalog.list",
          expect.objectContaining({ agentId: expected }),
        );
      } else {
        expect(request).not.toHaveBeenCalled();
      }
    },
  );

  it("uses the roster default when no agent is selected", async () => {
    const request = vi.fn().mockResolvedValue({ catalogs: [] });
    const gateway = catalogGateway({ request } as unknown as GatewayBrowserClient);
    const { sidebar, context } = await mountSidebar(
      gateway.gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      agentList([{ id: "main" }, { id: "roboclaw" }], "roboclaw"),
    );
    context.agentSelection.state.selectedId = null;
    await startCatalog(sidebar);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "sessions.catalog.list",
      expect.objectContaining({ agentId: "roboclaw" }),
    );
  });

  it("ignores a roster owned by a replaced gateway client", async () => {
    const request = vi.fn().mockResolvedValue({ catalogs: [] });
    const currentClient = { request } as unknown as GatewayBrowserClient;
    const gateway = catalogGateway(currentClient, { assistantAgentId: "roboclaw" });
    const { sidebar, context } = await mountSidebar(
      gateway.gateway,
      createSessions("roboclaw", ["agent:roboclaw:main"]),
      "panel",
      agentList([{ id: "roboclaw" }], "roboclaw"),
    );
    expect(context.agentSelection.state.selectedId).toBe("roboclaw");
    // Establish selection from the current roster before exposing a stale snapshot.
    context.agents.state.client = {
      request: vi.fn(),
    } as unknown as GatewayBrowserClient;
    context.agents.state.agentsList = agentList([{ id: "main" }]);
    await startCatalog(sidebar);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "sessions.catalog.list",
      expect.objectContaining({ agentId: "roboclaw" }),
    );
  });

  it("queues one recovery when a pending catalog rejects after admission reopens", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pending = deferred<ReturnType<typeof catalogPage>>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(catalogPage([{ threadId: "thread-one", name: "Retained session" }]))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(catalogPage([{ threadId: "thread-one", name: "Recovered session" }]));
    const { sidebar, gateway } = await mountCatalog(
      { request } as unknown as GatewayBrowserClient,
      { snapshot: { suspensionPhase: "accepting" } },
    );
    const dom = domProbe(sidebar);
    const refresh = sidebar.sessionData.refreshSessionCatalogs();
    gateway.publish({ suspensionPhase: "draining" });
    gateway.publish({ suspensionPhase: "accepting" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(2);
    pending.reject(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Gateway is suspending",
        retryable: true,
        details: { reason: "gateway-suspending", phase: "draining" },
      }),
    );
    await refresh;
    await settleCatalog(sidebar);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(request).toHaveBeenCalledTimes(2);
    await settleCatalog(sidebar, 1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(sidebar.textContent).toContain("Recovered session");
    expect(dom.query(".sidebar-session-catalog-error")).toBeNull();
  });

  it.each([
    {
      code: "UNAVAILABLE",
      reason: "gateway-suspending",
      message: "sessions.catalog.list unavailable during gateway suspension",
    },
    { code: "UNAVAILABLE", reason: undefined, message: "Catalog service unavailable" },
    { code: "INVALID_REQUEST", reason: undefined, message: 'unknown agent id "main"' },
  ])("recovers $code/$reason when admission reopens", async ({ code, reason, message }) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = vi
      .fn()
      .mockResolvedValue(catalogPage([{ threadId: "thread-one", name: "Retained session" }]));
    const { sidebar, gateway } = await mountCatalog(
      { request } as unknown as GatewayBrowserClient,
      { snapshot: { suspensionPhase: "accepting" } },
    );
    const dom = domProbe(sidebar);
    await sidebar.updateComplete;
    expect(sidebar.textContent).toContain("Retained session");
    request.mockRejectedValue(
      new GatewayRequestError({
        code,
        message,
        retryable: Boolean(reason),
        details: reason ? { reason, phase: "draining" } : undefined,
      }),
    );
    if (reason) {
      gateway.publish({ suspensionPhase: "draining" });
    }
    await sidebar.sessionData.refreshSessionCatalogs();
    await sidebar.updateComplete;
    const error = dom.query<HTMLElement>(".sidebar-session-catalog-error");
    if (reason) {
      expect(error).toBeNull();
    } else {
      expect(error?.textContent).toContain(message);
      expect(error?.textContent).toContain("Showing stale data");
      expect(error?.querySelector("button")).toBeNull();
      gateway.publish({ suspensionPhase: "draining" });
    }
    expect(sidebar.textContent).toContain("Retained session");
    expect(request).toHaveBeenCalledTimes(2);
    request.mockResolvedValue(catalogPage([{ threadId: "thread-one", name: "Recovered session" }]));
    gateway.publish({ suspensionPhase: "accepting" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(request).toHaveBeenCalledTimes(2);
    await settleCatalog(sidebar, 1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(sidebar.textContent).toContain("Recovered session");
    expect(dom.query(".sidebar-session-catalog-error")).toBeNull();
    gateway.publish({ assistantAgentId: "main" });
    await vi.advanceTimersByTimeAsync(50);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
