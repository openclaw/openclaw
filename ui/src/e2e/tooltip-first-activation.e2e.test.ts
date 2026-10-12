import { webkit, type Browser } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiE2eWaitTimeoutMs,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

let webkitBrowser: Browser | undefined;
const suite = createControlUiE2eSuite({
  name: "tooltip first activation",
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
  it.each(["chromium", "webkit"] as const)(
    "cancels a pending tooltip without stealing dialog Escape or flashing later in %s",
    async (engine) => {
      const options = { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" as const };
      const context =
        engine === "chromium"
          ? await suite.newBrowserContext(options)
          : await webkitBrowser!.newContext(options);
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      const held = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/components/solid/tooltip.tsx"),
      );
      const palette = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/components/command-palette.ts"),
      );
      try {
        const sessionKey = "agent:main:dashboard:tooltip-cold";
        await installMockGateway(page, { sessionKey });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.locator(".agent-chat__composer-combobox textarea:visible").waitFor();
        expect(held.requests()).toBe(0);
        await page.keyboard.press("ControlOrMeta+K");
        await palette.request;
        const modal = page.locator("openclaw-modal-dialog.cmd-palette-overlay > dialog");
        await expect.poll(() => modal.getAttribute("data-phase")).toBe("open");
        const fixture = await modal.evaluateHandle(async (dialog) => {
          const tooltip = document.createElement("openclaw-tooltip");
          tooltip.content = "Detailed help";
          const button = document.createElement("button");
          button.textContent = "Help";
          tooltip.append(button);
          dialog.append(tooltip);
          await tooltip.updateComplete;
          const state = { tooltip, button, cancelled: 0 };
          dialog.closest("openclaw-modal-dialog")!.addEventListener("modal-cancel", () => {
            state.cancelled += 1;
          });
          button.focus();
          return state;
        });
        try {
          await held.request;
          expect(
            await fixture.evaluate(({ tooltip, button }) => ({
              focused: document.activeElement === button,
              open: tooltip.hasAttribute("open"),
              visible: tooltip
                .shadowRoot!.querySelector(".tooltip-surface")!
                .matches(":popover-open"),
            })),
          ).toEqual({ focused: true, open: false, visible: false });
          await page.keyboard.press("Escape");
          await expect.poll(() => page.locator(".cmd-palette").count()).toBe(0);
          expect(await fixture.evaluate(({ cancelled }) => cancelled)).toBe(1);
          held.release();
          expect(
            await fixture.evaluate(async ({ tooltip }) => {
              await tooltip.updateComplete;
              return {
                open: tooltip.hasAttribute("open"),
                visible: tooltip
                  .shadowRoot!.querySelector(".tooltip-surface")!
                  .matches(":popover-open"),
              };
            }),
          ).toEqual({ open: false, visible: false });
        } finally {
          await fixture.dispose();
        }
      } finally {
        held.release();
        palette.release();
        if (engine === "chromium") {
          await suite.closeBrowserContext(context);
        } else {
          await context.close();
        }
      }
    },
  );
});
