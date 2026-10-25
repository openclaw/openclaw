import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Chat loading geometry",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});
const sessionId = "b1c2cd3c-1234-4321-9876-123456789abc";
const sessionKey = `agent:main:chat:${sessionId}`;
const row = createControlUiSessionRow(sessionKey, "Loading geometry", 1, { model: "gpt-4.1" });
const readyText = "The conversation history is now available.";
const viewports = [
  { width: 1105, height: 954 },
  { width: 1600, height: 900 },
  { width: 390, height: 844 },
];
type Box = { x: number; y: number; width: number; height: number };

async function capture(page: Page, target: Locator, directory: string, stage: string) {
  const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [target], {
    elements: [target],
    animations: "disabled",
  });
  await writeFile(path.join(directory, `${stage}.png`), frame.png);
  await writeFile(path.join(directory, `${stage}-composer.png`), frame.elements[0]!.png);
  return frame.elements[0]!.bounds;
}

function expectSameBox(actual: Box, expected: Box, stage: string) {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect.soft(Math.abs(actual[key] - expected[key]), `${stage} ${key}`).toBeLessThanOrEqual(1);
  }
}

suite.define(() => {
  it.each(viewports)(
    "preserves composer geometry on cold reload at $width px",
    async (viewport) => {
      const directory = createControlUiE2eArtifactDir(`chat-loading-${viewport.width}`);
      await suite.withPage(
        {
          viewport,
          locale: "en-US",
          serviceWorkers: "block",
          recordVideo: { dir: directory, size: viewport },
        },
        async ({ context, page }) => {
          await seedChatSettings(page, suite.server.baseUrl, { theme: "claw", themeMode: "dark" });
          const gateway = await installMockGateway(page, {
            sessionKey,
            agentModel: "openai/gpt-4.1",
            sessions: [row],
            methodResponses: {
              "config.get": themeConfigResponse("claw", "dark"),
              "sessions.describe": { session: row },
              "sessions.resolve": { ok: true, ...row },
            },
            heldMethods: ["connect", "chat.startup", "chat.history"],
            historyMessages: [{ role: "assistant", content: readyText }],
          });
          await page.goto(`${suite.server.baseUrl}chat/main/${sessionId}`, {
            waitUntil: "domcontentloaded",
          });
          await gateway.waitForRequest("connect");
          await gateway.resolveDeferred("connect");
          await gateway.waitForRequest("chat.startup");
          await gateway.resolveDeferred("chat.startup");
          await page.getByText(readyText, { exact: true }).waitFor();
          const composer = page
            .locator(".agent-chat__input--chat")
            .filter({ visible: true })
            .first();
          const theme = await page.evaluate(() => ({
            palette: document.documentElement.dataset.theme,
            mode: document.documentElement.dataset.themeMode,
            stylesheets: [
              ...document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]"),
            ].map((link) => ({ href: new URL(link.href).pathname, loaded: Boolean(link.sheet) })),
            background: getComputedStyle(document.body).backgroundColor,
            text: getComputedStyle(document.body).color,
          }));
          const original = await capture(page, composer, directory, "original");
          const composerStyles = await composer.evaluate((element) => {
            const style = getComputedStyle(element);
            const properties = [
              "--chat-composer-min-height",
              "--chat-composer-editor-size",
              "--chat-composer-editor-line",
              "--chat-composer-editor-inset-block",
              "--chat-composer-send-size",
            ];
            return {
              tokens: Object.fromEntries(
                properties.map((property) => [property, style.getPropertyValue(property)]),
              ),
              children: [...element.children].map((child) => {
                const childStyle = getComputedStyle(child);
                return {
                  class: child.className,
                  height: child.getBoundingClientRect().height,
                  padding: childStyle.padding,
                  margin: childStyle.margin,
                };
              }),
            };
          });
          const details = page.locator(".chat-details[data-desktop]").filter({ visible: true });
          const detailsBefore = await details.count();
          // Unload the snapshot writer before resetting browser storage. Clearing
          // IndexedDB under a live pane lets its pending flush repopulate the cache.
          const reloadUrl = page.url();
          await page.route(reloadUrl, (request) =>
            request.fulfill({
              contentType: "text/html",
              body: "<!doctype html><title>Resetting synthetic browser storage</title>",
            }),
          );
          await page.reload({ waitUntil: "domcontentloaded" });
          const cdp = await context.newCDPSession(page);
          await cdp.send("Storage.clearDataForOrigin", {
            origin: new URL(suite.server.baseUrl).origin,
            storageTypes: "indexeddb",
          });
          await cdp.detach();
          await page.evaluate(() => {
            for (const key of Object.keys(localStorage)) {
              if (key.startsWith("openclaw.control.bootRecord.v1:")) {
                localStorage.removeItem(key);
              }
            }
          });
          await page.unroute(reloadUrl);
          const main = await holdModuleResponse(page, /\/src\/main\.ts(?:\?.*)?$/u);
          const route = await holdModuleResponse(page, /\/pages\/chat\/chat-page\.tsx(?:\?.*)?$/u);
          try {
            await page.reload({ waitUntil: "commit" });
            await main.request;
            const boot = await capture(
              page,
              page.locator("#openclaw-boot-shell .loading-skeleton__composer"),
              directory,
              "boot",
            );
            main.release();
            await gateway.waitForRequest("connect");
            await gateway.resolveDeferred("connect");
            await route.request;
            const routeBox = await capture(
              page,
              page.locator(".lazy-view-state--loading .loading-skeleton__composer"),
              directory,
              "route",
            );
            route.release();
            await gateway.waitForRequest("chat.startup");
            expect(await page.getByText(readyText, { exact: true }).count()).toBe(0);
            const pending = await capture(page, composer, directory, "history-pending");
            expect
              .soft(await page.locator(".chat-thread .loading-skeleton__composer").count())
              .toBe(0);
            if (viewport.width > 768) {
              const history = page.locator(".chat-thread");
              expect.soft(await history.locator(".loading-skeleton__header").count()).toBe(0);
              expect.soft(await history.locator("openclaw-panel-loading-skeleton").count()).toBe(0);
            }
            await gateway.resolveDeferred("chat.startup");
            await page.getByText(readyText, { exact: true }).waitFor();
            const ready = await capture(page, composer, directory, "ready");
            await writeFile(
              path.join(directory, "geometry.json"),
              JSON.stringify(
                {
                  viewport,
                  theme,
                  composerStyles,
                  original,
                  boot,
                  route: routeBox,
                  pending,
                  ready,
                },
                null,
                2,
              ),
            );
            expectSameBox(routeBox, boot, "route versus boot");
            expectSameBox(ready, original, "ready versus original");
            if (viewport.width > 768) {
              expectSameBox(pending, ready, "pending versus ready");
              expectSameBox(boot, ready, "boot versus ready");
              expect(await details.count()).toBe(detailsBefore);
            }
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
          } finally {
            main.release();
            route.release();
          }
        },
      );
    },
  );
});
