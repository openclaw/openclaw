import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  installMockGateway,
  createControlUiMockSameOriginGatewayScript,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { exactButton, newChatPage } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eSuite,
  createControlUiE2eContextOptions,
} from "./control-ui-e2e-suite.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
const suite = createControlUiE2eSuite({
  name: "Queued correction update recovery",
  trackBrowserContexts: true,
});
const activePane = "openclaw-chat-pane.chat-pane-cache__pane--active";
const composerSelector = ".agent-chat__composer-combobox textarea";

async function installQueueGateway(page: Page, names = ["original", "second"]) {
  await page.clock.install();
  await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
  return installMockGateway(page, {
    sessions: [...names, "main", "other"].map((name) => ({
      key: `agent:main:${name}`,
      label: name === "main" ? "Main" : name === "other" ? "Other QA conversation" : `QA ${name}`,
      kind: "direct",
      updatedAt: Date.now(),
    })),
  });
}

async function disconnectGateway(page: Page, gateway: Gateway) {
  await pauseVirtualClock(page);
  await gateway.setOnline(false);
  // Start the first retry socket; narrow layouts can hide the status control.
  await page.clock.fastForward(2_000);
  await page.waitForFunction(
    () => window.openclawControlUi?.snapshot().gatewayPhase === "reconnecting",
  );
}

async function resumeGateway(page: Page, gateway: Gateway) {
  // Disconnect advanced the retry; taking the mock online opens its waiting socket.
  await gateway.setOnline(true);
  await page.clock.resume();
}

async function stageCorrection(page: Page, gateway: Gateway, editSelector: string) {
  const composer = page.locator(`.chat-pane-cache__pane--active ${composerSelector}`);
  await composer.waitFor({ state: "visible", timeout: 15000 });
  const originalPathname = new URL(page.url()).pathname;
  await disconnectGateway(page, gateway);
  await composer.fill("Reply exactly ORIGINAL-RELOAD");
  await composer.press("Enter");
  const row = page.locator(".chat-queue__item", { hasText: "Reply exactly ORIGINAL-RELOAD" });
  await row.waitFor();
  await row.dblclick();
  const edit = page.locator(editSelector);
  await edit.fill("Reply exactly CORRECTED-RELOAD");
  await composer.fill("Separate saved composer draft");
  return { composer, edit, originalPathname };
}

function expectSession(pane: Locator, sessionKey: string) {
  return expect
    .poll(() =>
      pane.evaluate((element) => (element as HTMLElement & { sessionKey: string }).sessionKey),
    )
    .toBe(sessionKey);
}

async function reviewStaleBuild(page: Page, gateway: Gateway, build: string) {
  const automaticReload = page.waitForEvent("domcontentloaded");
  await disconnectGateway(page, gateway);
  await gateway.deferNext("connect");
  const previous = (await gateway.getRequests("connect")).length;
  await resumeGateway(page, gateway);
  await gateway.waitForRequest("connect", { after: previous });
  await gateway.rejectDeferred("connect", {
    code: "UNAVAILABLE",
    message: "protocol mismatch: Control UI updated; reload this page to continue",
    details: { code: "PROTOCOL_MISMATCH", gatewayBuildId: build, reloadRequired: true },
    retryable: false,
  });
  const refresh = page.getByRole("button", { name: /Server updated/u });
  const dialog = page.locator('openclaw-modal-dialog[label="Unsent Incognito draft"]');
  const outcome = await Promise.race([
    automaticReload.then(() => "reloaded" as const),
    (async () => {
      await refresh.click();
      await exactButton(page, "Review private draft").click();
      await dialog.waitFor();
      return "held" as const;
    })(),
  ]);
  return { refresh, dialog, outcome };
}

async function visitSession(page: Page, name: string) {
  await page
    .locator(`[data-session-key="agent:main:${name}"] a.sidebar-recent-session__link`)
    .click();
  await page.waitForURL((url) => url.pathname.endsWith(`/${name}`));
}

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
      const page = await newChatPage(suite);
      const gateway = await installQueueGateway(page);
      await page.goto(
        `${suite.server.baseUrl}chat?session=${split ? "agent:main:original" : "main"}`,
      );
      const { composer, edit, originalPathname } = await stageCorrection(
        page,
        gateway,
        ".chat-queue__edit-input",
      );
      let reloads = 0;
      page.on("domcontentloaded", () => {
        reloads += 1;
      });
      await resumeGateway(page, gateway);
      await waitForControlUiGatewayReady(page);
      if (cachedSplit) {
        await selectChatLayoutAction(page, "Open split view");
        await page
          .locator(".chat-split-view__cell")
          .first()
          .locator(".agent-chat__composer-combobox textarea")
          .click();
      }
      await visitSession(page, "other");
      // Reconnect can hide the edit before navigation replaces the active pane.
      await expectSession(page.locator(activePane), "agent:main:other");
      await expect
        .poll(() => page.locator(".chat-pane-cache__pane--active .chat-queue__edit-input").count())
        .toBe(0);
      if (split) {
        if (!cachedSplit) {
          await selectChatLayoutAction(page, "Open split view");
        }
        await page
          .locator(".chat-split-view__cell")
          .nth(1)
          .locator(".agent-chat__composer-combobox textarea")
          .click();
        await visitSession(page, "second");
        await expectSession(page.locator(activePane), "agent:main:second");
      }
      if (narrow) {
        await page.setViewportSize({ width: 900, height: 900 });
      }
      await disconnectGateway(page, gateway);
      await gateway.setServerBuildId("e2e-next-queued-edit");
      await resumeGateway(page, gateway);
      const refresh = page.getByRole("button", { name: /Server updated/u });
      await refresh.waitFor();
      await refresh.press("Enter");
      await page
        .getByText("Save or cancel your queued message edit before reloading.", { exact: true })
        .waitFor();
      if (otherPage) {
        const pages = await openSidebarPages(page);
        await pages.getByRole("link", { name: "Sessions", exact: true }).click();
        await page.waitForURL((url) => url.pathname.endsWith("/sessions"));
      }
      await exactButton(page, "Review edit").click();
      await page.waitForURL((url) => url.pathname === originalPathname);
      await edit.waitFor();
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
        await expectSession(rightVisible, "agent:main:second");
        await expect
          .poll(() => rightVisible.evaluate((element) => element.hasAttribute("inert")))
          .toBe(narrow);
      }
      expect(await composer.inputValue()).toBe("Separate saved composer draft");
      await page
        .locator(resolution === "save" ? ".chat-queue__edit-submit" : ".chat-queue__edit-cancel")
        .click();
      await page
        .locator(".chat-pane-cache__pane--active .chat-queue__text", {
          hasText:
            resolution === "save"
              ? "Reply exactly CORRECTED-RELOAD"
              : "Reply exactly ORIGINAL-RELOAD",
        })
        .waitFor();
      const reloaded = page.waitForEvent("domcontentloaded");
      await refresh.press("Enter");
      await reloaded;
      expect(reloads).toBe(1);
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
      const page = await newChatPage(suite);
      const gateway = await installQueueGateway(page, ["original", "second", "third"]);
      await page.goto(`${suite.server.baseUrl}chat?session=agent:main:original`);
      const { composer, edit, originalPathname } = await stageCorrection(
        page,
        gateway,
        `${activePane} .chat-queue__edit-input`,
      );
      await resumeGateway(page, gateway);
      await waitForControlUiGatewayReady(page);
      for (const name of ["other", "second", "third"]) {
        await visitSession(page, name);
        await page
          .locator(".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea")
          .waitFor();
        await expectSession(page.locator(activePane), `agent:main:${name}`);
        if (overflow && name !== "third") {
          await disconnectGateway(page, gateway);
          await composer.fill(`Queued ${name}`);
          await composer.press("Enter");
          await page.locator(".chat-pane-cache__pane--active .chat-queue__item").dblclick();
          await edit.fill(`Corrected ${name}`);
          await resumeGateway(page, gateway);
          await waitForControlUiGatewayReady(page);
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
      await expectSession(page.locator(activePane), "agent:main:original");
      expect(await composer.inputValue()).toBe("Separate saved composer draft");
      expect(await edit.count(), "queued correction must survive same-pane cache eviction").toBe(1);
      expect(await edit.inputValue()).toBe("Reply exactly CORRECTED-RELOAD");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await page
        .locator(
          `.chat-pane-cache__pane--active ${resolution === "save" ? ".chat-queue__edit-submit" : ".chat-queue__edit-cancel"}`,
        )
        .click();
      await expect.poll(() => edit.count()).toBe(0);
      await expect.poll(() => retainedPanes.count()).toBe(3);
    },
    60000,
  );

  it("protects and reviews a private draft after the Gateway rejects a stale UI build", async () => {
    const page = await newChatPage(suite, {
      ...createControlUiE2eContextOptions(),
      viewport: { width: 2400, height: 1000 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await page.clock.install();
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
    await page.goto(`${suite.server.baseUrl}chat/main/dashboard/incognito-update-draft`);
    const privatePane = page.locator(
      'openclaw-chat-pane[aria-hidden="false"][data-mcp-app-owner-key*="incognito-update-draft"]',
    );
    const siblingPane = page.locator(
      'openclaw-chat-pane[aria-hidden="false"][data-mcp-app-owner-key*="ordinary-sibling"]',
    );
    const composer = ".agent-chat__composer-combobox textarea";
    await privatePane.locator(composer).waitFor();
    await selectChatLayoutAction(page, "Open split view");
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
    const { refresh, dialog, outcome } = await reviewStaleBuild(
      page,
      gateway,
      "qa832-replacement-build",
    );
    if (outcome === "reloaded") {
      await privatePane.locator(composer).waitFor();
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
    await exactButton(dialog, "Copy text").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(privateDraft);
    const downloaded = page.waitForEvent("download");
    await exactButton(dialog, "Download private-note.txt").click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("private-note.txt");
    await exactButton(dialog, "Keep in this tab").click();
    expect(reloads).toBe(0);
    expect(await privatePane.locator(composer).inputValue()).toBe(privateDraft);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    await refresh.click();
    await exactButton(page, "Review private draft").click();
    const reloaded = page.waitForEvent("domcontentloaded");
    await exactButton(dialog, "Discard this draft and refresh").click();
    await reloaded;
    expect(reloads).toBe(1);
    await siblingPane.locator(composer).waitFor();
    await expect.poll(() => siblingPane.locator(composer).inputValue()).toBe(siblingDraft);
  });

  it.each([false, true])(
    "protects an unsent Incognito New Session draft during an update (in Settings: %s)",
    async (settings) => {
      const page = await newChatPage(suite);
      await page.clock.install();
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
          .locator(".sidebar-identity-menu")
          .getByRole("menuitem", { name: "Settings", exact: true })
          .click();
        await page
          .locator(".settings-sidebar")
          .getByRole("link", { name: "Appearance", exact: true })
          .click();
        await page.getByRole("heading", { name: "Typography", exact: true }).waitFor();
      }
      const { dialog, outcome } = await reviewStaleBuild(
        page,
        gateway,
        "private-new-session-build",
      );
      expect(outcome, "a private New Session draft must hold automatic document replacement").toBe(
        "held",
      );
      expect(
        await dialog.getByRole("textbox", { name: "Draft text", exact: true }).inputValue(),
      ).toBe(text);
      await exactButton(dialog, "Download private-start.txt").waitFor();
      if (settings) {
        await page.setViewportSize({ width: 520, height: 900 });
      }
      await exactButton(dialog, "Keep in this tab").click();
      await page.getByRole("button", { name: /Server updated/u }).click();
      await exactButton(page, "Review private draft").click();
      const reloaded = page.waitForEvent("domcontentloaded");
      await exactButton(dialog, "Discard this draft and refresh").click();
      await reloaded;
    },
  );
});
