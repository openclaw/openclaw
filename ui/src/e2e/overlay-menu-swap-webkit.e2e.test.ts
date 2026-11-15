import { webkit, type Browser } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// Positive integration coverage for the real release settings controls.
// This flow also passes without the #196820 CSS fix; it is not baseline-red proof.

let webkitBrowser: Browser | undefined;
const suite = createControlUiE2eSuite({
  name: "overlay menu swap in WebKit",
  resources: {
    async run() {
      webkitBrowser = await webkit.launch();
    },
    async close() {
      await webkitBrowser?.close();
    },
  },
});

suite.define(() => {
  it("keeps WebKit responsive when a picker replaces the opening agent menu", async () => {
    const context = await webkitBrowser!.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
      reducedMotion: "no-preference",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
    try {
      const sessions = [0, 1].map((index) =>
        createControlUiSessionRow(`agent:main:swap-${index}`, `Swap ${index}`, index),
      );
      await installMockGateway(page, {
        sessions,
        sessionKey: sessions[0]!.key,
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", name: "Main" },
              { id: "research", name: "Research" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await evaluateControlUiContext(page, (app) => app.navigate("appearance"));
      await waitForControlUiRoute(page, { routeId: "appearance" });
      const fontTrigger = page.locator("#settings-font-ui");
      await fontTrigger.waitFor();

      await page.evaluate(async () => {
        const press = (selector: string) => {
          const target = document.querySelector<HTMLElement>(selector);
          if (!target) {
            throw new Error("Missing control " + selector);
          }
          target.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              composed: true,
              pointerType: "mouse",
            }),
          );
          target.click();
        };
        press(".settings-sidebar .agent-select__trigger");
        const deadline = performance.now() + 2000;
        let menu: Element | null;
        while (!(menu = document.querySelector(".agent-select__menu:popover-open"))) {
          if (performance.now() > deadline) {
            throw new Error("Agent menu did not enter top layer");
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          });
        }
        const before = {
          phase: menu.getAttribute("data-phase"),
          fallback: getComputedStyle(menu).getPropertyValue("position-try-fallbacks"),
          duration: getComputedStyle(menu).transitionDuration,
        };
        if (before.phase !== "opening") {
          throw new Error("Entry phase missed: " + JSON.stringify(before));
        }
        const font = document.querySelector<HTMLElement>("#settings-font-ui")!;
        const topBefore = font.getBoundingClientRect().top;
        font.scrollIntoView({ block: "center", behavior: "instant" });
        const topAfter = font.getBoundingClientRect().top;
        if (topBefore === topAfter) {
          throw new Error("Settings scroll did not change layout");
        }
        if (menu.getAttribute("data-phase") !== "opening") {
          throw new Error("Entry ended before competing picker");
        }
        press("#settings-font-ui");
        return { before, topBefore, topAfter, after: menu.getAttribute("data-phase") };
      });

      await page.waitForFunction(
        () => {
          const trigger = document.querySelector("#settings-font-ui");
          const menuId = trigger?.getAttribute("aria-controls");
          return (
            !document.querySelector(".agent-select__menu:popover-open") &&
            trigger?.getAttribute("aria-expanded") === "true" &&
            Boolean(
              menuId &&
              document.getElementById(menuId)?.matches(':popover-open[data-phase="open"]'),
            )
          );
        },
        undefined,
        { timeout: 15_000 },
      );
      expect(await fontTrigger.getAttribute("aria-expanded")).toBe("true");
    } finally {
      await context.close();
    }
  }, 60_000);
});
