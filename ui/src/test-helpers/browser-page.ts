import type { Page } from "playwright";

export async function closeBrowserPage(page: Page): Promise<void> {
  await page.close().catch(() => {});
}

export async function withBrowserPage(
  pagePromise: Promise<Page>,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const page = await pagePromise;
  try {
    await run(page);
  } finally {
    await closeBrowserPage(page);
  }
}

export async function waitForLayoutSettled(page: Page, selector: string): Promise<void> {
  // content-visibility and container queries can defer descendant layout beyond
  // a fixed rAF pair. Require a short quiet window so a delayed update cannot
  // land immediately after two coincidentally identical frames.
  await page.evaluate(
    async ({ maxFrames, minStableFrames, minStableMs, selector: targetSelector }) => {
      let previousGeometry: string | undefined;
      let stableFrames = 0;
      let stableSince = performance.now();
      for (let frame = 0; frame < maxFrames; frame += 1) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        const elements = [...document.querySelectorAll<HTMLElement>(targetSelector)];
        if (elements.length === 0) {
          throw new Error(`No layout elements matched ${targetSelector}`);
        }
        const geometry = JSON.stringify(
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
          }),
        );
        if (geometry === previousGeometry) {
          stableFrames += 1;
        } else {
          stableFrames = 1;
          stableSince = performance.now();
        }
        if (stableFrames >= minStableFrames && performance.now() - stableSince >= minStableMs) {
          return;
        }
        previousGeometry = geometry;
      }
      throw new Error(`Layout did not stabilize for ${targetSelector} within ${maxFrames} frames`);
    },
    { maxFrames: 60, minStableFrames: 4, minStableMs: 50, selector },
  );
}
