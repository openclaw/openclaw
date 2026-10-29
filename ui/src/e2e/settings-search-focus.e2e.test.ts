import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings search forced-colors focus" });

suite.define(() => {
  it("keeps the search input visibly focused when forced colors suppress shadows", async () => {
    await suite.withPage(
      {
        forcedColors: "active",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
      },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(suite.server.baseUrl + "settings/appearance");
        const { search, sidebar } = await waitForControlUiSettingsTakeover(page);
        await search.click();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        expect(await search.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
        const indicator = await search.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            outline: style.outlineStyle,
            width: style.outlineWidth,
            shadow: style.boxShadow,
            color: style.outlineColor,
            highlight: (() => {
              const probe = document.createElement("span");
              probe.style.color = "Highlight";
              document.body.append(probe);
              const color = getComputedStyle(probe).color;
              probe.remove();
              return color;
            })(),
          };
        });
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, sidebar, [search], {
            animations: "disabled",
            elements: [sidebar],
          });
          await writeFile(path.join(suite.artifactDir, "settings-search-focus.png"), frame.png);
        }
        expect(indicator).toMatchObject({ outline: "solid", width: "2px", shadow: "none" });
        expect(indicator.color).toBe(indicator.highlight);
      },
    );
  });
});
