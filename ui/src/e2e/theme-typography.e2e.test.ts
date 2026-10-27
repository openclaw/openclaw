import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  waitForControlUiRoute,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiChatHistoryMessage as historyMessage } from "../test-helpers/control-ui-session-fixtures.ts";
import { openPicker, selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import { selectFileAction } from "./chat-file-actions.test-support.ts";
import { twoFrames } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createThemedChatOpener, themeConfigResponse } from "./theme-typography.test-support.ts";

// Trailing spaces trigger the JetBrains Mono corruption from #137473.
const COMPOSER_LIGATURE_SEQUENCE = ">= ... -> => != <= :: ";

const suite = createControlUiE2eSuite({
  name: "Control UI theme typography",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is required for theme typography proof at ${executablePath}`,
});

const openThemedChat = createThemedChatOpener(suite);
const composerSelector = ".agent-chat__composer-combobox textarea";
const waitForComposer = (page: Page) => page.locator(composerSelector).waitFor();
const cssToken = (page: Page, token: string) =>
  page.evaluate(
    (key) => getComputedStyle(document.documentElement).getPropertyValue(key).trim(),
    token,
  );
const attribute = (page: Page, name: string) => page.locator("html").getAttribute(name);
const ligaturesOf = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).fontVariantLigatures);
const expectTheme = (page: Page, theme: string) =>
  expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(theme);

suite.define(() => {
  it("previews fonts on demand, applies independent overrides, and restores theme typography", async () => {
    const { page, gateway } = await openThemedChat("dash", "dark");
    await page.goto(`${suite.server.baseUrl}settings/appearance`);
    await waitForControlUiSettingsTakeover(page);
    const ui = page.locator("openclaw-select-picker:has(#settings-font-ui)");
    const chat = page.locator("openclaw-select-picker:has(#settings-font-chat)");
    const preview = page.locator(".settings-typography-preview");
    await preview.waitFor();
    expect(await ui.locator("..").locator("..").textContent()).toContain(
      "Stored in this browser only",
    );
    await page.evaluate(() => document.fonts.ready);
    const families = () =>
      preview.evaluate((panel) => {
        const font = (selector: string) =>
          getComputedStyle(panel.querySelector(selector)!).fontFamily;
        return {
          ui: font(".settings-typography-preview__caption"),
          chat: font(".settings-typography-preview__prose"),
          code: font("code"),
        };
      });
    const initial = await families();
    expect(initial).toEqual({
      ui: expect.stringContaining("DM Sans"),
      chat: expect.stringContaining("Fraunces"),
      code: expect.stringContaining("JetBrains Mono"),
    });
    await openPicker(ui);
    await ui.locator('[role="option"][data-value="geist"]').waitFor({ state: "visible" });
    await selectPickerValue(ui, "geist");
    await expect.poll(async () => (await families()).ui).toContain("Geist");
    expect((await families()).chat).toContain("Fraunces");
    await selectPickerValue(chat, "geist");
    await expect.poll(async () => (await families()).chat).toContain("Geist");
    await selectPickerValue(chat, "lora");
    await expect.poll(async () => (await families()).chat).toContain("Lora");
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family),
        ),
      )
      .toEqual(expect.arrayContaining(["Geist", "Lora"]));
    expect(await gateway.getRequests("config.patch")).toEqual([]);
    await page.reload();
    await waitForControlUiSettingsTakeover(page);
    await expect.poll(async () => (await families()).ui).toContain("Geist");
    await expect.poll(async () => (await families()).chat).toContain("Lora");
    await selectPickerValue(ui, "system");
    await expect.poll(async () => (await families()).ui).toContain("-apple-system");
    await selectPickerValue(ui, "theme");
    await selectPickerValue(chat, "theme");
    await expect.poll(families).toEqual(initial);
  });

  // #137473: compare incremental input pixels with a whole-value assignment.
  it.each(["crt", "phosphor"])(
    "paints typed operator sequences like their own value in the %s composer",
    async (theme) => {
      const { page } = await openThemedChat(theme, "dark", {
        historyMessages: [historyMessage("assistant", "a >= b and keep ... going", Date.now())],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await expect.poll(() => page.locator(".chat-text").last().textContent()).toContain("keep");

      const textarea = page.locator(composerSelector);
      await expect.poll(() => textarea.isEditable()).toBe(true);
      await page.evaluate(() => document.fonts.ready);
      await textarea.click();
      await textarea.pressSequentially(COMPOSER_LIGATURE_SEQUENCE);
      expect(await textarea.inputValue()).toBe(COMPOSER_LIGATURE_SEQUENCE);
      // Blur removes the caret without hiding the corruption.
      await textarea.evaluate((element) => (element as HTMLTextAreaElement).blur());
      // Blur animates the ancestor border visible through this transparent field.
      await waitForControlUiProofSurface(textarea, []);
      const typedPixels = await textarea.screenshot();

      await textarea.evaluate((element, sequence) => {
        const field = element as HTMLTextAreaElement;
        field.value = "";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.value = sequence;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.blur();
      }, COMPOSER_LIGATURE_SEQUENCE);
      await expect.poll(() => textarea.inputValue()).toBe(COMPOSER_LIGATURE_SEQUENCE);
      await waitForControlUiProofSurface(textarea, []);
      const valuePixels = await textarea.screenshot();

      expect(Buffer.compare(typedPixels, valuePixels)).toBe(0);

      const family = await textarea.evaluate((el) => getComputedStyle(el).fontFamily);
      const primaryFamily = family
        .split(",")[0]
        ?.trim()
        .replace(/^["']|["']$/gu, "");
      expect(primaryFamily).toBe("JetBrains Mono");
      expect(await ligaturesOf(page.locator(".chat-text").first())).toBe("normal");
    },
  );

  it("scopes the ligature opt-out to native controls, not the file editor", async () => {
    const file = {
      previewKind: "text",
      contentEncoding: "utf8",
      content: COMPOSER_LIGATURE_SEQUENCE,
      hash: "a".repeat(64),
      kind: "read",
      missing: false,
      path: "notes.txt",
    };
    const { gateway, page } = await openThemedChat("crt", "dark", {
      featureMethods: [...defaultControlUiFeatureMethods, "sessions.files.set"],
      historyMessages: [
        historyMessage("assistant", `Review \`notes.txt\`: ${COMPOSER_LIGATURE_SEQUENCE}`, 1),
      ],
      methodResponses: {
        "sessions.files.get": {
          cases: [{ match: { path: file.path }, response: { file, root: "/workspace" } }],
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);

    const composer = page.locator(composerSelector);
    await composer.waitFor({ state: "visible" });

    // Capture CodeMirror while online; disconnecting replaces its editable node.
    await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
    await page.locator(".cm-content").waitFor({ state: "visible" });
    await selectFileAction(
      page.locator(".sidebar-file-view").filter({ visible: true }),
      "Edit file",
    );
    const editableContent = page.locator('.cm-content[contenteditable="true"]');
    await editableContent.waitFor();

    const fileEditorLigatures = await ligaturesOf(editableContent);
    const fileLineLigatures = await ligaturesOf(page.locator(".cm-line").first());

    // The queued draft is a bare textarea outside the composer wrapper.
    await gateway.setOnline(false);
    await gateway.closeLatest();
    await composer.fill(COMPOSER_LIGATURE_SEQUENCE.trim());
    await composer.press("Enter");
    const queueRow = page.locator(".chat-queue__item").first();
    await queueRow.waitFor();
    await queueRow.dblclick();
    const queueEditor = queueRow.locator(".chat-queue__edit-input");
    await queueEditor.waitFor();

    expect([
      await ligaturesOf(composer),
      await ligaturesOf(queueEditor),
      fileEditorLigatures,
      fileLineLigatures,
    ]).toEqual(["no-contextual", "no-contextual", "normal", "normal"]);
  });

  it.each([["knot", "openknot", "#080808", "#f9f9fb"]])(
    "loads %s before paint in both modes without the app bundle",
    async (theme, resolved, dark, light) => {
      // Resource timing proves the palette blocks paint before app upgrade.
      for (const mode of ["dark", "light"] as const) {
        const { page } = await openThemedChat(theme, mode, {
          awaitInitialRoster: false,
        });
        await page.route("**/assets/**.js", (route) => route.abort());
        await page.goto(`${suite.server.baseUrl}chat`);
        const report = await page.evaluate(() => ({
          buildId: document.documentElement.getAttribute("data-openclaw-control-ui-build-id"),
          background: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
          resolvedTheme: document.documentElement.dataset.theme,
          palette: performance
            .getEntriesByType("resource")
            .filter((entry) => new URL(entry.name).pathname.includes("/themes/"))
            .map((entry) => ({
              pathname: new URL(entry.name).pathname,
              version: new URL(entry.name).searchParams.get("v"),
              blocking: (entry as PerformanceResourceTiming & { renderBlockingStatus: string })
                .renderBlockingStatus,
            })),
        }));
        expect(report).toMatchObject({
          resolvedTheme: mode === "dark" ? resolved : `${resolved}-light`,
          background: mode === "dark" ? dark : light,
          palette: [
            { pathname: `/themes/${theme}.css`, version: report.buildId, blocking: "blocking" },
          ],
        });
      }
    },
  );

  it("keeps system chrome with the mounted route across shell and viewport lifecycles", async () => {
    const { page } = await openThemedChat("claw", "light");
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.locator(".agent-chat__composer-combobox textarea").waitFor();

    const readChrome = () =>
      page.evaluate(() => ({
        color: document.documentElement.style.getPropertyValue(
          "--control-ui-system-chrome-background",
        ),
        metas: Array.from(
          document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
          (meta) => ({ color: meta.content, media: meta.getAttribute("media") }),
        ),
      }));
    const expectChrome = async (color: string) => {
      await expect.poll(readChrome).toEqual({
        color,
        metas: [
          { color, media: null },
          { color, media: null },
        ],
      });
    };
    const pageColor = "#faf9f7";
    const chatColor = "#f4f1ec";
    await expectChrome(chatColor);

    // Use the shell's actual shortcut and browser history without rebuilding the runtime.
    await page.locator(".shell-skip-link").focus();
    await page.keyboard.press("ControlOrMeta+Shift+,");
    await waitForControlUiRoute(page, { pathname: "/settings/appearance", routeId: "appearance" });
    await expectChrome(pageColor);
    await page.goBack();
    await page.locator(".agent-chat__composer-combobox textarea").waitFor();
    await expectChrome(chatColor);
    await navigationDrawerToggle(page).click();
    await page.locator("openclaw-app-sidebar .sidebar-rail .sidebar-new-session").click();
    await page.locator(".new-session-page__message").waitFor();
    await expectChrome(chatColor);

    for (const [width, height, color] of [
      [1280, 900, pageColor],
      [900, 450, chatColor],
      [900, 900, pageColor],
      [720, 900, chatColor],
    ] as const) {
      await page.setViewportSize({ width, height });
      await expectChrome(color);
    }

    // Reparenting a plain Solid host keeps its mounted root and route alive.
    const reconnect = await page.locator("openclaw-app-shell").evaluate((element) => {
      const shell = element;
      const parent = shell.parentNode!;
      const next = shell.nextSibling;
      const color = () =>
        document.documentElement.style.getPropertyValue("--control-ui-system-chrome-background");
      try {
        shell.remove();
        const removed = color();
        parent.insertBefore(shell, next);
        return {
          removed,
          reconnected: color(),
          sameShell: document.querySelector("openclaw-app-shell") === shell,
        };
      } finally {
        if (!shell.isConnected) {
          parent.insertBefore(shell, next);
        }
      }
    });
    expect(reconnect).toEqual({ removed: chatColor, reconnected: chatColor, sameShell: true });
    await expectChrome(chatColor);
    await page.locator(".shell-skip-link").focus();
    await page.keyboard.press("ControlOrMeta+Shift+,");
    await waitForControlUiRoute(page, { pathname: "/settings/appearance", routeId: "appearance" });
    await expectChrome(pageColor);
    await page.goBack();
    await page.locator(".new-session-page__message").waitFor();
    await expectChrome(chatColor);
  });

  it("publishes a runtime palette only when its colors are ready and ignores superseded loads", async () => {
    const { page, gateway } = await openThemedChat("knot", "light");
    await page.setViewportSize({ width: 720, height: 900 });
    const { promise: paletteGate, resolve: releasePalette } = createDeferred();
    const tidePaletteUrl = /\/themes\/tide\.css(?:\?|$)/u;
    await page.route(tidePaletteUrl, async (route) => {
      await paletteGate;
      await route.continue();
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await waitForComposer(page);
    await page.evaluate(() => {
      const root = document.documentElement;
      new MutationObserver(() => {
        if (root.dataset.theme === "tide-light") {
          root.dataset.observedThemeBackground = getComputedStyle(root)
            .getPropertyValue("--bg")
            .trim();
        }
      }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    });
    const changeTheme = async (theme: string) => {
      await gateway.setMethodResponse("config.get", themeConfigResponse(theme, "light"));
      await gateway.emitGatewayEvent("config.changed", { hash: `theme-${theme}`, ts: Date.now() });
    };
    try {
      const request = page.waitForRequest(tidePaletteUrl);
      await changeTheme("tide");
      await request;
      expect([await attribute(page, "data-theme"), await cssToken(page, "--bg")]).toEqual([
        "openknot-light",
        "#f9f9fb",
      ]);
      await changeTheme("beacon");
      await expectTheme(page, "beacon-light");
      const response = page.waitForResponse(tidePaletteUrl);
      releasePalette();
      await response;
      await twoFrames(page);
      expect(await attribute(page, "data-theme")).toBe("beacon-light");
      await changeTheme("tide");
      await expect.poll(() => attribute(page, "data-observed-theme-background")).toBe("#f7f9fb");
      expect(await page.locator('meta[name="theme-color"]').first().getAttribute("content")).toBe(
        "#eef2f7",
      );
      await changeTheme("claw");
      await expectTheme(page, "light");
    } finally {
      releasePalette();
    }
  });

  it("resolves the font stylesheet against a configured mount path", async () => {
    const basePath = "/openclaw";
    const { page } = await openThemedChat("absolutely", "dark", { basePath });
    const fontRequests: URL[] = [];
    // Stamp Gateway's mount contract onto preview-server HTML.
    await page.route("**/*", async (route) => {
      if (
        route.request().resourceType() !== "document" ||
        !new URL(route.request().url()).pathname.startsWith(`${basePath}/`)
      ) {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const html = (await response.text()).replace(
        /<html\b/u,
        `<html data-openclaw-control-ui-base-path="${basePath}"`,
      );
      await route.fulfill({ response, body: html });
    });
    await page.route(`**${basePath}/themes/**`, async (route) => {
      const url = new URL(route.request().url());
      url.pathname = url.pathname.slice(basePath.length);
      await route.fulfill({ response: await route.fetch({ url: url.href }) });
    });
    await page.route(`**${basePath}/fonts/**`, async (route) => {
      fontRequests.push(new URL(route.request().url()));
      await route.fulfill({ status: 404, body: "", contentType: "text/css" });
    });

    await page.goto(`${suite.server.baseUrl}${basePath.slice(1)}/chat`);
    await page
      .locator(".agent-chat__composer-combobox textarea")
      .waitFor({ state: "visible", timeout: 30_000 });

    const buildId = await attribute(page, "data-openclaw-control-ui-build-id");
    await expect
      .poll(() => fontRequests.some((url) => url.pathname.endsWith("/space-grotesk.css")))
      .toBe(true);
    const fontUrl = fontRequests.find((url) => url.pathname.endsWith("/space-grotesk.css"));
    expect(fontUrl?.pathname).toBe(`${basePath}/fonts/space-grotesk.css`);
    expect(fontUrl?.searchParams.get("v")).toBe(buildId);
    await expect.poll(() => page.locator("#openclaw-typeface-space-grotesk").count()).toBe(0);
    const paletteHref = await page.evaluate(
      () =>
        document.getElementById("openclaw-theme-palette-absolutely")?.getAttribute("href") ?? null,
    );
    const paletteUrl = new URL(paletteHref ?? "", suite.server.baseUrl);
    expect(paletteUrl.pathname).toBe(`${basePath}/themes/absolutely.css`);
    expect(paletteUrl.searchParams.get("v")).toBe(buildId);
    expect(await cssToken(page, "--bg-content")).toBe("#1b1b1a");
  });
});
