import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cssPath = [
  resolve(process.cwd(), "ui/src/styles/config-quick.css"),
  resolve(process.cwd(), "..", "ui/src/styles/config-quick.css"),
].find((candidate) => existsSync(candidate));
if (!cssPath) {
  throw new Error(`config-quick.css not found from cwd: ${process.cwd()}`);
}
const css = readFileSync(cssPath, "utf8");
const mainSource = readFileSync(resolve(process.cwd(), "ui/src/main.ts"), "utf8");
const serviceWorkerSource = readFileSync(resolve(process.cwd(), "ui/public/sw.js"), "utf8");

describe("config-quick styles", () => {
  it("includes the local user identity quick-settings styles", () => {
    expect(css).toContain(".qs-identity-grid");
    expect(css).toContain(".qs-identity-card__source");
    expect(css).toContain(".qs-identity-card__issue");
    expect(css).toContain(".qs-identity-card__repair");
    expect(css).toContain(".qs-identity-card__error");
    expect(css).toContain(".qs-assistant-avatar");
    expect(css).toContain(".qs-user-avatar");
    expect(css).toContain(".qs-card--personal");
  });

  it("keeps chat identity profile pictures large enough to inspect", () => {
    expect(css).toContain(".qs-user-avatar,\n.qs-assistant-avatar {\n  width: 72px;");
    expect(css).toContain("height: 72px;");
    expect(css).toContain(".qs-user-avatar--default svg {\n  width: 24px;");
  });

  it("forces service worker update checks around the network-first production shell", () => {
    expect(mainSource).toContain('updateViaCache: "none"');
    expect(mainSource).toContain("registration.update()");
    expect(mainSource).toContain("SERVICE_WORKER_SKIP_WAITING_MESSAGE");
    expect(mainSource).toContain("controllerchange");
    expect(mainSource).toContain("hadServiceWorkerControllerAtStartup");
    expect(mainSource).toContain("SERVICE_WORKER_RELOAD_STORAGE_KEY");
    expect(serviceWorkerSource).toContain('CACHE_NAME = "openclaw-control-v18"');
    expect(serviceWorkerSource).toContain("APP_SHELL_URLS");
    expect(serviceWorkerSource).toContain('ASSET_MANIFEST_URL = "./asset-manifest.json"');
    expect(serviceWorkerSource).toContain("cacheAssetManifest");
    expect(serviceWorkerSource).toContain("void cacheAssetManifest(cache, { criticalOnly: true })");
    expect(serviceWorkerSource).toContain("warmAppAssets");
    expect(serviceWorkerSource).toContain("refreshNavigationShell");
    expect(serviceWorkerSource).toContain("cacheNavigationResponse");
    expect(serviceWorkerSource).toContain('cache: "no-store"');
    expect(serviceWorkerSource).toContain('fetch(event.request, { cache: "no-store" })');
    expect(serviceWorkerSource).toContain('SERVICE_WORKER_UPDATE_QUERY = "__openclaw_sw_update"');
    expect(serviceWorkerSource).toContain("url.searchParams.has(SERVICE_WORKER_UPDATE_QUERY)");
    expect(serviceWorkerSource).toContain('event.request.mode === "navigate"');
    expect(serviceWorkerSource).toContain('includes("text/html")');
    expect(serviceWorkerSource).toContain("cachedShell");
    expect(serviceWorkerSource).toContain(
      "event.waitUntil(Promise.all([refreshNavigationShell(event.request), warmAppAssets()]))",
    );
    expect(serviceWorkerSource).toContain("OPENCLAW_CONTROL_SW_SKIP_WAITING");
    expect(serviceWorkerSource).toContain("typeof event.data");
    expect(mainSource).toContain(
      "registration?.waiting?.postMessage(SERVICE_WORKER_SKIP_WAITING_MESSAGE)",
    );
  });

  it("includes the dashboard quick-settings density layout", () => {
    expect(css).toContain(".qs-card--model");
    expect(css).toContain(".qs-card--automations");
    expect(css).toContain(".qs-side-stack");
    expect(css).toContain("grid-template-rows: auto 1fr;");
    expect(css).toContain(".qs-identity-card__actions");
    expect(css).toContain("grid-template-columns: repeat(12, minmax(0, 1fr));");
    expect(css).toContain("grid-column: 1 / -1;");
    expect(css).toContain("grid-column: span 4;");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(css).toContain("align-items: stretch;");
    expect(css).toContain("display: contents;");
    expect(css).toContain(".qs-card--appearance {\n    order: 4;");
    expect(css).toContain(".qs-card--appearance");
    expect(css).toContain("order: 4");
    expect(css).toContain(".qs-card--automations");
    expect(css).toContain("order: 6");
  });

  it("includes explicit context profile layout hooks", () => {
    expect(css).toContain(".qs-profiles");
    expect(css).toContain(".qs-profile-state--pending");
    expect(css).toContain(".qs-profile-panel__actions-row");
  });

  it("avoids transition-all in the quick settings surface", () => {
    expect(css).not.toContain("transition: all");
  });
});
