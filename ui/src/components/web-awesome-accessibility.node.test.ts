import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withBrowserPage } from "../test-helpers/browser-page.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());

describe.runIf(canRunPlaywrightChromium(executablePath))("Shared control accessibility", () => {
  let browser: Browser;
  let server: ControlUiE2eServer;

  beforeAll(async () => {
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath, headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps panel actions outside the tablist in the accessibility tree", async () => {
    await withBrowserPage(browser.newPage(), async (page) => {
      const url = new URL("accessibility-fixture", server.baseUrl).href;
      const moduleUrl = (path: string) => JSON.stringify(new URL(path, server.baseUrl).href);
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
      );
      await page.goto(url);
      await page.addScriptTag({
        content: `
          window.accessibilityFixtureReady = (async () => {
          const host = document.body.appendChild(document.createElement("div"));
          const root = host.attachShadow({ mode: "open" });
        const { render, createComponent } = await import(${moduleUrl(`/@fs${new URL("./web.js", import.meta.resolve("@solidjs/web")).pathname}`)});
        const { PanelTabStrip } = await import(${moduleUrl("src/components/panel-tab-strip-solid.tsx")});
        render(() => createComponent(PanelTabStrip, {
            tabs: ["first", "second"].map((id) => ({
              id, domId: id + "-tab", label: id + " tab", closeLabel: "Close " + id + " tab",
            })),
            activeId: "first", ariaControls: "panel", newLabel: "New tab",
            onSelect: () => {}, onClose: () => {}, onNew: () => {},
          }), root);
          })();
        `,
      });
      await page.evaluate("window.accessibilityFixtureReady");
      // Only the browser AX tree resolves native ARIA references across shadow roots.
      const accessibility = await page.context().newCDPSession(page);
      try {
        const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
        const byId = new Map(nodes.map((node) => [node.nodeId, node]));
        const visibleChildren = (id: string): typeof nodes => {
          const node = byId.get(id);
          return !node
            ? []
            : node.ignored
              ? (node.childIds ?? []).flatMap(visibleChildren)
              : [node];
        };
        const children = (role: string) => {
          const parent = nodes.find((node) => !node.ignored && node.role?.value === role);
          expect(parent).toBeDefined();
          return (parent!.childIds ?? []).flatMap(visibleChildren);
        };
        expect(children("tablist").map((node) => node.role?.value)).toEqual(["tab", "tab"]);
        expect(children("group").map((node) => node.name?.value)).toEqual([
          "Close first tab",
          "Close second tab",
          "New tab",
        ]);
      } finally {
        await accessibility.detach();
      }
    });
  });
});
