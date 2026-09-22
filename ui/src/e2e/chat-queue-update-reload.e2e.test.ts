import { expect, it } from "vitest";
import {
  startControlUiE2eServer,
  installMockGateway,
  createControlUiMockSameOriginGatewayScript,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  createControlUiE2eContextOptions,
} from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Queued correction update recovery",
  trackBrowserContexts: true,
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
suite.define(() => {
  it.each([
    { resolution: "save", split: false, cachedSplit: false, narrow: false, otherPage: false },
    { resolution: "cancel", split: false, cachedSplit: false, narrow: false, otherPage: false },
    { resolution: "save", split: true, cachedSplit: false, narrow: false, otherPage: false },
    { resolution: "save", split: true, cachedSplit: true, narrow: false, otherPage: false },
    { resolution: "save", split: true, cachedSplit: true, narrow: true, otherPage: false },
    { resolution: "save", split: true, cachedSplit: true, narrow: false, otherPage: true },
  ] as const)(
    "protects an edit through update recovery until $resolution (split: $split, cached: $cachedSplit, narrow: $narrow, other page: $otherPage)",
    async ({ resolution, split, cachedSplit, narrow, otherPage }) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
      const gateway = await installMockGateway(page, {
        sessions: [
          ...["original", "second"].map((name) => ({
            key: `agent:main:${name}`,
            label: `QA ${name}`,
            kind: "direct",
            updatedAt: Date.now(),
          })),
          { key: "agent:main:main", label: "Main", kind: "direct", updatedAt: Date.now() },
          {
            key: "agent:main:other",
            label: "Other QA conversation",
            kind: "direct",
            updatedAt: Date.now(),
          },
        ],
      });
      try {
        await page.goto(
          `${suite.server.baseUrl}chat?session=${split ? "agent:main:original" : "main"}`,
        );
        const composer = page.locator(
          ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
        );
        await composer.waitFor({ state: "visible", timeout: 15000 });
        const originalPathname = new URL(page.url()).pathname;
        await gateway.setOnline(false);
        await composer.fill("Reply exactly ORIGINAL-RELOAD");
        await composer.press("Enter");
        const row = page.locator(".chat-queue__item", { hasText: "Reply exactly ORIGINAL-RELOAD" });
        await row.waitFor();
        await row.dblclick();
        const edit = page.locator(".chat-queue__edit-input");
        await edit.fill("Reply exactly CORRECTED-RELOAD");
        await composer.fill("Separate saved composer draft");
        await page.screenshot({
          path: `${suite.artifactDir}/${resolution}-before-update.png`,
          fullPage: true,
        });
        let reloads = 0;
        page.on("domcontentloaded", () => {
          reloads += 1;
        });
        await gateway.setOnline(true);
        if (cachedSplit) {
          await page.getByRole("button", { name: "Open split view", exact: true }).click();
          await page
            .locator(".chat-split-view__cell")
            .first()
            .locator(".agent-chat__composer-combobox textarea")
            .click();
        }
        await page
          .locator('[data-session-key="agent:main:other"] a.sidebar-recent-session__link')
          .click();
        await page.waitForURL((url) => url.pathname.endsWith("/other"));
        // Reconnect can hide the edit before navigation replaces the active pane.
        await expect
          .poll(() =>
            page
              .locator("openclaw-chat-pane.chat-pane-cache__pane--active")
              .evaluate((element) => (element as HTMLElement & { sessionKey: string }).sessionKey),
          )
          .toBe("agent:main:other");
        await expect
          .poll(() =>
            page.locator(".chat-pane-cache__pane--active .chat-queue__edit-input").count(),
          )
          .toBe(0);
        if (split) {
          if (!cachedSplit) {
            await page.getByRole("button", { name: "Open split view", exact: true }).click();
          }
          await page
            .locator(".chat-split-view__cell")
            .nth(1)
            .locator(".agent-chat__composer-combobox textarea")
            .click();
          await page
            .locator('[data-session-key="agent:main:second"] a.sidebar-recent-session__link')
            .click();
          await page.waitForURL((url) => url.pathname.endsWith("/second"));
          await expect
            .poll(() =>
              page
                .locator("openclaw-chat-pane.chat-pane-cache__pane--active")
                .evaluate(
                  (element) => (element as HTMLElement & { sessionKey: string }).sessionKey,
                ),
            )
            .toBe("agent:main:second");
        }
        if (narrow) {
          await page.setViewportSize({ width: 900, height: 900 });
        }
        await gateway.setOnline(false);
        await gateway.setServerBuildId("e2e-next-queued-edit");
        await gateway.setOnline(true);
        const refresh = page.getByRole("button", { name: /Server updated/u });
        await refresh.waitFor();
        await refresh.press("Enter");
        await page
          .getByText("Save or cancel your queued message edit before reloading.", { exact: true })
          .waitFor();
        await page.screenshot({
          path: `${suite.artifactDir}/${resolution}-after-update.png`,
          fullPage: true,
        });
        if (otherPage) {
          await page.getByRole("link", { name: "Agents", exact: true }).click();
          await page.waitForURL((url) => url.pathname.endsWith("/agents"));
        }
        await page.getByRole("button", { name: "Review edit", exact: true }).click();
        await page.waitForURL((url) => url.pathname === originalPathname);
        await edit.waitFor();
        console.log(
          JSON.stringify({
            artifactDir: suite.artifactDir,
            reloads,
            url: page.url(),
            editedRows: await edit.count(),
            composerCount: await composer.count(),
          }),
        );
        expect(reloads, "automatic build recovery must not discard a queued correction").toBe(0);
        expect(await edit.inputValue()).toBe("Reply exactly CORRECTED-RELOAD");
        if (split) {
          await expect
            .poll(() =>
              page
                .locator("openclaw-chat-pane.chat-pane-cache__pane--active")
                .evaluate((element) => (element as HTMLElement & { paneId: string }).paneId),
            )
            .toBe("p1");
          const rightVisible = page
            .locator(".chat-split-view__cell")
            .nth(1)
            .locator(".chat-pane-cache__pane--visible");
          await expect
            .poll(() =>
              rightVisible.evaluate(
                (element) => (element as HTMLElement & { sessionKey: string }).sessionKey,
              ),
            )
            .toBe("agent:main:second");
          await expect
            .poll(() => rightVisible.evaluate((element) => element.hasAttribute("inert")))
            .toBe(narrow);
        }
        expect(await composer.inputValue()).toBe("Separate saved composer draft");
        await page.screenshot({
          path: `${suite.artifactDir}/${resolution}-reviewed-edit.png`,
          fullPage: true,
        });
        if (resolution === "save") {
          await page.locator(".chat-queue__edit-submit").click();
          await page
            .locator(".chat-pane-cache__pane--active .chat-queue__text", {
              hasText: "Reply exactly CORRECTED-RELOAD",
            })
            .waitFor();
        } else {
          await page.locator(".chat-queue__edit-cancel").click();
          await page
            .locator(".chat-pane-cache__pane--active .chat-queue__text", {
              hasText: "Reply exactly ORIGINAL-RELOAD",
            })
            .waitFor();
        }
        const reloaded = page.waitForEvent("domcontentloaded");
        await refresh.press("Enter");
        await reloaded;
        expect(reloads).toBe(1);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
    60000,
  );
  it.each([
    { resolution: "save", overflow: false },
    { resolution: "cancel", overflow: false },
    { resolution: "save", overflow: true },
    { resolution: "cancel", overflow: true },
  ] as const)(
    "keeps a correction through retained-session eviction until $resolution (all pinned: $overflow)",
    async ({ resolution, overflow }) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
      const gateway = await installMockGateway(page, {
        sessions: [
          ...["original", "second", "third"].map((name) => ({
            key: `agent:main:${name}`,
            label: `QA ${name}`,
            kind: "direct",
            updatedAt: Date.now(),
          })),
          { key: "agent:main:main", label: "Main", kind: "direct", updatedAt: Date.now() },
          {
            key: "agent:main:other",
            label: "Other QA conversation",
            kind: "direct",
            updatedAt: Date.now(),
          },
        ],
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat?session=agent:main:original`);
        const composer = page.locator(
          ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
        );
        await composer.waitFor({ state: "visible", timeout: 15000 });
        const originalPathname = new URL(page.url()).pathname;
        await gateway.setOnline(false);
        await composer.fill("Reply exactly ORIGINAL-RELOAD");
        await composer.press("Enter");
        const row = page.locator(".chat-queue__item", { hasText: "Reply exactly ORIGINAL-RELOAD" });
        await row.waitFor();
        await row.dblclick();
        const edit = page.locator(".chat-pane-cache__pane--active .chat-queue__edit-input");
        await edit.fill("Reply exactly CORRECTED-RELOAD");
        await composer.fill("Separate saved composer draft");
        await page.screenshot({
          path: `${suite.artifactDir}/${resolution}-before-navigation.png`,
          fullPage: true,
        });
        let reloads = 0;
        page.on("domcontentloaded", () => {
          reloads += 1;
        });
        await gateway.setOnline(true);
        for (const name of ["other", "second", "third"]) {
          await page
            .locator(`[data-session-key="agent:main:${name}"] a.sidebar-recent-session__link`)
            .click();
          await page.waitForURL((url) => url.pathname.endsWith(`/${name}`));
          await page
            .locator(".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea")
            .waitFor();
          await expect
            .poll(() =>
              page
                .locator("openclaw-chat-pane.chat-pane-cache__pane--active")
                .evaluate(
                  (element) => (element as HTMLElement & { sessionKey: string }).sessionKey,
                ),
            )
            .toBe(`agent:main:${name}`);
          if (overflow && name !== "third") {
            await gateway.setOnline(false);
            await composer.fill(`Queued ${name}`);
            await composer.press("Enter");
            await page.locator(".chat-pane-cache__pane--active .chat-queue__item").dblclick();
            await edit.fill(`Corrected ${name}`);
            await gateway.setOnline(true);
          }
        }
        const retainedPanes = page
          .locator("openclaw-chat-pane.chat-pane-cache__pane--active")
          .locator("..")
          .locator(":scope > openclaw-chat-pane");
        await expect.poll(() => retainedPanes.count()).toBe(overflow ? 4 : 3);
        await page
          .locator('[data-session-key="agent:main:original"] a.sidebar-recent-session__link')
          .click();
        await page.waitForURL((url) => url.pathname === originalPathname);
        await composer.waitFor();
        await expect
          .poll(() =>
            page
              .locator("openclaw-chat-pane.chat-pane-cache__pane--active")
              .evaluate((element) => (element as HTMLElement & { sessionKey: string }).sessionKey),
          )
          .toBe("agent:main:original");
        expect(await composer.inputValue()).toBe("Separate saved composer draft");
        await page.screenshot({
          path: `${suite.artifactDir}/${resolution}-after-navigation.png`,
          fullPage: true,
        });
        console.log(
          JSON.stringify({
            artifactDir: suite.artifactDir,
            reloads,
            editCount: await edit.count(),
            composer: await composer.inputValue(),
          }),
        );
        expect(await edit.count(), "queued correction must survive same-pane cache eviction").toBe(
          1,
        );
        expect(await edit.inputValue()).toBe("Reply exactly CORRECTED-RELOAD");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await page
          .locator(
            `.chat-pane-cache__pane--active ${resolution === "save" ? ".chat-queue__edit-submit" : ".chat-queue__edit-cancel"}`,
          )
          .click();
        await expect.poll(() => edit.count()).toBe(0);
        await expect.poll(() => retainedPanes.count()).toBe(3);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
    60000,
  );
});
