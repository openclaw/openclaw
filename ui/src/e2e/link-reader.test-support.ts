import { chromium, type Page } from "playwright";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";

export const readerUrl = "https://forge.example/items/42";
export const readerFile = (path: string, additions = 1) => ({
  path,
  additions,
  deletions: 1,
  patch: "-old\n+new",
});
export const readerComment = (body: string, id = "reply") => ({
  id,
  author: "reviewer",
  url: `${readerUrl}#${id}`,
  body,
});
type ReaderOptions = NonNullable<Parameters<typeof installMockGateway>[1]>;
type ReaderFixture = Awaited<ReturnType<typeof openReader>>;

async function openReader(page: Page, baseUrl: string, options: ReaderOptions) {
  const gateway = await installMockGateway(page, {
    controlUiLinkReaders: [TEST_LINK_READER],
    featureMethods: ["chat.startup", "chat.metadata", "forge.detail"],
    historyMessages: [
      { role: "assistant", content: [{ type: "text", text: `[Review item](${readerUrl})` }] },
    ],
    ...options,
  });
  await page.goto(baseUrl + "chat");
  await page.getByRole("link", { name: "Review item", exact: true }).click();
  const panel = page.locator("openclaw-link-reader-panel");
  return {
    page,
    gateway,
    panel,
    content: panel.locator(".lr-content:not([hidden])"),
    button: (name: string) => panel.getByRole("button", { name, exact: true }),
  };
}

export async function withLinkReader(
  options: ReaderOptions,
  run: (fixture: ReaderFixture) => Promise<void>,
) {
  const server = await startControlUiE2eServer();
  const browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    await run(await openReader(await context.newPage(), server.baseUrl, options));
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
}
