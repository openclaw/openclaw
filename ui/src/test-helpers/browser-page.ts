import type { Dialog, Frame, Page } from "playwright";

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

export async function reloadDismissingUnloadPrompt(page: Page) {
  const session = await page.context().newCDPSession(page);
  const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
  const onDialog = (dialog: Dialog) =>
    void dialog.dismiss().then(() => resolve(dialog.type()), reject);
  const onNavigation = (frame: Frame) => frame === page.mainFrame() && resolve(undefined);
  page.on("dialog", onDialog);
  page.on("framenavigated", onNavigation);
  try {
    await session.send("Page.reload");
    return await promise;
  } finally {
    page.off("dialog", onDialog);
    page.off("framenavigated", onNavigation);
    await session.detach();
  }
}
