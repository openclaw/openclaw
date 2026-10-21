import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI JSON tree and source views",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executable) => `Playwright Chromium is unavailable at ${executable}`,
});
const source = `{
  "status": "ready",
  "items": [{"name": "alpha", "enabled": true}, {"name": "beta", "enabled": false}],
  "id": 9007199254740993,
  "status": "verified",
  "escaped": "\\u0061",
  "overflow": 1e400
}`;

const contextOptions = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { width: 1280, height: 1000 },
} as const;
const history = (...entries: [role: "user" | "assistant", id: string, content: string][]) =>
  entries.map(([role, id, content], index) => ({
    role,
    content,
    timestamp: (index + 1) * 1000,
    __openclaw: { id, seq: index + 1 },
  }));

const withPage = (theme: "dark" | "light", run: (page: Page) => Promise<void>) =>
  suite.withPage({ ...contextOptions, colorScheme: theme }, ({ page }) => run(page));
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
function createCapture(kind: string) {
  const directory = captureUiProof ? createControlUiE2eArtifactDir(kind) : "";
  return async (target: Page | Locator, name: string) => {
    if (!captureUiProof) {
      return;
    }
    const stage = process.env.OPENCLAW_CODE_FENCE_PROOF_STAGE ?? "after";
    await target.screenshot({
      animations: "disabled",
      path: path.join(directory, `${stage}-${name}.png`),
    });
  };
}

suite.define(() => {
  it.each(["dark", "light"] as const)(
    "shares lossless JSON controls for bare messages and fences in %s mode",
    async (theme) => {
      await withPage(theme, async (page) => {
        const capture = createCapture("chat-json-tree");
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(suite.server.baseUrl).origin,
        });
        await installMockGateway(page, {
          historyMessages: history(
            ["user", "json-request", "Inspect this deployment receipt in tree and raw views."],
            ["assistant", "json-bare", source],
            ["user", "json-fence-request", "And the same JSON inside a code fence."],
            ["assistant", "json-fenced", "```json\n" + source + "\n```"],
          ),
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const bare = page.locator('[data-entry-id="json-bare"]');
        const fenced = page.locator('[data-entry-id="json-fenced"]');
        await fenced.waitFor({ state: "visible" });
        await page.evaluate((mode) => {
          const root = document.documentElement;
          root.dataset.themeMode = mode;
          root.dataset.themeResolved = mode;
          root.style.colorScheme = mode;
        }, theme);
        await capture(page, theme + "-tree");
        for (const message of [bare, fenced]) {
          const tree = message.locator(".code-block-json-tree");
          await expect.poll(() => tree.count()).toBe(1);
          expect(await tree.isVisible()).toBe(true);
          expect(await tree.textContent()).toContain("9007199254740993");
          expect(await tree.textContent()).toContain("1e400");
          expect(await tree.locator(".code-block-json-key").allTextContents()).toContain(
            '"status"',
          );
          const nested = tree.locator("details").nth(1);
          const initial = await nested.getAttribute("open");
          await nested.locator(":scope > summary").click();
          expect(await nested.getAttribute("open")).not.toBe(initial);
          await message.getByRole("button", { name: "Raw", exact: true }).click();
          expect(await tree.isVisible()).toBe(false);
          expect(await message.locator("pre code").textContent()).toBe(
            source + (message === fenced ? "\n" : ""),
          );
          await message.getByRole("button", { name: "Copy code", exact: true }).click();
          expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
          await message.getByRole("button", { name: "Tree", exact: true }).click();
          expect(await tree.isVisible()).toBe(true);
          expect(await nested.getAttribute("open")).not.toBe(initial);
        }
        await bare.getByRole("button", { name: "Raw", exact: true }).click();
        if (captureUiProof) {
          await bare.scrollIntoViewIfNeeded();
          await capture(page, theme + "-raw");
        }
        await page.setViewportSize({ width: 400, height: 900 });
        await bare.getByRole("button", { name: "Tree", exact: true }).click();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true);
        await capture(page, theme + "-mobile");
      });
    },
  );
  it("bounds long user JSON with message disclosure and no JSON controls", async () => {
    await withPage("dark", async (page) => {
      const capture = createCapture("chat-user-json-disclosure");
      const text = JSON.stringify(
        {
          rows: Array.from({ length: 45 }, (_, index) => ({
            item: "Entry " + index,
            enabled: true,
          })),
        },
        null,
        2,
      );
      const gateway = await installMockGateway(page, {
        historyMessages: history(
          ["user", "long-json-user", text],
          ["assistant", "long-json-reply", "Ready to inspect the JSON."],
        ),
      });
      await page.goto(suite.server.baseUrl + "chat");
      await gateway.waitForRequest("chat.startup");
      const bubble = page.locator('.chat-bubble[data-entry-id="long-json-user"]');
      await bubble.waitFor({ state: "visible" });
      await bubble.evaluate((element) => element.scrollIntoView({ block: "start" }));
      expect(await bubble.locator("pre code").textContent()).toBe(text);
      await capture(
        page.locator("openclaw-chat-pane.chat-pane-cache__pane--active .chat-thread"),
        "user-json",
      );
      const toggle = bubble.locator(".chat-message-disclosure__toggle");
      const content = bubble.locator(".chat-message-disclosure__content");
      const expectDisclosure = async (expanded: boolean) => {
        await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe(String(expanded));
        await expect
          .poll(() =>
            content.evaluate((element) => element.scrollHeight > element.clientHeight + 1),
          )
          .toBe(!expanded);
      };
      await expect.poll(() => toggle.isVisible()).toBe(true);
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      await expectDisclosure(false);
      expect(
        await bubble
          .locator(
            ".code-block-json-tree, .code-block-json-mode, .code-block-copy, .code-block-expand, .code-block-wrap",
          )
          .count(),
      ).toBe(0);
      await toggle.click();
      await expectDisclosure(true);
      expect(await bubble.locator("pre code").textContent()).toBe(text);
      await toggle.click();
      await expectDisclosure(false);
    });
  });
});
