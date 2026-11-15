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

// openclaw/openclaw#196820: WebKit never finished style resolution when an opening menu
// was swapped out for another while the layout changed, freezing the whole Control UI.

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
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
            agents: [
              { id: "main", name: "Main" },
              { id: "other", name: "Other" },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await evaluateControlUiContext(page, (app) => app.navigate("appearance"));
      await waitForControlUiRoute(page, { routeId: "appearance" });
      const fontTrigger = page.locator("#settings-font-ui");
      await fontTrigger.waitFor();

      // Beta settings replace the application sidebar. Use their enabled agent menu,
      // then open the font picker in its first frame to close the anchored menu.
      void page
        .evaluate(async () => {
          const press = (target: Element) => {
            target.dispatchEvent(
              new PointerEvent("pointerdown", {
                bubbles: true,
                composed: true,
                pointerType: "mouse",
              }),
            );
            (target as HTMLElement).click();
          };
          press(document.querySelector("button.agent-select__trigger")!);
          while (!document.querySelector(".agent-select__menu:popover-open")) {
            await new Promise((resolve) => {
              setTimeout(resolve, 5);
            });
          }
          press(document.querySelector("#settings-font-ui")!);
        })
        .catch(() => undefined);

      const responsive = await Promise.race([
        page.waitForFunction(
          () =>
            !document.querySelector(".agent-select__menu:popover-open") &&
            document.querySelector(".picker-select__menu[data-phase='open']") !== null,
          undefined,
          { timeout: 15_000 },
        ),
        new Promise<"hung">((resolve) => {
          setTimeout(() => resolve("hung"), 15_000);
        }),
      ]);
      expect(responsive, "WebKit stopped answering after the menu swap").not.toBe("hung");
      await expect.poll(() => fontTrigger.getAttribute("aria-expanded")).toBe("true");
    } finally {
      await context.close().catch(() => undefined);
    }
  }, 60_000);
});
