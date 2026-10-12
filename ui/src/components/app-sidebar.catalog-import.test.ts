/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { SessionsCatalogImportResult } from "../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import "../test-helpers/app-sidebar-suite.ts";
import {
  catalogPage,
  createGatewayHarness,
  createSessions,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import "./app-sidebar.ts";

const result: SessionsCatalogImportResult = {
  sessionKey: "agent:main:imported-transcript",
  importedItems: 2,
  totalItems: 2,
  complete: true,
  created: true,
};

async function fixture(scopes = ["operator.read", "operator.write"]) {
  vi.useFakeTimers();
  const imported = createDeferred<SessionsCatalogImportResult>();
  const catalog = catalogPage([{ threadId: "thread-1", name: "Keep these notes" }]);
  catalog.catalogs[0]!.hosts[0]!.sessions[0]!.sourceHomeId = "home-1";
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.catalog.import") {
      return imported.promise;
    }
    return catalog;
  });
  const gateway = createGatewayHarness(createTestGatewayClient(request));
  gateway.publish({ hello: gatewayHelloForMethods(["sessions.catalog.list"], scopes) });
  const { sidebar } = await mountSidebar(
    gateway.gateway,
    createSessions("main", ["agent:main:main"]),
  );
  sidebar.connected = true;
  sidebar.onNavigate = vi.fn();
  const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
  await sidebar.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  sidebar
    .querySelector('[data-catalog-session-key*="thread-1"]')!
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  const selectImport = () => {
    const item = sidebar.querySelector('wa-dropdown-item[value="import"]');
    expect(item).not.toBeNull();
    item!.dispatchEvent(
      new CustomEvent("wa-select", { bubbles: true, detail: { item: { value: "import" } } }),
    );
  };
  return { sidebar, toast, gateway, request, imported, selectImport };
}

describe("AppSidebar catalog import", () => {
  it.each([
    { outcome: "success", stale: false },
    { outcome: "failure", stale: false },
    { outcome: "success", stale: true },
    { outcome: "failure", stale: true },
  ])("publishes only a current import $outcome (stale=$stale)", async ({ outcome, stale }) => {
    const { sidebar, toast, gateway, request, imported, selectImport } = await fixture();
    selectImport();
    expect(request).toHaveBeenCalledWith("sessions.catalog.import", {
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-1",
      sourceHomeId: "home-1",
      agentId: "main",
      displayName: "Keep these notes",
    });
    if (stale) {
      gateway.publish({ phase: "reconnecting" });
      await sidebar.updateComplete;
    }
    if (outcome === "success") {
      imported.resolve(result);
    } else {
      imported.reject(new Error("Source device is unavailable"));
    }
    await vi.advanceTimersByTimeAsync(0);
    await toast.updateComplete;
    expect(sidebar.onNavigate).not.toHaveBeenCalled();
    if (stale) {
      expect(toast.textContent?.trim()).toBe("");
    } else if (outcome === "failure") {
      expect(toast.textContent).toContain("Source device is unavailable");
    } else {
      expect(toast.textContent).toContain("Imported 2 transcript items.");
      const nativeRow = sidebar.querySelector('[data-catalog-session-key*="thread-1"]');
      expect(nativeRow?.getAttribute("data-session-key")).toContain(":catalog:codex:");
      toast.querySelector<HTMLButtonElement>(".app-toast__action")!.click();
      expect(sidebar.onNavigate).toHaveBeenCalledWith("chat", {
        pathname: "/chat/main/imported-transcript",
        search: "",
        hash: "",
      });
    }
  });

  it.each(["read-only", "revoked"])("denies import with %s authority", async (authority) => {
    const { sidebar, gateway, request, selectImport } = await fixture(
      authority === "read-only" ? ["operator.read"] : ["operator.read", "operator.write"],
    );
    if (authority === "read-only") {
      expect(sidebar.querySelector('wa-dropdown-item[value="import"]')).toBeNull();
    } else {
      gateway.publish({
        hello: gatewayHelloForMethods(["sessions.catalog.list"], ["operator.read"]),
      });
      selectImport();
    }
    expect(request).not.toHaveBeenCalledWith("sessions.catalog.import", expect.anything());
  });
});

describe("AppSidebar catalog authority", () => {
  it.each(["reply", "error", "page"] as const)(
    "retires cached and in-flight %s data on same-client scope loss",
    async (pendingKind) => {
      vi.useFakeTimers();
      const pending = createDeferred<ReturnType<typeof catalogPage>>();
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
