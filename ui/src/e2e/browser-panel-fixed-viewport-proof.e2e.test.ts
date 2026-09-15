import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { captureUiProof } from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// Runtime proof for the fixed-viewport browser panel mode: with the toolbar
// lock enabled the panel must not resize the remote page when its dock changes,
// and the frame keeps contain-fitting the dock. Captures `follow` (shipped
// default) and `fixed` screenshots when OPENCLAW_CAPTURE_UI_PROOF=1.

const suite = createControlUiE2eSuite({
  name: "Control UI browser panel fixed viewport proof",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

suite.define(() => {
  it("keeps the remote viewport fixed while the dock resizes in fixed-viewport mode", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        await page.route("**/__openclaw__/assistant-media**", (route) =>
          route.fulfill({ contentType: "image/png", body: ONE_PIXEL_PNG }),
        );
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "browser.request"],
          operatorScopes: ["operator.admin", "operator.read", "operator.write"],
          historyMessages: [{ role: "assistant", content: "History is ready.", timestamp: 1_000 }],
          methodResponses: {
            "browser.request": {
              cases: [
                {
                  match: { path: "/tabs" },
                  response: {
                    running: true,
                    tabs: [
                      {
                        tabId: "t1",
                        targetId: "default-tab",
                        title: "Configured default",
                        url: "https://default.example/",
                      },
                    ],
                  },
                },
                {
                  match: { path: "/screencast" },
                  response: {
                    __mockError: {
                      code: "UNAVAILABLE",
                      message: "Browser screencast requires Playwright in this gateway build.",
                      details: { code: "SCREENCAST_UNSUPPORTED", reason: "playwright" },
                    },
                  },
                },
                {
                  match: { path: "/screenshot" },
                  response: { path: "/proof/default.png", targetId: "default-tab" },
                },
                {
                  match: { path: "/act" },
                  response: {
                    result: {
                      cssWidth: 1280,
                      cssHeight: 720,
                      title: "Configured default",
                      url: "https://default.example/",
                    },
                  },
                },
              ],
            },
          },
        });

        const resizeRequests = async () =>
          (await gateway.getRequests("browser.request")).filter((request) => {
            const params = request.params as
              | { path?: string; body?: { kind?: string } }
              | undefined;
            return params?.path === "/act" && params.body?.kind === "resize";
          });

        await page.goto(`${suite.server.baseUrl}chat`);
        await openChatSidePanelType(page, "Browser");
        const panel = page.locator("section.bp");
        await panel.locator('.bp-shot[alt="Configured default"]').waitFor();

        // Shipped default: the panel owns the remote viewport.
        await page.setViewportSize({ width: 900, height: 900 });
        await expect
          .poll(async () => (await resizeRequests()).length, { timeout: 5_000 })
          .toBeGreaterThan(0);
        await captureUiProof(suite, page, "browser-panel-fixed-viewport", "1-follow-default.png");

        const lock = panel.getByRole("button", { name: /viewport fixed/i });
        await lock.click();
        await expect
          .poll(async () => await lock.getAttribute("aria-pressed"), { timeout: 5_000 })
          .toBe("true");

        // The remote size settles after the last follow-mode request; from here
        // the fixed-viewport mode must not resize the page again.
        await page.setViewportSize({ width: 1_100, height: 900 });
        const settled = (await resizeRequests()).length;
        await page.waitForTimeout(1_200);
        expect((await resizeRequests()).length).toBe(settled);
        await captureUiProof(suite, page, "browser-panel-fixed-viewport", "2-fixed-viewport.png");
      },
    );
  });
});
