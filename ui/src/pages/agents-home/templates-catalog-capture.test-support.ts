import { writeFile } from "node:fs/promises";
import type { Locator, Page } from "playwright";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";

export const proofDir = createControlUiE2eArtifactDir("templates-catalog");
export const capture = async (page: Page, name: string, content: Locator, scrollTo?: Locator) => {
  const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [content], {
    animations: "disabled",
    elements: name === "after-catalog" ? [content] : [],
    scrollTo,
  });
  await writeFile(`${proofDir}/${name}.png`, frame.png);
  await writeFile(
    `${proofDir}/${name}.json`,
    JSON.stringify({
      viewport: page.viewportSize(),
      scale: await page.evaluate(() => devicePixelRatio),
      elements: frame.elements.map(({ bounds }) => ({ bounds })),
    }),
  );
};
