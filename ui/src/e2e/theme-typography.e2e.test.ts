import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  waitForControlUiRoute,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { openPicker, selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  createThemedChatOpener,
  themeConfigResponse,
} from "./theme-typography.test-support.ts";

/*
 * A theme that declares webfonts must actually paint in them, and a theme that
 * does not must never pay for them. Both halves are invisible to unit tests:
 * the stylesheet is linked at runtime and the faces only resolve once the
 * browser has fetched them, so a broken asset path or a dropped link degrades
 * silently to the fallback stack and looks merely "a bit off".
 */

// Every pair JetBrains Mono ligates, each closed by the trailing space that
// triggers the corruption reported in issue #137473.
const COMPOSER_LIGATURE_SEQUENCE = ">= ... -> => != <= :: ";

const suite = createControlUiE2eSuite({
  name: "Control UI theme typography",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is required for theme typography proof at ${executablePath}`,
});

const openThemedChat = createThemedChatOpener(suite);

async function captureTypography(
  page: Awaited<ReturnType<typeof openThemedChat>>["page"],
  name: string,
) {
  if (captureUiProof) {
    await mkdir(path.join(suite.artifactDir, "theme-typography"), { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: path.join(path.join(suite.artifactDir, "theme-typography"), `${name}.png`),
    });
  }
}

suite.define(() => {
  it("previews fonts on demand, applies independent overrides, and restores theme typography", async () => {
    const { page, themeRequests, gateway } = await openThemedChat("dash", "dark");
    await page.goto(`${suite.server.baseUrl}settings/appearance`);
    await waitForControlUiSettingsTakeover(page);
    const ui = page.locator("openclaw-select-picker:has(#settings-font-ui)");
    const chat = page.locator("openclaw-select-picker:has(#settings-font-chat)");
    const preview = page.locator(".settings-typography-preview");
    const fontRequests = () =>
      themeRequests.filter(
        (request) => request.includes(".css") && !request.startsWith("dash.css"),
      );
    await preview.waitFor();
    expect(await ui.locator("..").locator("..").textContent()).toContain(
      "Stored in this browser only",
    );
    await page.evaluate(() => document.fonts.ready);
    expect(new Set(fontRequests())).toEqual(
      new Set(["dm-sans.css 200", "fraunces.css 200", "jetbrains-mono.css 200"]),
    );
    const families = () =>
      preview.evaluate((panel) => ({
        ui: getComputedStyle(panel.querySelector(".settings-typography-preview__caption")!)
          .fontFamily,
        chat: getComputedStyle(panel.querySelector(".settings-typography-preview__prose")!)
          .fontFamily,
        code: getComputedStyle(panel.querySelector("code")!).fontFamily,
      }));
    const chatSmoothing = () =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--chat-font-smoothing"));
    const initial = await families();
    expect(initial.ui).toContain("DM Sans");
    expect(initial.chat).toContain("Fraunces");
    expect(initial.code).toContain("JetBrains Mono");
    expect(await chatSmoothing()).toBe("auto");
    if (captureUiProof) {
      await preview.scrollIntoViewIfNeeded();
    }
    await captureTypography(page, "picker-default");
    await openPicker(ui);
    await ui.locator('[role="option"][data-value="geist"]').waitFor({ state: "visible" });
    await expect.poll(() => fontRequests().length).toBe(9);
    expect(themeRequests.every((entry) => entry.endsWith(" 200"))).toBe(true);
    await captureTypography(page, "picker-specimens");
    await selectPickerValue(ui, "geist");
    await expect.poll(async () => (await families()).ui).toContain("Geist");
    expect((await families()).chat).toContain("Fraunces");
    await selectPickerValue(chat, "geist");
    await expect.poll(async () => (await families()).chat).toContain("Geist");
    // A sans chat override on a serif theme drops the serif smoothing opt-in.
    await expect.poll(chatSmoothing).toBe("");
    await selectPickerValue(chat, "lora");
    await expect.poll(async () => (await families()).chat).toContain("Lora");
    await expect.poll(chatSmoothing).toBe("auto");
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family),
        ),
      )
      .toEqual(expect.arrayContaining(["Geist", "Lora"]));
    expect((await families()).code).toBe(initial.code);
    expect(await gateway.getRequests("config.patch")).toEqual([]);
    await captureTypography(page, "picker-overrides");
    await page.reload();
    await waitForControlUiSettingsTakeover(page);
    await expect.poll(async () => (await families()).ui).toContain("Geist");
    await expect.poll(async () => (await families()).chat).toContain("Lora");
    await selectPickerValue(ui, "system");
    await expect.poll(async () => (await families()).ui).toContain("-apple-system");
    await selectPickerValue(ui, "theme");
    await selectPickerValue(chat, "theme");
    await expect.poll(families).toEqual(initial);
    expect(
      await page.evaluate(() =>
        ["--font-body", "--font-chat"].map((key) =>
          document.documentElement.style.getPropertyValue(key),
        ),
      ),
    ).toEqual(["", ""]);
  });

  // JetBrains Mono routes through --font-body in both themes, so native text
  // controls inherit contextual ligatures. Typing into one then corrupts the
  // already-typed glyphs (issue #137473) and the damage survives caret moves
  // and blur, while the value stays correct — so the assertion is that typing a
  // string paints what that same string paints without incremental input.
  // Rendered chat is not a text control and keeps its ligatures.
  it.each(["crt", "phosphor"])(
    "paints typed operator sequences like their own value in the %s composer",
    async (theme) => {
      const timestamp = Date.now();
      const { page } = await openThemedChat(theme, "dark", {
        historyMessages: [
          {
            content: [{ text: "say something", type: "text" }],
            role: "user",
            timestamp: timestamp - 1,
          },
          {
            content: [{ text: "a >= b and keep ... going", type: "text" }],
            role: "assistant",
            timestamp,
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await expect.poll(() => page.locator(".chat-text").last().textContent()).toContain("keep");

      const textarea = page.locator(".agent-chat__composer-combobox textarea");
      await expect.poll(() => textarea.isEditable()).toBe(true);
      await page.evaluate(() => document.fonts.ready);
      await textarea.click();
      // The reported failure sequence: operator pairs each closed by a trailing
      // space at the caret.
      await textarea.pressSequentially(COMPOSER_LIGATURE_SEQUENCE);
      expect(await textarea.inputValue()).toBe(COMPOSER_LIGATURE_SEQUENCE);
      // Blur first: the corruption outlives focus, and an unfocused control
      // paints no caret, so the two shots differ only in how the text arrived.
      await textarea.evaluate((element) => (element as HTMLTextAreaElement).blur());
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
      const valuePixels = await textarea.screenshot();

      // Typing must paint what the value itself paints. On an unfixed control
      // the typed shot drops glyphs the value shot renders, and these differ.
      expect(Buffer.compare(typedPixels, valuePixels)).toBe(0);

      const report = await page.evaluate(() => {
        const composer = document.querySelector<HTMLTextAreaElement>(
          ".agent-chat__composer-combobox textarea",
        );
        const chat = document.querySelector(".chat-text");
        return {
          chatLigatures: chat ? getComputedStyle(chat).fontVariantLigatures : null,
          composerFontFamily: composer
            ? (getComputedStyle(composer).fontFamily.split(",")[0] ?? "")
                .trim()
                .replace(/^["']|["']$/gu, "")
            : null,
        };
      });
      // The composer is still in the theme's mono face, and the transcript is
      // untouched — the opt-out is scoped to controls text is edited in.
      expect(report.composerFontFamily).toBe("JetBrains Mono");
      expect(report.chatLigatures).toBe("normal");
    },
  );

  // The opt-out belongs to native text controls, which the browser shapes
  // incrementally as you type. CodeMirror owns its own text layer, so it keeps
  // whatever the theme gives it and edit mode renders a file exactly like the
  // read view — a divergence there would be invisible without this assertion.
  it("scopes the ligature opt-out to native controls, not the file editor", async () => {
    const { gateway, page } = await openThemedChat("crt", "dark", {
      featureMethods: [...defaultControlUiFeatureMethods, "sessions.files.set"],
      historyMessages: [
        {
          content: [{ text: `Review \`notes.txt\`: ${COMPOSER_LIGATURE_SEQUENCE}`, type: "text" }],
          role: "assistant",
          timestamp: 1,
        },
      ],
      methodResponses: {
        "sessions.files.get": {
          cases: [
            {
              match: { path: "notes.txt" },
              response: {
                file: {
                  previewKind: "text",
                  contentEncoding: "utf8",
                  content: COMPOSER_LIGATURE_SEQUENCE,
                  hash: "a".repeat(64),
                  kind: "read",
                  missing: false,
                  name: "notes.txt",
                  path: "notes.txt",
                  workspacePath: "notes.txt",
                },
                root: "/workspace",
              },
            },
          ],
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);

    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await composer.waitFor({ state: "visible" });

    // Open the file first: fetching it needs the gateway, and queuing below
    // deliberately takes the connection offline.
    await page.locator('a.markdown-file-link[data-file-path="notes.txt"]').click();
    await page.locator(".cm-content").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Edit file" }).first().click();
    // contenteditable flips on only once the editor is actually editable.
    const editableContent = page.locator('.cm-content[contenteditable="true"]');
    await editableContent.waitFor();

    const ligaturesOf = (locator: Locator) =>
      locator.evaluate((element) => getComputedStyle(element).fontVariantLigatures);
    // Read the editor now: dropping the connection below returns the panel to
    // its read-only view, which would take the editable node with it.
    const fileEditorLigatures = await ligaturesOf(editableContent);
    const fileLineLigatures = await ligaturesOf(page.locator(".cm-line").first());

    // A queued draft reopened for editing is a bare textarea outside the
    // composer wrapper, so it only inherits the opt-out from the shared rule.
    await gateway.setOnline(false);
    await gateway.closeLatest();
    await composer.fill(COMPOSER_LIGATURE_SEQUENCE.trim());
    await composer.press("Enter");
    const queueRow = page.locator(".chat-queue__item").first();
    await queueRow.waitFor();
    await queueRow.dblclick();
    const queueEditor = queueRow.locator(".chat-queue__edit-input");
    await queueEditor.waitFor();

    expect(await ligaturesOf(composer)).toBe("no-contextual");
    expect(await ligaturesOf(queueEditor)).toBe("no-contextual");
    // The file editor keeps the theme's ligature rendering, so a file reads the
    // same whether it is being viewed or edited.
    expect(fileEditorLigatures).toBe("normal");
    expect(fileLineLigatures).toBe("normal");
  });

  it.each([["knot", "openknot", "#080808", "#f9f9fb"]])(
    "loads %s before paint in both modes without the app bundle",
    async (theme, resolved, dark, light) => {
      // Bundle aborts isolate the boot document; resource timing verifies the
      // browser actually blocks rendering, not merely that a link exists later.
      for (const mode of ["dark", "light"] as const) {
        const { page } = await openThemedChat(theme, mode, {
          // The app bundle is blocked to inspect the boot document before upgrade.
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
        expect(report.resolvedTheme).toBe(mode === "dark" ? resolved : `${resolved}-light`);
        expect(report.background).toBe(mode === "dark" ? dark : light);
        expect(report.palette).toEqual([
          { pathname: `/themes/${theme}.css`, version: report.buildId, blocking: "blocking" },
        ]);
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
    await page.locator(".chat-pane__nav-toggle").first().click();
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
    let releasePalette!: () => void;
    const paletteGate = new Promise<void>((resolve) => {
      releasePalette = resolve;
    });
    const tidePaletteUrl = /\/themes\/tide\.css(?:\?|$)/u;
    await page.route(tidePaletteUrl, async (route) => {
      await paletteGate;
      await route.continue();
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.locator(".agent-chat__composer-combobox textarea").waitFor();
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
      expect(await page.locator("html").getAttribute("data-theme")).toBe("openknot-light");
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
        ),
      ).toBe("#f9f9fb");
      await changeTheme("beacon");
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("beacon-light");
      const response = page.waitForResponse(tidePaletteUrl);
      releasePalette();
      await response;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(await page.locator("html").getAttribute("data-theme")).toBe("beacon-light");
      await changeTheme("tide");
      await expect
        .poll(() => page.locator("html").getAttribute("data-observed-theme-background"))
        .toBe("#f7f9fb");
      expect(await page.locator('meta[name="theme-color"]').first().getAttribute("content")).toBe(
        "#eef2f7",
      );
      await changeTheme("claw");
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("light");
    } finally {
      releasePalette();
    }
  });

  it("resolves the font stylesheet against a configured mount path", async () => {
    // A gateway mounted at a base path serves the bundle below that prefix, so
    // root-absolute font URLs 404 there and the theme silently falls back to
    // system faces while its palette still applies.
    const basePath = "/openclaw";
    const { page } = await openThemedChat("absolutely", "dark", { basePath });
    const requested: string[] = [];
    const fontRequests: URL[] = [];
    // The preview server does not stamp Gateway HTML. Reproduce the actual
    // document contract, rather than letting runtime repair a wrong boot URL.
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
      requested.push(url.pathname);
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

    const buildId = await page.locator("html").getAttribute("data-openclaw-control-ui-build-id");
    if (buildId !== null) {
      expect(buildId).not.toBe("");
    }
    // Failed optional stylesheets are removed so another selection can retry.
    // The actual request still has to carry the mount prefix and build identity.
    await expect
      .poll(() => fontRequests.some((url) => url.pathname.endsWith("/space-grotesk.css")))
      .toBe(true);
    const fontUrl = fontRequests.find((url) => url.pathname.endsWith("/space-grotesk.css"));
    expect(fontUrl?.pathname).toBe(`${basePath}/fonts/space-grotesk.css`);
    expect(fontUrl?.searchParams.get("v")).toBe(buildId);
    await expect.poll(() => page.locator("#openclaw-typeface-space-grotesk").count()).toBe(0);
    // The palette link is built in the first-paint script from the mount prefix
    // the gateway stamps on <html>, so it has to follow the mount too.
    const paletteHref = await page.evaluate(
      () =>
        document.getElementById("openclaw-theme-palette-absolutely")?.getAttribute("href") ?? null,
    );
    const paletteUrl = new URL(paletteHref ?? "", suite.server.baseUrl);
    expect(paletteUrl.pathname).toBe(`${basePath}/themes/absolutely.css`);
    expect(paletteUrl.searchParams.get("v")).toBe(buildId);
    expect(requested).toContain(`${basePath}/themes/absolutely.css`);
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      ),
    ).toBe("#1c1c1a");
  });
});
