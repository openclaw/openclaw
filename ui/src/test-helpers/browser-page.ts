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
