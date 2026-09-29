import { mkdir } from "node:fs/promises";
import path from "node:path";
import type WaTooltip from "@awesome.me/webawesome/dist/components/tooltip/tooltip.js";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
  type ControlUiMockGatewayScenario,
  waitForControlUiRoute,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { openPicker, selectPickerValue } from "../test-helpers/select-picker-e2e.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

/*
 * A theme that declares webfonts must actually paint in them, and a theme that
 * does not must never pay for them. Both halves are invisible to unit tests:
 * the stylesheet is linked at runtime and the faces only resolve once the
 * browser has fetched them, so a broken asset path or a dropped link degrades
 * silently to the fallback stack and looks merely "a bit off".
 */

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

// Every pair JetBrains Mono ligates, each closed by the trailing space that
// triggers the corruption reported in issue #137473.
const COMPOSER_LIGATURE_SEQUENCE = ">= ... -> => != <= :: ";

const suite = createControlUiE2eSuite({
  name: "Control UI theme typography",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is required for theme typography proof at ${executablePath}`,
});

function themeConfigResponse(theme: string, mode: "dark" | "light") {
  const config = { ui: { prefs: { theme, themeMode: mode } } };
  const hash = `theme-typography-${theme}-${mode}`;
  return {
    appliedConfigHash: hash,
    config,
    configRevisionHash: hash,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

async function openThemedChat(
  theme: string,
  mode: "dark" | "light",
  scenario: Pick<
    ControlUiMockGatewayScenario,
    "awaitInitialRoster" | "basePath" | "featureMethods" | "historyMessages" | "methodResponses"
  > = {},
) {
  const context = await suite.newBrowserContext({
    colorScheme: mode,
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
  await context.addInitScript(
    ({ gatewayUrl, initialMode, initialTheme }) => {
      if (sessionStorage.getItem("typography-seeded")) {
        return;
      }
      sessionStorage.setItem("typography-seeded", "1");
      localStorage.setItem(
        `openclaw.control.settings.v1:${gatewayUrl}`,
        JSON.stringify({ gatewayUrl, theme: initialTheme, themeMode: initialMode }),
      );
    },
    {
      gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
      initialMode: mode,
      initialTheme: theme,
    },
  );
  const page = await context.newPage();
  const themeRequests: string[] = [];
  page.on("response", (response) => {
    const { pathname } = new URL(response.url());
    if (pathname.includes("/fonts/") || pathname.includes("/themes/")) {
      themeRequests.push(`${pathname.split("/").pop()} ${response.status()}`);
    }
  });
  const gateway = await installMockGateway(page, {
    ...scenario,
    methodResponses: {
      ...scenario.methodResponses,
      "config.get": themeConfigResponse(theme, mode),
    },
  });
  return { themeRequests, gateway, page };
}

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
    expect(await chatSmoothing()).toBe("auto");
    if (captureUiProof) {
      await preview.scrollIntoViewIfNeeded();
    }
    await captureTypography(page, "picker-default");
    await openPicker(ui);
    await ui.locator('[role="option"][data-value="geist"]').waitFor({ state: "visible" });
    await expect.poll(() => fontRequests().length).toBe(9);
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

  it.each([
    ["claw", "Instrument Sans", "Instrument Sans", ["instrument-sans"], "antialiased"],
    ["knot", "Geist", "Geist", ["geist"], "antialiased"],
    ["dash", "DM Sans", "Fraunces", ["dm-sans", "fraunces"], "auto"],
    ["absolutely", "Space Grotesk", "Lora", ["space-grotesk", "lora"], "auto"],
    ["tide", "IBM Plex Sans", "IBM Plex Sans", ["ibm-plex-sans"], "antialiased"],
    [
      "beacon",
      "Atkinson Hyperlegible Next",
      "Atkinson Hyperlegible Next",
      ["atkinson-hyperlegible"],
      "antialiased",
    ],
    ["phosphor", "JetBrains Mono", "JetBrains Mono", ["jetbrains-mono"], "antialiased"],
    ["crt", "JetBrains Mono", "JetBrains Mono", ["jetbrains-mono"], "antialiased"],
    ["manuscript", "Lora", "Lora", ["lora"], "auto"],
    ["rose", "DM Sans", "DM Sans", ["dm-sans"], "antialiased"],
    ["miami", "Space Grotesk", "Space Grotesk", ["space-grotesk"], "antialiased"],
  ] as const)(
    "paints %s chrome and chat prose in its own faces",
    async (theme, body, chat, faces, chatSmoothing) => {
      const timestamp = Date.now();
      const text =
        "Typography carries the theme: chat prose renders in the reading face while chrome, chips, and code keep their own: `const example = 1`.";
      const { themeRequests, page } = await openThemedChat(theme, "dark", {
        historyMessages: [
          {
            content: [{ text: "say something", type: "text" }],
            role: "user",
            timestamp: timestamp - 1,
          },
          {
            content: [{ text, type: "text" }],
            role: "assistant",
            timestamp,
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await expect
        .poll(() => page.locator(".chat-text").last().textContent())
        .toContain("Typography");
      await page.locator(".chat-text code").waitFor({ state: "visible" });

      const report = await page.evaluate(async () => {
        await document.fonts.ready;
        const chats = document.querySelectorAll(".chat-text");
        const lastChat = chats[chats.length - 1];
        const primary = (value: string) =>
          (value.split(",")[0] ?? "").trim().replace(/^["']|["']$/gu, "");
        return {
          buildId: document.documentElement.getAttribute("data-openclaw-control-ui-build-id"),
          chatFontFamily: lastChat ? primary(getComputedStyle(lastChat).fontFamily) : null,
          codeFontFamily: lastChat?.querySelector("code")
            ? primary(getComputedStyle(lastChat.querySelector("code")!).fontFamily)
            : null,
          chatFontSmoothing: lastChat
            ? getComputedStyle(lastChat).getPropertyValue("-webkit-font-smoothing")
            : null,
          bodyFontFamily: primary(getComputedStyle(document.body).fontFamily),
          stylesheets: [
            ...document.querySelectorAll<HTMLLinkElement>('link[id^="openclaw-typeface-"]'),
          ].map((link) => {
            const url = new URL(link.href);
            return { pathname: url.pathname, version: url.searchParams.get("v") };
          }),
          loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
        };
      });

      // Every theme also declares the mono face: base.css --mono names
      // JetBrains Mono for code spans regardless of the active family.
      const expectedFaces = [...new Set([...faces, "jetbrains-mono"])];
      if (report.buildId !== null) {
        expect(report.buildId).not.toBe("");
      }
      expect(report.stylesheets).toEqual(
        expectedFaces.map((face) => ({
          pathname: `/fonts/${face}.css`,
          version: report.buildId,
        })),
      );
      expect(report.bodyFontFamily).toBe(body);
      expect(report.chatFontFamily).toBe(chat);
      expect(report.codeFontFamily).toBe("JetBrains Mono");
      // Serif chat faces opt out of the app-wide `antialiased` thinning
      // (applyChatFontSmoothing) so their hairlines stay crisp.
      expect(report.chatFontSmoothing).toBe(chatSmoothing);
      // Mono glyphs on the page pull the always-declared JetBrains Mono face.
      expect(new Set(report.loaded)).toEqual(new Set([body, chat, "JetBrains Mono"]));
      expect(themeRequests.every((entry) => entry.endsWith(" 200"))).toBe(true);

      await captureTypography(page, `${theme}-chat-dark`);
    },
  );

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

  it.each(["MacIntel", "Linux x86_64"])(
    "keeps shortcut letters aligned on the system UI stack on %s",
    async (platform) => {
      const { page } = await openThemedChat("phosphor", "dark");
      await page.addInitScript((value) => {
        Object.defineProperty(navigator, "platform", { get: () => value });
      }, platform);
      const popupModule = await holdModuleResponse(page, /\/assets\/tooltip-[^/?]+\.js(?:\?.*)?$/u);
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const trigger = page.locator(".sidebar-brand__search");
        await trigger.waitFor();
        expect(popupModule.requests()).toBe(0);
        await trigger.focus();
        await popupModule.request;
        expect(await trigger.getAttribute("aria-describedby")).not.toBeNull();
        await page.keyboard.press("Escape");
        popupModule.release();
        await page.waitForFunction(() => Boolean(customElements.get("wa-tooltip")));
        const popup = trigger.locator("..").locator("wa-tooltip");
        expect(
          await popup.evaluate(async (element: WaTooltip) => {
            await element.updateComplete;
            return element.open;
          }),
        ).toBe(false);
      } finally {
        popupModule.release();
      }
      const identity = page.locator(".sidebar-identity-card");
      await identity.focus();
      await page.keyboard.press("Enter");
      const menu = page.locator("wa-dropdown.sidebar-identity-menu");
      await menu.waitFor();
      const shortcut = menu
        .locator('wa-dropdown-item[value="command:settings"]')
        .locator(".session-menu__shortcut");

      const report = await shortcut.evaluate((element) => ({
        body: getComputedStyle(document.body).fontFamily,
        shortcut: getComputedStyle(element).fontFamily,
        text: element.textContent?.replace(/\s+/gu, ""),
      }));
      expect(report.body).toMatch(/^"?JetBrains Mono/u);
      expect(report.shortcut).toMatch(/^system-ui,/u);
      const applePlatform = platform === "MacIntel";
      expect(report.text).toBe(applePlatform ? "⌘⇧," : "Ctrl+Shift+,");

      await page.keyboard.press("Escape");
      await page.locator(".chat-side-panel-toggle").click();
      const panelSelector = page.locator(".side-panel-empty--selector");
      const panelShortcuts = panelSelector.locator(".side-panel-type-option__shortcut");
      await panelSelector.waitFor();
      const labels = applePlatform
        ? ["⌘⌥⇧E", "⌘⇧B", "⌘⇧S"]
        : ["Ctrl+Alt+Shift+E", "Ctrl+Shift+B", "Ctrl+Shift+S"];
      expect(
        await panelShortcuts.evaluateAll((keys) =>
          keys.map((key) => ({
            text: key.textContent?.replace(/\s+/gu, ""),
            font: getComputedStyle(key).fontFamily,
          })),
        ),
      ).toEqual(labels.map((text) => ({ text, font: expect.stringMatching(/^system-ui,/u) })));

      const inkOffsets = await panelShortcuts.evaluateAll((keys) =>
        keys.map((key) => {
          const letter = key.querySelector<HTMLElement>(".kbd__text");
          const context = document.createElement("canvas").getContext("2d");
          if (!letter || !context) {
            throw new Error("Shortcut must have a measurable letter");
          }
          const style = getComputedStyle(letter);
          context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const ink = context.measureText(letter.textContent ?? "");
          // A zero-height inline box exposes the text baseline without replacing the glyph.
          const baseline = document.createElement("span");
          baseline.style.cssText = "display:inline-block;width:0;height:0";
          letter.append(baseline);
          const baselineY = baseline.getBoundingClientRect().y;
          baseline.remove();
          const box = key.getBoundingClientRect();
          return (
            baselineY +
            (ink.actualBoundingBoxDescent - ink.actualBoundingBoxAscent) / 2 -
            box.y -
            box.height / 2
          );
        }),
      );
      // Font hinting rounds cap ink to device pixels; do not center the whole line box instead.
      for (const offset of inkOffsets) {
        expect(Math.abs(offset)).toBeLessThan(0.75);
      }

      if (captureUiProof) {
        await mkdir(path.join(suite.artifactDir, "theme-typography"), { recursive: true });
        await panelSelector.screenshot({
          path: path.join(
            path.join(suite.artifactDir, "theme-typography"),
            "phosphor-panel-shortcuts.png",
          ),
        });
      }

      await page.keyboard.press(`${applePlatform ? "Meta" : "Control"}+Shift+S`);
      await page.locator('[data-panel-slot="companion"]:not([hidden])').waitFor();

      const genericFonts = await page.evaluate(() => {
        const fixture = document.createElement("div");
        fixture.innerHTML = `<span class="chat-controls__model-option-action"><kbd>C</kbd></span>
          <span class="session-menu__shortcut">C</span>`;
        document.body.append(fixture);
        const fonts = Array.from(
          fixture.querySelectorAll("kbd, .session-menu__shortcut"),
          (key) => getComputedStyle(key).fontFamily,
        );
        fixture.remove();
        return {
          fonts,
          mono: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim(),
        };
      });
      expect(genericFonts.fonts).toEqual([genericFonts.mono, genericFonts.mono]);
    },
  );

  it.each([
    ["knot", "openknot", "#080808", "#f9f9fb"],
    ["dash", "dash", "#1a1210", "#f7f2ec"],
    ["absolutely", "absolutely", "#1c1c1a", "#faf9f5"],
    ["tide", "tide", "#10151b", "#f7f9fb"],
    ["beacon", "beacon", "#000000", "#ffffff"],
    ["phosphor", "phosphor", "#0a0f0a", "#f4f7f4"],
    ["crt", "crt", "#090a09", "#f5f5f4"],
    ["manuscript", "manuscript", "#211e18", "#f6f1e4"],
    ["rose", "rose", "#191724", "#faf4ed"],
    ["miami", "miami", "#140f1e", "#f7f3f6"],
  ])(
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
    await page.locator("openclaw-app-sidebar .sidebar-brand__new-thread").click();
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

    // Runtime removal renders nothing; restoration must rebind the existing router.
    const runtimeLifecycle = await page.locator("openclaw-app-shell").evaluate(async (element) => {
      const shell = element as HTMLElement & {
        runtime?: import("../app/bootstrap.ts").ApplicationRuntime;
        updateComplete: Promise<boolean>;
      };
      const runtime = shell.runtime;
      const color = () =>
        document.documentElement.style.getPropertyValue("--control-ui-system-chrome-background");
      try {
        shell.runtime = undefined;
        await shell.updateComplete;
        const removed = { color: color(), chat: Boolean(shell.querySelector(".shell--chat")) };
        shell.runtime = runtime;
        await shell.updateComplete;
        return {
          removed,
          restored: { color: color(), chat: Boolean(shell.querySelector(".shell--chat")) },
        };
      } finally {
        shell.runtime = runtime;
      }
    });
    expect(runtimeLifecycle).toEqual({
      removed: { color: pageColor, chat: false },
      restored: { color: chatColor, chat: true },
    });
    await expectChrome(chatColor);

    const reconnect = await page.locator("openclaw-app-shell").evaluate(async (element) => {
      const shell = element as HTMLElement & { updateComplete: Promise<boolean> };
      const parent = shell.parentNode!;
      const next = shell.nextSibling;
      const color = () =>
        document.documentElement.style.getPropertyValue("--control-ui-system-chrome-background");
      try {
        shell.remove();
        const removed = color();
        parent.insertBefore(shell, next);
        await shell.updateComplete;
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
    expect(reconnect).toEqual({ removed: pageColor, reconnected: chatColor, sameShell: true });
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
      const { pathname } = new URL(route.request().url());
      requested.push(pathname);
      await route.fulfill({ status: 404, body: "", contentType: "text/css" });
    });

    await page.goto(`${suite.server.baseUrl}${basePath.slice(1)}/chat`);
    await page
      .locator(".agent-chat__composer-combobox textarea")
      .waitFor({ state: "visible", timeout: 30_000 });

    const linkHref = await page.evaluate(
      () =>
        document.getElementById("openclaw-typeface-space-grotesk")?.getAttribute("href") ?? null,
    );

    const buildId = await page.locator("html").getAttribute("data-openclaw-control-ui-build-id");
    if (buildId !== null) {
      expect(buildId).not.toBe("");
    }
    const fontUrl = new URL(linkHref ?? "", suite.server.baseUrl);
    expect(fontUrl.pathname).toBe(`${basePath}/fonts/space-grotesk.css`);
    expect(fontUrl.searchParams.get("v")).toBe(buildId);
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
    // The browser must actually fetch below the mount, not at the root.
    await expect.poll(() => requested).toContain(`${basePath}/fonts/space-grotesk.css`);
  });
});
