import { writeFile } from "node:fs/promises";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
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

export const heldArtworkUrl = "/apple-touch-icon.png?held-art";

/** Hold only image I/O while catalog metadata, focus and geometry can settle. */
export async function expectTemplateArtworkSettles(
  page: Page,
  releaseCatalog: () => Promise<unknown>,
  theme: "light" | "dark",
  name: string,
) {
  if (theme === "dark") {
    await page.emulateMedia({ reducedMotion: "reduce" });
  }
  const response = Promise.withResolvers<void>();
  await page.route(`**${heldArtworkUrl}`, async (route) => {
    await response.promise;
    if (theme === "dark") {
      await route.fulfill({ status: 404, body: "" });
    } else {
      await route.continue();
    }
  });
  const art = page.locator(".agents-home__template-art").first();
  const placeholder = art.locator(".skeleton");
  const checkPaint = async () => {
    await placeholder.waitFor();
    expect(await placeholder.boundingBox()).toEqual(await art.boundingBox());
    const [paint, cardPaint, motion] = await placeholder.evaluate((el) => [
      getComputedStyle(el).backgroundColor,
      getComputedStyle(el.closest(".oc-card")!).backgroundColor,
      getComputedStyle(el, "::after").animationName,
    ]);
    expect(paint).not.toBe("rgba(0, 0, 0, 0)");
    expect(paint).not.toBe(cardPaint);
    expect(motion).toBe(theme === "dark" ? "none" : "shimmer");
  };
  try {
    await checkPaint();
    const box = await art.boundingBox();
    await releaseCatalog();
    const card = page.locator("[data-templates-entry]").first();
    await card.getByRole("heading", { name }).waitFor();
    const add = card.getByRole("button", { name: `Add ${name}` });
    await add.focus();
    expect(await add.isEnabled()).toBe(true);
    await checkPaint();
    expect(await art.boundingBox()).toEqual(box);
    response.resolve();
    await placeholder.waitFor({ state: "detached" });
    await art.locator(theme === "dark" ? "svg" : "img").waitFor();
    expect(await art.boundingBox()).toEqual(box);
    expect(await art.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(await add.evaluate((el) => el === document.activeElement)).toBe(true);
  } finally {
    response.resolve();
  }
}
