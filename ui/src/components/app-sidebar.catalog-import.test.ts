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
