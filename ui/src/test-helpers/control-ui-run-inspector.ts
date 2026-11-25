import type { BrowserContext, Locator, Page } from "playwright";
import {
  activityRunInspectorSelectorHref,
  type RunInspectorSelector,
} from "../pages/activity/run-inspector-model.ts";

export function controlUiRunInspectorLocator(page: Page, selector: RunInspectorSelector): Locator {
  return page.locator(
    `#activity-run-panel[data-${selector.kind}-id=${JSON.stringify(selector.id)}]`,
  );
}

/** Collect on an owned page so a later caller reload still targets its original surface. */
export async function withControlUiRunInspector<T>(
  context: BrowserContext,
  options: {
    baseUrl: string;
    selector: RunInspectorSelector;
    receipt?: Parameters<typeof activityRunInspectorSelectorHref>[2];
    /** Install a mock Gateway or use pairControlUiPage with the isolated Gateway's CLI. */
    preparePage?: (page: Page) => Promise<unknown>;
  },
  collect: (page: Page, inspector: Locator) => Promise<T>,
): Promise<T> {
  const page = await context.newPage();
  try {
    await options.preparePage?.(page);
    const baseUrl = new URL(options.baseUrl);
    await page.goto(
      new URL(
        activityRunInspectorSelectorHref(options.selector, baseUrl.pathname, options.receipt),
        baseUrl,
      ).href,
    );
    // Bind the rendered result, not merely the requested URL or any prior RPC frame.
    const inspector = controlUiRunInspectorLocator(page, options.selector);
    await inspector.waitFor({ state: "visible" });
    if (options.receipt) {
      await inspector
        .locator(`[data-receipt-selector-id=${JSON.stringify(options.receipt.id)}]`)
        .waitFor({ state: "visible" });
    }
    return await collect(page, inspector);
  } finally {
    await page.close();
  }
}
