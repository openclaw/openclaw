/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { registerBrowserEnglish } from "../../i18n/locales/en-browser.ts";
import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import {
  createContext,
  createGatewayHarness,
  createSessions,
} from "../../test-helpers/app-sidebar.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { BrowserDocumentContent } from "./browser-document.tsx";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics as metrics,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
} from "./browser-panel-controller-test-support.ts";

registerEnglishCatalog(registerBrowserEnglish);
setupBrowserPanelTestCleanup();

it("shows its tool-result tab when the session never tracked that tab", async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  stubScreenshotMedia();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const tab = { target: "host", profile: "openclaw", targetId: "startup-tab" } as const;
  const url = "https://example.test/";
  const browser = createBrowserClient(async (request) => {
    if (request.path === "/tabs") {
      // The Gateway lists an untracked tab for a session only when the request references it.
      const referenced = request.tabScope?.referencedTabs?.some(
        (entry) => entry.targetId === tab.targetId,
      );
      return {
        running: true,
        tabs: referenced ? [{ tabId: "t1", targetId: tab.targetId, title: "Page", url }] : [],
      };
    }
    if (request.path === "/screenshot") {
      return { path: "/fresh.png", targetId: tab.targetId, url };
    }
    return request.path === "/act" ? metrics(url, "Page") : { ok: true };
  });
  const owner = createGatewayHarness(browser.client);
  owner.publish({ hello: gatewayHelloForMethods(["browser.request"]) });
  const view = mountSolid(() => (
    <BrowserDocumentContent
      value={{
        context: createContext(owner.gateway, createSessions("main", [])),
        target: { kind: "browser", sessionKey: "agent:main:main", tab },
        renderEscape: () => null,
      }}
    />
  ));

  await waitForSolid(() =>
    expect(browser.request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        path: "/screenshot",
        body: expect.objectContaining({ targetId: tab.targetId }),
      }),
    ),
  );
  expect(view.queryByText(/This tab is no longer available/)).toBeNull();
});
