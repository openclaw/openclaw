import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Agent identity layout mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const responsiveViewports = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
] as const;

suite.define(() => {
  it("keeps agent identity controls inside their fields at desktop and mobile widths", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: [
          ...defaultControlUiFeatureMethods,
          "agents.update",
          "agents.list",
          "agent.identity.get",
          "config.get",
          "models.list",
        ],
      });
      await page.goto(`${suite.server.baseUrl}settings/agents`);
      const editor = page.locator(".agent-identity-editor");
      await editor.waitFor();

      for (const viewport of responsiveViewports) {
        await page.setViewportSize(viewport);
        for (const [name, control] of [
          ["Display name", editor.getByRole("textbox", { name: "Display name" })],
          ["Emoji input", editor.getByRole("textbox", { name: "Emoji" })],
          ["Emoji picker", editor.getByRole("button", { name: "Choose emoji" })],
        ] as const) {
          await control.focus();
          await expect
            .poll(
              () =>
                control.evaluate((element) => {
                  const inputBox = element.getBoundingClientRect();
                  const fieldBox = element.closest(".field")!.getBoundingClientRect();
                  const cardBox = element.closest(".settings-row")!.getBoundingClientRect();
                  return (
                    inputBox.width > 0 &&
                    inputBox.left >= Math.max(fieldBox.left, cardBox.left) - 1 &&
                    inputBox.right <= Math.min(fieldBox.right, cardBox.right) + 1
                  );
                }),
              { message: `${name} input is contained at ${viewport.width}px` },
            )
            .toBe(true);
        }
      }
    });
  });
});
