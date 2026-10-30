import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect } from "vitest";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";

export function chatControls(page: Page) {
  const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
  return {
    pane,
    composer: pane.getByRole("textbox", { name: "Chat composer", exact: true }),
    send: pane.getByRole("button", { name: "Send message", exact: true }),
    stop: pane.getByRole("button", { name: "Stop generating", exact: true }),
  };
}

export async function pairFixture(page: Page, instance: OpenClawTestInstance) {
  await pairControlUiPage(page, async (args) => {
    const result = await instance.cli(args);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout;
  });
}

export async function assertServedUi(page: Page, baseUrl: string) {
  const script = await page.locator('script[type="module"][src]').first().getAttribute("src");
  expect(script).toMatch(/^\/assets\/.+\.js$/);
  const asset = await page.context().request.get(new URL(script!, baseUrl).href);
  expect(asset.ok()).toBe(true);
  const built = await readFile(path.join("dist/control-ui", script!.slice(1)));
  expect((await asset.body()).equals(built), "served UI must be this checkout's built bundle").toBe(
    true,
  );
}
