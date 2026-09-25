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

  it("protects and reviews a private draft after the Gateway rejects a stale UI build", async () => {
    const context = await suite.newBrowserContext({
      ...createControlUiE2eContextOptions(),
      viewport: { width: 2400, height: 1000 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const privateKey = "agent:main:dashboard:incognito-update-draft";
    const ordinaryKey = "agent:main:ordinary-sibling";
    const privateDraft = "QA832 private unsent draft — café 雪 🦞.";
    const siblingDraft = "QA445 protected ordinary sibling";
    await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
    const gateway = await installMockGateway(page, {
      sessions: [
        { key: ordinaryKey, label: "Ordinary draft", kind: "direct", updatedAt: 1 },
        { key: privateKey, label: "Private draft", incognito: true, kind: "direct", updatedAt: 1 },
      ],
      sessionTranscripts: {
        [privateKey]: {
          messages: [{ role: "assistant", content: "Synthetic private conversation." }],
        },
      },
    });
    let reloads = 0;
    try {
      await page.goto(`${suite.server.baseUrl}chat/main/dashboard/incognito-update-draft`);
      const privatePane = page.locator(
        'openclaw-chat-pane[aria-hidden="false"][data-mcp-app-owner-key*="incognito-update-draft"]',
      );
      const siblingPane = page.locator(
        'openclaw-chat-pane[aria-hidden="false"][data-mcp-app-owner-key*="ordinary-sibling"]',
      );
      const composer = ".agent-chat__composer-combobox textarea";
      await privatePane.locator(composer).waitFor();
      await page.getByRole("button", { name: "Open split view", exact: true }).click();
      await page.locator(".chat-split-view__cell").first().locator(composer).click();
      await page
        .locator(`[data-session-key="${ordinaryKey}"] a.sidebar-recent-session__link`)
        .click();
      await siblingPane.locator(composer).fill(siblingDraft);
      await privatePane.locator(composer).fill(privateDraft);
      await privatePane.locator(".agent-chat__file-input").setInputFiles({
        name: "private-note.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("QA832 staged private attachment — 雪"),
      });
      await privatePane.getByText("private-note.txt", { exact: true }).first().waitFor();
      page.on("domcontentloaded", () => {
        reloads += 1;
      });
      const automaticReload = page.waitForEvent("domcontentloaded");
      await gateway.setOnline(false);
      await gateway.deferNext("connect");
      const previous = (await gateway.getRequests("connect")).length;
      await gateway.setOnline(true);
      await gateway.waitForRequest("connect", { after: previous });
      await gateway.rejectDeferred("connect", {
        code: "UNAVAILABLE",
        message: "protocol mismatch: Control UI updated; reload this page to continue",
        details: {
          code: "PROTOCOL_MISMATCH",
          gatewayBuildId: "qa832-replacement-build",
          reloadRequired: true,
        },
        retryable: false,
      });
      const refresh = page.getByRole("button", { name: /Server updated/u });
      const dialog = page.locator('openclaw-modal-dialog[label="Unsent Incognito draft"]');
      const recovery = await Promise.race([
        automaticReload.then(() => "reloaded" as const),
        (async () => {
          await refresh.click();
          await page.getByRole("button", { name: "Review private draft", exact: true }).click();
          await dialog.waitFor();
          return "held" as const;
        })(),
      ]);
      if (recovery === "reloaded") {
        await privatePane.locator(composer).waitFor();
        await page.screenshot({
          path: `${suite.artifactDir}/private-draft-lost-on-update.png`,
          fullPage: true,
        });
        expect(
          await privatePane.locator(composer).inputValue(),
          "automatic build recovery must retain unsent private input",
        ).toBe(privateDraft);
      }
      expect(reloads).toBe(0);
      expect(
        await dialog.getByRole("textbox", { name: "Draft text", exact: true }).inputValue(),
      ).toBe(privateDraft);
      expect(await siblingPane.locator(composer).inputValue()).toBe(siblingDraft);
      await dialog.getByRole("button", { name: "Copy text", exact: true }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(privateDraft);
      const downloaded = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "Download private-note.txt", exact: true }).click();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe("private-note.txt");
      await page.screenshot({
        path: `${suite.artifactDir}/private-draft-update-review.png`,
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "Keep in this tab", exact: true }).click();
      expect(reloads).toBe(0);
      expect(await privatePane.locator(composer).inputValue()).toBe(privateDraft);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await refresh.click();
      await page.getByRole("button", { name: "Review private draft", exact: true }).click();
      const reloaded = page.waitForEvent("domcontentloaded");
      await dialog
        .getByRole("button", { name: "Discard this draft and refresh", exact: true })
        .click();
      await reloaded;
      expect(reloads).toBe(1);
      await siblingPane.locator(composer).waitFor();
      expect(await siblingPane.locator(composer).inputValue()).toBe(siblingDraft);
    } catch (error) {
      await page.screenshot({
        path: `${suite.artifactDir}/private-draft-update-failure.png`,
        fullPage: true,
      });
      console.log(JSON.stringify({ reloads, url: page.url() }));
      throw error;
    }
  });

  it.each([false, true])(
    "protects an unsent Incognito New Session draft during an update (in Settings: %s)",
    async (settings) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new`);
      await page.getByRole("switch", { name: "Incognito", exact: true }).click();
      const composer = page.locator(".new-session-page textarea");
      const text = "Private New Session draft — café 雪 🦞";
      await composer.fill(text);
      await page.locator(".new-session-page .agent-chat__file-input").setInputFiles({
        name: "private-start.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Private New Session attachment"),
      });
      await page.getByText("private-start.txt", { exact: true }).first().waitFor();
      if (settings) {
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.locator(".sidebar-identity-card").click();
        await sidebar
          .locator("wa-dropdown.sidebar-identity-menu")
          .getByRole("menuitem", { name: "Settings", exact: true })
          .click();
        await page
          .locator(".settings-sidebar")
          .getByRole("link", { name: "Appearance", exact: true })
          .click();
        await page.getByRole("heading", { name: "Typography", exact: true }).waitFor();
      }
      const automaticReload = page.waitForEvent("domcontentloaded");
      await gateway.setOnline(false);
      await gateway.deferNext("connect");
      const previous = (await gateway.getRequests("connect")).length;
      await gateway.setOnline(true);
      await gateway.waitForRequest("connect", { after: previous });
      await gateway.rejectDeferred("connect", {
        code: "UNAVAILABLE",
        message: "protocol mismatch: Control UI updated; reload this page to continue",
        details: {
          code: "PROTOCOL_MISMATCH",
          gatewayBuildId: "private-new-session-build",
          reloadRequired: true,
        },
        retryable: false,
      });
      const dialog = page.locator('openclaw-modal-dialog[label="Unsent Incognito draft"]');
      const outcome = await Promise.race([
        automaticReload.then(() => "reloaded" as const),
        (async () => {
          await page.getByRole("button", { name: /Server updated/u }).click();
          await page.getByRole("button", { name: "Review private draft", exact: true }).click();
          await dialog.waitFor();
          return "held" as const;
        })(),
      ]);
      if (outcome === "reloaded") {
        await page.screenshot({
          path: `${suite.artifactDir}/private-new-session-lost-${settings}.png`,
          fullPage: true,
        });
      }
      expect(outcome, "a private New Session draft must hold automatic document replacement").toBe(
        "held",
      );
      expect(
        await dialog.getByRole("textbox", { name: "Draft text", exact: true }).inputValue(),
      ).toBe(text);
      await dialog
        .getByRole("button", { name: "Download private-start.txt", exact: true })
        .waitFor();
      if (settings) {
        await page.setViewportSize({ width: 520, height: 900 });
      }
      await page.screenshot({
        path: `${suite.artifactDir}/private-new-session-review-${settings}.png`,
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "Keep in this tab", exact: true }).click();
      await page.getByRole("button", { name: /Server updated/u }).click();
      await page.getByRole("button", { name: "Review private draft", exact: true }).click();
      const reloaded = page.waitForEvent("domcontentloaded");
      await dialog
        .getByRole("button", { name: "Discard this draft and refresh", exact: true })
        .click();
      await reloaded;
    },
  );
});
