import { chromium, type Browser, type CDPSession, type Page } from "playwright";
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

  async function withAccessibility(
    fixture: string,
    run: (page: Page, accessibility: CDPSession) => Promise<void>,
  ) {
    await withBrowserPage(browser.newPage(), async (page) => {
      const url = new URL("accessibility-fixture", server.baseUrl).href;
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
      );
      await page.goto(url);
      await page.addScriptTag({
        content: `
          window.accessibilityFixtureReady = (async () => {
          const host = document.body.appendChild(document.createElement("div"));
          const root = host.attachShadow({ mode: "open" });
          ${fixture}
          })();
        `,
      });
      await page.evaluate("window.accessibilityFixtureReady");
      // Matcher libraries do not resolve native element-reference ARIA across
      // shadow roots. Query the browser's actual accessibility tree instead.
      const accessibility = await page.context().newCDPSession(page);
      try {
        await run(page, accessibility);
      } finally {
        await accessibility.detach();
      }
    });
  }

  it("keeps panel actions outside the tablist in the accessibility tree", async () => {
    await withAccessibility(
      `
        const { render, createComponent } = await import(${JSON.stringify(new URL(`/@fs${new URL("./web.js", import.meta.resolve("@solidjs/web")).pathname}`, server.baseUrl).href)});
        const { PanelTabStrip } = await import(${JSON.stringify(new URL("src/components/panel-tab-strip-solid.tsx", server.baseUrl).href)});
        render(
          () => createComponent(PanelTabStrip, {
            tabs: ["first", "second"].map((id) => ({
              id,
              domId: id + "-tab",
              label: id + " tab",
              closeLabel: "Close " + id + " tab",
            })),
            activeId: "first",
            ariaControls: "panel",
            onSelect: () => {},
            onClose: () => {},
            onNew: () => {},
            newLabel: "New tab",
          }),
          root,
        );
      `,
      async (_page, accessibility) => {
        const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
        const byId = new Map(nodes.map((node) => [node.nodeId, node]));
        const visibleChildren = (id: string): typeof nodes => {
          const node = byId.get(id);
          return node
            ? node.ignored
              ? (node.childIds ?? []).flatMap(visibleChildren)
              : [node]
            : [];
        };
        const tablist = nodes.find((node) => !node.ignored && node.role?.value === "tablist");
        expect(tablist).toBeDefined();
        expect(
          (tablist!.childIds ?? []).flatMap(visibleChildren).map((node) => node.role?.value),
        ).toEqual(["tab", "tab"]);
        const actions = nodes.find((node) => !node.ignored && node.role?.value === "group");
        expect(actions).toBeDefined();
        expect(
          (actions!.childIds ?? []).flatMap(visibleChildren).map((node) => node.name?.value),
        ).toEqual(["Close first tab", "Close second tab", "New tab"]);
      },
    );
  });
});
