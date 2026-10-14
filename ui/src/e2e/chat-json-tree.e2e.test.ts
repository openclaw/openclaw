import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const available = canRunPlaywrightChromium(executablePath);
const suite =
  available || process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM !== "1"
    ? describe
    : describe.skip;
const source = `{
  "example": "Deployment receipt",
  "status": "ready",
  "items": [{"name": "alpha", "enabled": true}, {"name": "beta", "enabled": false}],
  "id": 9007199254740993,
  "status": "verified",
  "escaped": "\\u0061",
  "overflow": 1e400
}`;
let browser: Browser;
let server: ControlUiE2eServer;

suite("Control UI JSON tree and source views", () => {
  beforeAll(async () => {
    if (!available) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each(["dark", "light"] as const)(
    "shares lossless JSON controls for bare messages and fences in %s mode",
    async (theme) => {
      const context = await browser.newContext({
        colorScheme: theme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 1000 },
      });
      const page = await context.newPage();
      const proofDir =
        process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
          ? createControlUiE2eArtifactDir("chat-json-tree")
          : undefined;
      const stage = process.env.OPENCLAW_CODE_FENCE_PROOF_STAGE ?? "after";
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(server.baseUrl).origin,
      });
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: "Inspect this deployment receipt in tree and raw views.",
            timestamp: 1000,
            __openclaw: { id: "json-request", seq: 1 },
          },
          {
            role: "assistant",
            content: source,
            timestamp: 2000,
            __openclaw: { id: "json-bare", seq: 2 },
          },
          {
            role: "user",
            content: "And the same JSON inside a code fence.",
            timestamp: 3000,
            __openclaw: { id: "json-fence-request", seq: 3 },
          },
          {
            role: "assistant",
            content: "```json\n" + source + "\n```",
            timestamp: 4000,
            __openclaw: { id: "json-fenced", seq: 4 },
          },
        ],
      });
      try {
        await page.goto(`${server.baseUrl}chat`);
        const bare = page.locator('[data-entry-id="json-bare"]');
        const fenced = page.locator('[data-entry-id="json-fenced"]');
        await fenced.waitFor({ state: "visible" });
        await page.evaluate((mode) => {
          const root = document.documentElement;
          root.dataset.themeMode = mode;
          root.dataset.themeResolved = mode;
          root.classList.toggle("wa-light", mode === "light");
          root.classList.toggle("wa-dark", mode === "dark");
          root.style.colorScheme = mode;
        }, theme);
        if (proofDir) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(proofDir, `${stage}-${theme}-tree.png`),
          });
        }
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
        if (proofDir) {
          await bare.scrollIntoViewIfNeeded();
          await page.screenshot({
            animations: "disabled",
            path: path.join(proofDir, `${stage}-${theme}-raw.png`),
          });
        }
        await page.setViewportSize({ width: 400, height: 900 });
        await bare.getByRole("button", { name: "Tree", exact: true }).click();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
        ).toBe(true);
        if (proofDir) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(proofDir, `${stage}-${theme}-mobile.png`),
          });
        }
      } finally {
        await context.close();
      }
    },
  );
  it("bounds long user JSON with message disclosure and no JSON controls", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 1000 },
    });
    try {
      const page = await context.newPage();
      const text = JSON.stringify(
        {
          example: "Long user JSON stays bounded",
          rows: Array.from({ length: 45 }, (_, index) => ({
            item: "Entry " + index,
            enabled: true,
          })),
        },
        null,
        2,
      );
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            role: "user",
            content: text,
            timestamp: 1000,
            __openclaw: { id: "long-json-user", seq: 1 },
          },
          {
            role: "assistant",
            content: "Ready to inspect the JSON.",
            timestamp: 2000,
            __openclaw: { id: "long-json-reply", seq: 2 },
          },
        ],
      });
      await page.goto(server.baseUrl + "chat");
      await gateway.waitForRequest("chat.startup");
      const bubble = page.locator('.chat-bubble[data-entry-id="long-json-user"]');
      await bubble.waitFor({ state: "visible" });
      await bubble.evaluate((element) => element.scrollIntoView({ block: "start" }));
      expect(await bubble.locator("pre code").textContent()).toBe(text);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const proofDir = createControlUiE2eArtifactDir("chat-user-json-disclosure");
        const stage = process.env.OPENCLAW_CODE_FENCE_PROOF_STAGE ?? "after";
        await page
          .locator("openclaw-chat-pane.chat-pane-cache__pane--active .chat-thread")
          .screenshot({
            animations: "disabled",
            path: path.join(proofDir, stage + "-user-json.png"),
          });
      }
      const toggle = bubble.locator(".chat-message-disclosure__toggle");
      const content = bubble.locator(".chat-message-disclosure__content");
      await expect.poll(() => toggle.isVisible()).toBe(true);
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      await expect
        .poll(() => content.evaluate((element) => element.scrollHeight > element.clientHeight + 1))
        .toBe(true);
      expect(
        await bubble
          .locator(
            ".code-block-json-tree, .code-block-json-mode, .code-block-copy, .code-block-expand, .code-block-wrap",
          )
          .count(),
      ).toBe(0);
      await toggle.click();
      await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("true");
      await expect
        .poll(() => content.evaluate((element) => element.scrollHeight <= element.clientHeight + 1))
        .toBe(true);
      expect(await bubble.locator("pre code").textContent()).toBe(text);
      await toggle.click();
      await expect.poll(() => toggle.getAttribute("aria-expanded")).toBe("false");
      await expect
        .poll(() => content.evaluate((element) => element.scrollHeight > element.clientHeight + 1))
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});
