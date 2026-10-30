import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import { withBrowserPage } from "../test-helpers/browser-page.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const describeBrowserLayout = chromiumAvailable ? describe : describe.skip;

let browser: Browser;
let desktopContext: BrowserContext;
let mobileContext: BrowserContext;

function readUiCss(): string {
  const files = [
    "base",
    "board",
    "layout",
    "layout.mobile",
    "components",
    "settings-controls",
    "settings",
    "agents",
    "config",
    "usage",
    "chat/startup-layout",
    "chat/layout",
    "chat/message-layout",
    "chat/composer-surface",
    "chat/composer",
    "sidebar-markdown",
    "chat/sidebar",
    "chat/sidebar-panels",
    "plugins",
  ];
  return files.map((file) => readStyleSheet(`ui/src/styles/${file}.css`)).join("\n");
}

function readStyles(
  page: Page,
  selectors: string[],
  property: "fontSize" | "cursor" | "display" | "userSelect" | "width" | "scrollbarWidth",
  pseudo?: string,
) {
  return page.evaluate(
    (options) =>
      options.selectors.map(
        (selector) =>
          getComputedStyle(document.querySelector(selector)!, options.pseudo)[options.property],
      ),
    { selectors, property, pseudo },
  );
}

function buttonAppearance(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      border: style.borderColor,
      color: style.color,
      shadow: style.boxShadow,
    };
  });
}

function controlsHtml() {
  return `
    <main>
      <label class="field"><input type="text" value="field input" /></label>
      <label class="field"><textarea>field textarea</textarea></label>
      <label class="field"><select><option>field select</option></select></label>
      <label class="field"><select class="settings-select"><option>field settings select</option></select></label>
      <label class="field checkbox"><input type="checkbox" /><span>field checkbox</span></label>
      <label class="field checkbox"><input type="radio" /><span>field radio</span></label>
      <input class="settings-sidebar__search-input" value="settings search" />
      <input class="settings-theme-import__input" value="theme" />
      <label class="config-raw-field"><textarea>raw config</textarea></label>
      <input class="settings-input" value="config input" />
      <div class="settings-row__control"><textarea class="settings-input">config textarea</textarea></div>
      <select class="settings-select"><option>settings select</option></select>
      <input class="usage-date-input" value="2026-05-31" />
      <select class="usage-select"><option>usage select</option></select>
      <input class="usage-query-input" value="usage query" />
      <div class="usage-filters-inline">
        <select><option>inline usage select</option></select>
        <input type="text" value="inline usage input" />
      </div>
      <div class="agent-chat__composer-combobox"><textarea>chat composer</textarea></div>
    </main>
  `;
}

function mediaDeviceRowsHtml() {
  const devices = [
    ["Microphone input", "MacBook Pro Microphone (Built-in)"],
    ["Camera", "System default"],
  ];
  return `<main style="width: 100%; max-width: 900px">${devices
    .map(
      ([label, option]) => `
    <div class="settings-row">
      <div class="settings-row__text"><span class="settings-row__title">${label}</span></div>
      <div class="settings-row__control">
        <select class="settings-select settings-select--media-device"><option>${option}</option></select>
        <button class="btn btn--sm btn--icon" type="button">↻</button>
      </div>
    </div>`,
    )
    .join("")}</main>`;
}

async function setFixture(page: Page, body: string, attributes = "", head = "") {
  await page.setContent(
    `<!doctype html><html ${attributes}><head>${head}<style>${readUiCss()}</style></head><body>${body}</body></html>`,
  );
}

beforeAll(async () => {
  if (!chromiumAvailable) {
    return;
  }
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  try {
    [desktopContext, mobileContext] = await Promise.all([
      browser.newContext(),
      browser.newContext({
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      }),
    ]);
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
});

afterAll(async () => {
  await Promise.all([
    desktopContext?.close().catch(() => {}),
    mobileContext?.close().catch(() => {}),
  ]);
  await browser?.close().catch(() => {});
});

describeBrowserLayout("form controls and app chrome styles", () => {
  it("removes the mask layer from layout when the value is revealed", async () => {
    await withBrowserPage(desktopContext.newPage(), async (page) => {
      await setFixture(
        page,
        `<span class="oc-sensitive-input" data-sensitive-input data-sensitive-mask-ready="true" data-revealed="true">
          <span class="oc-sensitive-mask" data-sensitive-mask hidden>
            <span data-sensitive-mask-text>*******************************</span>
          </span>
          <input type="text" value="fake-client-secret-for-ui-proof" />
          <button class="oc-sensitive-toggle" type="button" aria-label="Hide value">◎</button>
        </span>`,
        'data-theme-mode="light"',
      );

      const state = await page.locator("[data-sensitive-mask]").evaluate((mask) => ({
        hidden: (mask as HTMLElement).hidden,
        display: getComputedStyle(mask).display,
      }));
      expect(state).toEqual({ hidden: true, display: "none" });
    });
  });

  it("keeps MCP remove glyphs proportionate to settings buttons", async () => {
    await withBrowserPage(desktopContext.newPage(), async (page) => {
      await setFixture(
        page,
        `<div class="settings-row__control">
          <button class="btn btn--sm btn--icon mcp-server-remove" type="button" aria-label="Remove synthetic server">
            <svg viewBox="0 0 24 24"><path d="M3 6h18" /></svg>
          </button>
        </div>`,
        'data-theme-mode="light"',
      );

      const metrics = await page
        .getByRole("button", { name: "Remove synthetic server", exact: true })
        .evaluate((button) => {
          const glyph = button.querySelector("svg")!;
          const buttonRect = button.getBoundingClientRect();
          const glyphRect = glyph.getBoundingClientRect();
          return {
            button: [buttonRect.width, buttonRect.height],
            glyph: [glyphRect.width, glyphRect.height],
          };
        });
      expect(metrics).toEqual({ button: [32, 32], glyph: [18, 18] });
    });
  });

  it.each(["custom-light", "dark", "light"] as const)(
    "preserves action fill and foreground contrast on hover in %s mode",
    async (theme) => {
      const primary = theme === "custom-light";
      await withBrowserPage(desktopContext.newPage(), async (page) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await setFixture(
          page,
          `<main style="padding: 24px">
            <button class="btn" type="button">Cancel</button>
            <button class="btn ${primary ? "primary" : "danger"}" type="button">Action</button>
          </main>`,
          `data-theme="${theme}" data-theme-mode="${primary ? "light" : theme}"`,
          primary
            ? `<style>
            :root[data-theme="custom-light"] {
              --primary: #1e40af;
              --primary-hover: #1e3a8a;
              --primary-foreground: #ffffff;
              --accent: #d1fae5;
              --accent-hover: #a7f3d0;
            }
          </style>`
            : "",
        );
        const button = page.getByRole("button", { name: "Action", exact: true });
        const resting = await buttonAppearance(button);
        expect(resting.border).toBe("rgba(0, 0, 0, 0)");
        if (primary) {
          expect(resting).toMatchObject({
            background: "rgb(30, 64, 175)",
            color: "rgb(255, 255, 255)",
          });
        } else {
          const neutral = await buttonAppearance(
            page.getByRole("button", { name: "Cancel", exact: true }),
          );
          expect(resting.background).not.toBe("rgba(0, 0, 0, 0)");
          expect(resting.background).not.toBe(neutral.background);
          expect(resting.color).not.toBe(neutral.color);
        }
        await button.hover();
        const hovered = await buttonAppearance(button);
        expect(hovered.border).toBe(resting.border);
        expect(hovered.color).toBe(resting.color);
        if (primary) {
          expect(hovered.background).toBe("rgb(30, 58, 138)");
        } else {
          expect(hovered.background).not.toBe(resting.background);
        }
      });
    },
  );

  it.each(["dark", "light"] as const)(
    "keeps disabled buttons visually settled on hover and press in %s mode",
    async (theme) => {
      await withBrowserPage(desktopContext.newPage(), async (page) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await setFixture(
          page,
          `<main style="padding: 24px"><button class="btn" type="button">Action</button></main>`,
          `data-theme="${theme}" data-theme-mode="${theme}"`,
        );
        const button = page.getByRole("button", { name: "Action", exact: true });
        for (const variant of [
          "",
          "primary",
          "danger",
          "btn--icon",
          "btn--ghost",
          "btn--icon btn--ghost",
        ]) {
          for (const disabled of ["native", "aria"] as const) {
            await page.mouse.move(0, 0);
            await button.evaluate(
              (element, state) => {
                element.setAttribute("class", `btn ${state.variant}`);
                element.toggleAttribute("disabled", state.disabled === "native");
                element.setAttribute("aria-disabled", String(state.disabled === "aria"));
              },
              { variant, disabled },
            );
            const resting = await buttonAppearance(button);
            await button.hover();
            expect(
              await buttonAppearance(button),
              `${variant || "neutral"} ${disabled} hover`,
            ).toEqual(resting);
            await page.mouse.down();
            try {
              expect(
                await buttonAppearance(button),
                `${variant || "neutral"} ${disabled} press`,
              ).toEqual(resting);
            } finally {
              await page.mouse.up();
            }
          }
        }
        await page.mouse.move(0, 0);
        await button.evaluate((element) => {
          element.setAttribute("class", "btn");
          element.removeAttribute("disabled");
          element.removeAttribute("aria-disabled");
        });
        const enabled = await buttonAppearance(button);
        await button.hover();
        expect((await buttonAppearance(button)).background).not.toBe(enabled.background);
      });
    },
  );

  it.each([393, 768, 1200])("keeps long copy beside its tile at %ipx", async (width) => {
    await withBrowserPage(desktopContext.newPage(), async (page) => {
      await page.setViewportSize({ width, height: 1000 });
      const description =
        "Calendar notes and reminders remain readable before enabling a connector. ".repeat(8);
      await setFixture(
        page,
        `<main style="max-width: 1100px">
          <div class="settings-row plugins-item">
            <span class="plugins-tile" aria-hidden="true">C</span>
            <div class="settings-row__text"><span class="settings-row__title">Connector</span>
              <span class="settings-row__desc">${description}</span></div>
            <div class="settings-row__control"><button class="btn btn--sm">Disable</button>
              <button class="btn btn--sm btn--icon" aria-label="Remove connector">×</button></div>
            <div class="plugins-row-message" role="status">Connector remains disabled.</div>
          </div>
        </main>`,
        "",
        `<meta charset="utf-8">`,
      );
      const geometry = await page.locator(".settings-row").evaluate((row) => {
        const [tile, text, control, message] = Array.from(row.children, (child) =>
          child.getBoundingClientRect(),
        );
        if (!tile || !text || !control || !message) {
          throw new Error("Missing settings row fixture child");
        }
        const style = getComputedStyle(row);
        const contentWidth =
          row.clientWidth -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight);
        return {
          copyBesideTile:
            text.left >= tile.right && text.top < tile.bottom && tile.top < text.bottom,
          desktopControls:
            control.left >= text.right && control.top < text.bottom && text.top < control.bottom,
          narrowControls: control.top >= Math.max(tile.bottom, text.bottom),
          messageBelow: message.top >= Math.max(tile.bottom, text.bottom, control.bottom),
          messageWidth: message.width,
          contentWidth,
          overflow: row.scrollWidth - row.clientWidth,
        };
      });
      expect(geometry.copyBesideTile).toBe(true);
      expect(width <= 640 ? geometry.narrowControls : geometry.desktopControls).toBe(true);
      expect(geometry.messageBelow).toBe(true);
      expect(geometry.messageWidth).toBeCloseTo(geometry.contentWidth, 0);
      expect(geometry.overflow).toBeLessThanOrEqual(1);
    });
  });

  it("keeps paired selectors the same width across device labels and viewports", async () => {
    await withBrowserPage(desktopContext.newPage(), async (page) => {
      await page.setViewportSize({ width: 1200, height: 800 });
      await setFixture(page, mediaDeviceRowsHtml(), 'data-theme-mode="light"');

      const measure = () =>
        page.locator(".settings-row").evaluateAll((rows) =>
          rows.map((row) => {
            const select = row.querySelector<HTMLElement>(".settings-select--media-device")!;
            const button = row.querySelector<HTMLElement>(".btn--icon")!;
            const selectRect = select.getBoundingClientRect();
            const buttonRect = button.getBoundingClientRect();
            return {
              selectWidth: selectRect.width,
              selectTop: selectRect.top,
              buttonTop: buttonRect.top,
            };
          }),
        );

      const desktop = await measure();
      expect(desktop.map((row) => row.selectWidth)).toEqual([340, 340]);
      expect(desktop.every((row) => row.selectTop === row.buttonTop)).toBe(true);

      await page.setViewportSize({ width: 390, height: 800 });
      await page.locator("main").evaluate((main) => {
        main.style.width = "285px";
      });
      const mobile = await measure();
      expect(mobile[0]?.selectWidth).toBeCloseTo(mobile[1]?.selectWidth ?? 0, 5);
      expect(mobile[0]?.selectWidth).toBeLessThan(340);
      expect(mobile.every((row) => row.selectTop === row.buttonTop)).toBe(true);
    });
  });

  it("keeps mobile control sizes and themed select affordances", async () => {
    await withBrowserPage(mobileContext.newPage(), async (page) => {
      await setFixture(page, controlsHtml(), 'data-theme-mode="light"');
      const selectors = [
        ".field input",
        ".field textarea",
        ".field select",
        ".settings-sidebar__search-input",
        ".settings-theme-import__input",
        ".config-raw-field textarea",
        "input.settings-input",
        ".settings-row__control > textarea.settings-input",
        ".settings-select",
        ".usage-date-input",
        ".usage-select",
        ".usage-query-input",
        '.usage-filters-inline input[type="text"]',
        ".usage-filters-inline select",
        ".agent-chat__composer-combobox > textarea",
      ];
      expect(
        await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches),
      ).toBe(true);
      const sizes = await readStyles(page, selectors, "fontSize");
      sizes.forEach((size, index) =>
        expect(Number.parseFloat(size), selectors[index]).toBeGreaterThanOrEqual(16),
      );

      // Both the .field-wrapped and bare settings selects draw the themed
      // chevron; bare ones once fell back to the misaligned native arrow.
      const selects = await page.locator("select.settings-select").evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node as HTMLElement);
          return {
            appearance: style.appearance,
            image: style.backgroundImage,
            paddingRight: Number.parseFloat(style.paddingRight),
            positionX: style.backgroundPositionX.split(",").map((value) => value.trim()),
            size: style.backgroundSize.split(",").map((value) => value.trim()),
            repeat: style.backgroundRepeat.split(",").map((value) => value.trim()),
          };
        }),
      );

      expect(selects).toHaveLength(2);
      for (const select of selects) {
        expect(select).toMatchObject({
          appearance: "none",
          positionX: ["calc(100% - 18px)", "calc(100% - 14px)"],
          size: ["5px 5px", "5px 5px"],
          repeat: ["no-repeat", "no-repeat"],
        });
        expect(select.image.match(/linear-gradient[(]/g)).toHaveLength(2);
        expect(select.paddingRight).toBeGreaterThanOrEqual(32);
      }
      const [checkbox, radio, select, text] = await Promise.all(
        [
          '.field input[type="checkbox"]',
          '.field input[type="radio"]',
          ".field select",
          '.field input[type="text"]',
        ].map((selector) =>
          page
            .locator(selector)
            .first()
            .evaluate((node) => node.getBoundingClientRect().height),
        ),
      );
      expect([text, select]).toEqual([38, 38]);
      expect(checkbox).toBeLessThan(38);
      expect(radio).toBeLessThan(38);
    });
  });

  it("uses the arrow for recovery controls and the hand for its real link", async () => {
    await withBrowserPage(desktopContext.newPage(), async (page) => {
      await page.setContent(readStyleSheet("ui/index.html"));
      expect(
        await readStyles(
          page,
          [
            "#openclaw-mount-retry",
            "#openclaw-mount-wait",
            '.mount-fallback__panel a[href^="https://"]',
          ],
          "cursor",
        ),
      ).toEqual(["default", "default", "pointer"]);
    });
  });

  it.each(["desktop", "mobile"] as const)(
    "scales %s sidebar typography while preserving input sizes and bounded counts",
    async (mode) => {
      const mobile = mode === "mobile";
      await withBrowserPage((mobile ? mobileContext : desktopContext).newPage(), async (page) => {
        if (!mobile) {
          await page.setViewportSize({ width: 1200, height: 800 });
        }
        await setFixture(
          page,
          mobile
            ? `<div class="shell shell--mobile-nav">
              <span data-scale data-baseline="12" class="nav-item">Mobile navigation</span>
              <div class="file-view__search"><input data-scale data-baseline="16" data-scale-base="12" value="query" /></div>
              <input data-scale data-baseline="16" data-scale-base="12.5" class="settings-sidebar__search-input" value="settings" />
              <div class="sidebar-recent-session sidebar-recent-session--child">
                <span data-scale data-baseline="12" class="sidebar-recent-session__name">Child session</span>
                <span data-scale data-baseline="10" class="session-row-trail">3m</span>
              </div>
            </div>`
            : `<span data-scale class="nav-item__text">Navigation</span>
              <span data-scale class="sidebar-recent-session__name">Recent session</span>
              <span data-scale class="session-row-trail">3m</span>
              <div class="sidebar-session-catalog-host__head"><span class="sidebar-session-catalog-host__label">Local host</span><span data-scale class="sidebar-session-catalog-host__count">100</span></div>
              <button class="sidebar-session-catalog-project__head"><span class="sidebar-session-catalog-project__label">Project</span><span data-scale class="sidebar-session-catalog-project__count">100</span></button>
              <span data-scale class="sidebar-agent-card__name">Agent</span>
              <span data-scale class="settings-sidebar__item-label">Settings</span>
              <span data-scale class="sidebar-file-view__path">workspace/file.ts</span>
              <span data-scale class="chat-workspace-rail__file-badge">3 files</span>
              <span data-scale class="session-menu__shortcut">⌘K</span>
              <div class="file-view__search"><input data-scale data-baseline="12" value="query" /><span data-scale class="file-view__search-counter">1/2</span></div>
              <div class="sidebar-recent-session"><button class="sidebar-child-session-toggle"><span class="sidebar-child-session-toggle__count">100</span></button></div>
              <span data-scale class="file-view__save-notice">Unsaved changes</span>
              <article class="sidebar-markdown"><pre><code data-scale>const scaled = true;</code></pre></article>
              <article class="md-preview-dialog__reader sidebar-markdown"><h3 data-scale>Preview heading</h3><p data-scale>Agent file preview</p><table><tbody><tr><td data-scale>Preview cell</td></tr></tbody></table></article>`,
          "",
          mobile ? '<meta name="viewport" content="width=device-width, initial-scale=1.0" />' : "",
        );
        const readSizes = () =>
          page.locator("[data-scale]").evaluateAll((nodes) =>
            nodes.map((node) => ({
              label: node.getAttribute("class") || node.tagName,
              size: Number.parseFloat(getComputedStyle(node).fontSize),
              baseline: Number(node.getAttribute("data-baseline")) || undefined,
              scaleBase: Number(node.getAttribute("data-scale-base")) || undefined,
            })),
          );
        const baseline = await readSizes();
        if (mobile) {
          expect(
            await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches),
          ).toBe(true);
        }
        await page.evaluate(() => {
          document.documentElement.style.setProperty("--control-ui-text-scale", "1.4");
        });
        const scaled = await readSizes();
        expect(scaled).toHaveLength(mobile ? 5 : 17);
        baseline.forEach((initial, index) => {
          if (initial.baseline !== undefined) {
            expect(initial.size, initial.label).toBe(initial.baseline);
          }
          expect(scaled[index]?.size, initial.label).toBeCloseTo(
            (initial.scaleBase ?? initial.size) * 1.4,
            1,
          );
        });
        if (!mobile) {
          for (const selector of [
            ".sidebar-child-session-toggle",
            ".sidebar-session-catalog-host__count",
            ".sidebar-session-catalog-project__count",
          ]) {
            expect(
              await page.$eval(selector, (node) => node.scrollWidth <= node.clientWidth),
              selector,
            ).toBe(true);
          }
        }
      });
    },
  );

  it.each([
    { label: "merged chat chrome", nativeClass: "", merged: true, search: "visible" },
    { label: "topbar still shown", nativeClass: "", merged: false, search: "hidden" },
  ])(
    "shows the mobile drawer command palette button only where nothing else carries it ($label)",
    async ({ nativeClass, merged, search }) => {
      await withBrowserPage(mobileContext.newPage(), async (page) => {
        await setFixture(
          page,
          `<div class="shell shell--mobile-nav ${merged ? "shell--merged-chat-chrome" : ""}">
            <nav class="sidebar-rail">
              <button class="sidebar-rail__button sidebar-brand__desktop-control sidebar-brand__search"></button>
            </nav>
          </div>`,
          `class="${nativeClass}"`,
          `<meta name="viewport" content="width=device-width, initial-scale=1.0" />`,
        );

        const [display] = await readStyles(page, [".sidebar-brand__search"], "display");

        // Merged chat chrome hides the topbar, leaving the drawer as the only
        // surface that can carry search. Everywhere else - including every native
        // host, which never merges - the topbar keeps its own, so a drawer copy
        // would put two on screen at once.
        if (search === "visible") {
          expect(display).not.toBe("none");
        } else {
          expect(display).toBe("none");
        }
      });
    },
  );

  it("uses one canonical scrollbar width while preserving normal content scroll and text entry", async () => {
    await withBrowserPage(desktopContext.newPage(), async (page) => {
      await page.setViewportSize({ width: 1200, height: 800 });
      await setFixture(
        page,
        `<aside class="settings-sidebar">
          <nav class="settings-sidebar__nav">
            <span class="settings-sidebar__item-label">Settings row</span>
          </nav>
          <input class="settings-sidebar__search-input" value="editable settings search" />
        </aside>
        <aside class="sidebar">
          <div class="sidebar-shell__body">Recent session</div>
        </aside>
        <main class="content" style="height: 100px">
          <div class="settings-card">App chrome tile</div>
          <div style="height: 200px"></div>
        </main>
        <section class="chat-thread" style="height: 100px"><div class="chat-text">Selectable transcript</div></section>
        <div class="board-tabs__track">Hidden horizontal rail</div>`,
      );

      expect(
        await readStyles(
          page,
          [
            ".chat-thread",
            ".chat-text",
            ".settings-card",
            ".settings-sidebar__search-input",
            ".sidebar-shell__body",
            ".settings-sidebar__nav",
          ],
          "userSelect",
        ),
      ).toEqual(["none", "text", "auto", "text", "none", "none"]);
      expect(
        await readStyles(
          page,
          [".content", ".sidebar-shell__body", ".settings-sidebar__nav"],
          "width",
          "::-webkit-scrollbar",
        ),
      ).toEqual(["12px", "12px", "12px"]);
      // The board's hidden rail must override the blanket thin-scrollbar rule.
      expect(await readStyles(page, [".board-tabs__track"], "scrollbarWidth")).toEqual(["none"]);
    });
  });
});
