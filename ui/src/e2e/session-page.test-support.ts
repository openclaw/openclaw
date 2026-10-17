import type { Browser, BrowserContextOptions, Page } from "playwright";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

export async function withSessionPage(
  suite: { readonly browser: Browser },
  run: (page: Page) => Promise<void>,
  options: BrowserContextOptions = createControlUiE2eContextOptions(),
) {
  const context = await suite.browser.newContext(options);
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}
