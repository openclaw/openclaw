import type WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
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

describe.runIf(canRunPlaywrightChromium(executablePath))("Web Awesome accessibility", () => {
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

  async function withPopover(
    initialOpen: boolean,
    run: (page: Page, accessibility: CDPSession) => Promise<void>,
  ) {
    await withBrowserPage(browser.newPage(), async (page) => {
      const url = new URL("popover-name-fixture", server.baseUrl).href;
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
      );
      await page.goto(url);
      await page.addScriptTag({
        content: `
          window.accessibilityFixtureReady = (async () => {
          const { syncPopoverLabel } = await import(${JSON.stringify(new URL("src/components/web-awesome-popover.ts", server.baseUrl).href)});
          const host = document.body.appendChild(document.createElement("div"));
          const root = host.attachShadow({ mode: "open" });
          root.innerHTML = \`<h2 id="heading">Project details</h2>
            <span id="context">Current</span>
            <button id="trigger" aria-label="Open choices">Choices<span aria-hidden="true"> decoration</span></button>
            <wa-popover for="trigger" aria-label="Choose project">
              <button>Save</button>
            </wa-popover>\`;
          const popover = root.querySelector("wa-popover");
          popover.open = ${initialOpen};
          syncPopoverLabel(popover);
          await popover.updateComplete;
          if (!${initialOpen}) {
            await popover.show();
          }
          await popover.popup.updateComplete;
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

  async function dialogNames(accessibility: CDPSession) {
    const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
    return nodes
      .filter((node) => !node.ignored && node.role?.value === "dialog")
      .map((node) => node.name?.value ?? "");
  }

  it("names initially open dialogs and removes stale host names", async () => {
    await withPopover(true, async (page, accessibility) => {
      expect(await dialogNames(accessibility)).toEqual(["Choose project"]);
      const popover = page.locator("wa-popover");
      await popover.evaluate((element) => element.setAttribute("aria-label", "Choose folder"));
      expect(await dialogNames(accessibility)).toEqual(["Choose folder"]);
      await popover.evaluate((element) => element.setAttribute("aria-label", "  "));
      expect(await dialogNames(accessibility)).toEqual(["Open choices"]);
      await page.locator("#trigger").evaluate((element) => element.removeAttribute("aria-label"));
      expect(await dialogNames(accessibility)).toEqual(["Choices"]);
      await popover.evaluate(async (element: WaPopover) => {
        element.for = null;
        await element.updateComplete;
      });
      expect(await dialogNames(accessibility)).toEqual([""]);
    });
  });

  it("keeps referenced headings and triggers current across locale changes", async () => {
    await withPopover(false, async (page, accessibility) => {
      const popover = page.locator("wa-popover");
      await popover.evaluate((element) =>
        element.setAttribute("aria-labelledby", "context missing heading"),
      );
      expect(await dialogNames(accessibility)).toEqual(["Current Project details"]);
      await page.locator("#heading").evaluate((element) => {
        element.textContent = "Folder details";
      });
      expect(await dialogNames(accessibility)).toEqual(["Current Folder details"]);
      await popover.evaluate((element) => element.setAttribute("aria-labelledby", "missing"));
      expect(await dialogNames(accessibility)).toEqual(["Choose project"]);
      await popover.evaluate((element) => element.removeAttribute("aria-label"));
      expect(await dialogNames(accessibility)).toEqual(["Open choices"]);
      await page.locator("#trigger").evaluate((element) => {
        element.setAttribute("aria-label", "Open folders");
      });
      expect(await dialogNames(accessibility)).toEqual(["Open folders"]);
    });
  });

  it("rebinds its name after moving to another shadow root", async () => {
    await withPopover(false, async (page, accessibility) => {
      await page.locator("wa-popover").evaluate(async (element: WaPopover) => {
        await element.hide();
        element.remove();
        element.removeAttribute("aria-label");
        const host = document.body.appendChild(document.createElement("div"));
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = '<button id="trigger" aria-label="New project choices">Choose</button>';
        root.append(element);
        await element.updateComplete;
        await element.show();
      });
      expect(await dialogNames(accessibility)).toEqual(["New project choices"]);
      await page.locator("wa-popover").evaluate((element) => {
        element.setAttribute("aria-label", "Renamed choices");
      });
      expect(await dialogNames(accessibility)).toEqual(["Renamed choices"]);
    });
  });

  it("keeps panel actions outside the tablist in the accessibility tree", async () => {
    await withBrowserPage(browser.newPage(), async (page) => {
      const url = new URL("panel-tabs-fixture", server.baseUrl).href;
      await page.route(url, (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }),
      );
      await page.goto(url);
      await page.addScriptTag({
        content: `
        window.accessibilityFixtureReady = (async () => {
        const { render } = await import(${JSON.stringify(new URL(`/@fs${new URL(import.meta.resolve("lit")).pathname}`, server.baseUrl).href)});
        const { renderPanelTabStrip } = await import(${JSON.stringify(new URL("src/components/panel-tab-strip.ts", server.baseUrl).href)});
        const host = document.body.appendChild(document.createElement("div"));
        const root = host.attachShadow({ mode: "open" });
        render(
          renderPanelTabStrip({
            tabs: [
              {
                id: "first",
                domId: "first-tab",
                label: "First tab",
                closeLabel: "Close first tab",
              },
              {
                id: "second",
                domId: "second-tab",
                label: "Second tab",
                closeLabel: "Close second tab",
              },
            ],
            activeId: "first",
            ariaControls: "panel",
            onSelect: () => {},
            onClose: () => {},
            onNew: () => {},
            newLabel: "New tab",
          }),
          root,
        );
        await root.querySelector("wa-tab-group").updateComplete;
        })();
        `,
      });
      await page.evaluate("window.accessibilityFixtureReady");
      const accessibility = await page.context().newCDPSession(page);
      try {
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
      } finally {
        await accessibility.detach();
      }
    });
  });
});
