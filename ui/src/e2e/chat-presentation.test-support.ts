import type { Locator, Page } from "playwright";
import { expect } from "vitest";

export const exactButton = (root: Page | Locator, name: string | RegExp) =>
  root.getByRole("button", { name, exact: true });
export const polledText = (target: Locator) => expect.poll(() => target.textContent());
export const polledCount = (target: Locator) => expect.poll(() => target.count());
export const polledVisible = (target: Locator) => expect.poll(() => target.isVisible());
export const polledAttribute = (target: Locator, name: string) =>
  expect.poll(() => target.getAttribute(name));
export const polledStyle = (target: Locator, name: keyof CSSStyleDeclaration) =>
  expect.poll(() => target.evaluate((node, key) => getComputedStyle(node)[key], name));
export async function layoutBox(target: Locator) {
  const box = await target.boundingBox();
  expect(box, `Layout box for ${target}`).not.toBeNull();
  if (!box) {
    throw new Error(`Missing layout box for ${target}`);
  }
  return box;
}

type Box = Awaited<ReturnType<typeof layoutBox>>;
export const right = (box: Box) => box.x + box.width;
export const bottom = (box: Box) => box.y + box.height;
export const centerX = (box: Box) => box.x + box.width / 2;
export const centerY = (box: Box) => box.y + box.height / 2;

export async function settlePanel(page: Page) {
  await page.locator(".side-panel").evaluate(async (panel) => {
    await Promise.all(
      panel
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
}

export const twoFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
