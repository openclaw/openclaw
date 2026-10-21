import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
} from "../browser-panel-controller-test-support.ts";

/** Gateway responses for a rendered remote page; user actions still cross the native host. */
export function createBrowserPageClient(
  id: string,
  url = "https://example.test/page",
  title = "Page",
) {
  return createBrowserClient(async (request) => {
    if (request.path === "/tabs") {
      return { running: true, tabs: [createBrowserPanelTestTab(id, url, title)] };
    }
    if (request.path === "/screenshot") {
      return { path: "/fresh.png", targetId: `raw-${id}`, url };
    }
    if (request.path === "/act") {
      return createBrowserPanelTestMetrics(url, title);
    }
    if (request.path === "/download") {
      return { download: { path: "/managed/preview.png", suggestedFilename: "preview.png" } };
    }
    return { ok: true };
  });
}
