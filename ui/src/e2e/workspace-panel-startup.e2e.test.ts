import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { terminalSession } from "./workspace-terminal.test-support.ts";

const suite = createControlUiE2eSuite({ name: "workspace panel startup" });
const panels = [
  { name: "terminal", tag: "openclaw-terminal-panel", selector: ".tp-header" },
  { name: "browser", tag: "openclaw-browser-panel", selector: ".bp" },
  { name: "desktop", tag: "openclaw-desktop-panel", selector: ".bp" },
  { name: "custodian", tag: "openclaw-assistant-panel", selector: ".assistant-panel" },
] as const;
const deferredPanelTags = panels.map((panel) =>
  panel.name === "custodian" ? "openclaw-assistant-panel-content" : panel.tag,
);

suite.define(() => {
  it.each(panels)(
    "loads only the requested $name panel content and restores it on reload",
    async (panel) => {
      await suite.withPage(
        { serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          if (panel.name === "terminal") {
            await page.addInitScript(() => {
              const getItem = Storage.prototype.getItem;
              Object.defineProperty(Storage.prototype, "getItem", {
                value(this: Storage, key: string) {
                  if (
                    this === window.localStorage &&
                    /^openclaw\.(terminal|browser|custodian)\.panel\.v1$/.test(key)
                  ) {
                    performance.mark(`panel-layout-read:${key}`);
                  }
                  return getItem.call(this, key);
                },
              });
            });
          }
          const scripts = new Set<string>();
          page.on("request", (request) => {
            if (new URL(request.url()).pathname.endsWith(".js")) {
              scripts.add(request.url());
            }
          });
          const session = terminalSession("startup-terminal");
          const gateway = await installMockGateway(page, {
            terminalEnabled: true,
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "terminal.open",
              "browser.request",
              "desktop.observe",
              "openclaw.chat",
              "openclaw.chat.history",
            ],
            methodResponses: {
              "terminal.list": { sessions: [] },
              "terminal.open": session,
              "environments.list": { environments: [] },
            },
          });
          await page.goto(`${suite.server.baseUrl}new`);
          await waitForControlUiGatewayReady(page);
          await page.locator(".new-session-page__message").waitFor();
          await page.waitForLoadState("networkidle");
          const definitions = () =>
            page.evaluate(
              (tags) => tags.filter((tag) => customElements.get(tag)),
              deferredPanelTags,
            );
          expect(await definitions()).toEqual([]);
          if (panel.name === "terminal") {
            const reads = await page.evaluate(() =>
              ["terminal", "browser", "custodian"].map(
                (kind) =>
                  performance.getEntriesByName(`panel-layout-read:openclaw.${kind}.panel.v1`)
                    .length,
              ),
            );
            expect(reads).toEqual([1, 1, 1]);
            const sources = (
              await Promise.all(
                [...scripts].map(async (url) => {
                  const response = await page.request.get(`${url}.map`);
                  return response.headers()["content-type"]?.includes("json")
                    ? ((await response.json()) as { sources: string[] }).sources
                    : [];
                }),
              )
            ).flat();
            expect(sources.some((source) => source.endsWith("/app/app-host.tsx"))).toBe(true);
            const deferredSource =
              /components\/(terminal\/terminal-panel\.ts|browser\/browser-panel\.ts|desktop\/desktop-panel\.ts|assistant-panel-content\.ts)$|pages\/(chat\/chat-page|debug\/debug-overlay-content)\.ts$/;
            expect(sources.filter((source) => deferredSource.test(source))).toEqual([]);
          }
          if (panel.name === "terminal") {
            await page.keyboard.press("Control+Backquote");
          } else if (panel.name === "browser") {
            await gateway.emitGatewayEvent("ui.command", {
              command: { kind: "panel", panel: "browser", open: true },
            });
          } else {
            await page.evaluate(
              (name) =>
                window.dispatchEvent(
                  new CustomEvent(`openclaw:${name}-toggle`, { detail: { open: true } }),
                ),
              panel.name,
            );
          }
          const root = page.locator(panel.tag);
          const content = root.locator(panel.selector);
          await content.waitFor();
          const deferredTag =
            panel.name === "custodian" ? "openclaw-assistant-panel-content" : panel.tag;
          await page.locator(deferredTag).waitFor({ state: "attached" });
          expect(await definitions()).toEqual([deferredTag]);
          if (panel.name === "terminal") {
            // Reload an adopted PTY, and keep the mock Gateway's live inventory across reload.
            await root.locator(".tabstrip-tab.is-live").waitFor();
            await gateway.setMethodResponse("terminal.list", {
              sessions: [{ ...session, attached: false, owner: "conn", createdAtMs: 1 }],
            });
            await gateway.setMethodResponse("terminal.attach", {
              ...session,
              buffer: "",
              seq: 0,
            });
          }
          await page.reload();
          await content.waitFor();
          await page.locator(deferredTag).waitFor({ state: "attached" });
          expect(await definitions()).toEqual([deferredTag]);
          if (panel.name === "terminal") {
            const attached = await gateway.waitForRequest("terminal.attach");
            expect(attached.params).toEqual({ sessionId: session.sessionId });
            expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
            const terminal = root.locator(".tp-host");
            await terminal.locator("canvas").waitFor();
            await terminal.click();
            await page.keyboard.type("x");
            await gateway.waitForRequest("terminal.input");
            const inputs = await gateway.getRequests("terminal.input");
            await page.keyboard.press("Control+Backquote");
            await content.waitFor({ state: "hidden" });
            expect(await gateway.getRequests("terminal.input")).toEqual(inputs);
            await page.keyboard.press("Control+Backquote");
            await content.waitFor();
          }
        },
      );
    },
  );
});
