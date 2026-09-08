// Control UI tests cover form controls behavior.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { html, render, type TemplateResult } from "lit";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";
import { renderJsonTextarea } from "./config-form.node.json.ts";
import { renderNode } from "./config-form.node.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const describeBrowserLayout = chromiumAvailable ? describe : describe.skip;
// Use a Node path: Vite rewrites asset-shaped new URL() expressions.
const fontsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/fonts");

type ControlsFixture = {
  page: Page;
};

let browser: Browser;
let desktopContext: BrowserContext;
let mobileContext: BrowserContext;

function readUiCss(): string {
  const files = [
    "ui/src/styles/base.css",
    "ui/src/styles/board.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/layout.mobile.css",
    "ui/src/styles/components.css",
    "ui/src/styles/settings-controls.css",
    "ui/src/styles/settings.css",
    "ui/src/styles/config.css",
    "ui/src/styles/usage.css",
    "ui/src/styles/chat/layout.css",
    "ui/src/styles/chat/message-layout.css",
    "ui/src/styles/chat/composer.css",
    "ui/src/styles/sidebar-markdown.css",
    "ui/src/styles/chat/sidebar.css",
    "ui/src/styles/plugins.css",
  ];
  return files.map((file) => readStyleSheet(file)).join("\n");
}

function settingsControlsHtml(collectionItems: boolean): string {
  const common = {
    hints: {},
    unsupported: new Set<string>(),
    disabled: false,
    showLabel: !collectionItems,
    onPatch: () => {},
  };
  // Collection items use renderFieldRow's stacked, full-width layout.
  const controls = html`
    <div class="settings-group">
      ${renderNode({ ...common, schema: { type: "string", title: "Settings name" }, value: "config input", path: ["name"] })}
      ${renderJsonTextarea({ ...common, schema: { title: "Settings notes" }, value: "config textarea", path: ["notes"] })}
      ${renderNode({ ...common, schema: { type: "string", title: "Settings provider", enum: ["settings select", "Ag09 selected", "third", "fourth", "fifth", "sixth"] }, value: "settings select", path: ["provider"] })}
      <div class="settings-row settings-row--actions">
        <div class="settings-row__control">
          <button class="btn btn--sm" type="button">Save changes</button
          ><button class="btn btn--sm" type="button">Reset defaults</button
          ><button class="btn btn--sm" type="button">Cancel</button>
        </div>
      </div>
    </div>
  `;
  return renderedControlsHtml(controls);
}

function renderedControlsHtml(template: TemplateResult): string {
  const container = document.createElement("div");
  render(template, container);
  // This Node-driven layout suite transfers the real renderer's DOM/state,
  // not its event handlers. Renderer interaction tests cover those separately.
  for (const input of container.querySelectorAll("input")) {
    input.setAttribute("value", input.value);
  }
  for (const textarea of container.querySelectorAll("textarea")) {
    textarea.textContent = textarea.value;
  }
  for (const option of container.querySelectorAll("option")) {
    option.toggleAttribute("selected", option.selected);
  }
  return container.innerHTML;
}

function controlsHtml(collectionItems = false) {
  return `
    <main>
      <label class="field"><span>Display name</span><input type="text" value="field input" /></label>
      <label class="field"><span>Notes</span><textarea>field textarea</textarea></label>
      <label class="field"><span>Mode</span><select><option>field select</option><option>Ag09 selected</option></select></label>
      <label class="field"><span>Provider</span><select class="settings-select"><option>field settings select</option><option>Ag09 selected</option></select></label>
      <label class="field checkbox"><input type="checkbox" /><span>field checkbox</span></label>
      <label class="field checkbox"><input type="radio" /><span>field radio</span></label>
      <input class="settings-sidebar__search-input" value="settings search" />
      <input class="settings-theme-import__input" value="theme" />
      <label class="config-raw-field"><textarea>raw config</textarea></label>
      <section class="shell--settings ${collectionItems ? "settings-stack" : ""}">
        ${settingsControlsHtml(collectionItems)}
      </section>
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

function revealedSensitiveInputHtml() {
  return `
    <span
      class="oc-sensitive-input"
      data-sensitive-input
      data-sensitive-mask-ready="true"
      data-revealed="true"
    >
      <span class="oc-sensitive-mask" data-sensitive-mask hidden>
        <span data-sensitive-mask-text>*******************************</span>
      </span>
      <input type="text" value="fake-client-secret-for-ui-proof" />
      <button class="oc-sensitive-toggle" type="button" aria-label="Hide value">◎</button>
    </span>
  `;
}

function mediaDeviceRowsHtml() {
  return `
    <main style="width: 100%; max-width: 900px">
      <div class="settings-row">
        <div class="settings-row__text"><span class="settings-row__title">Microphone input</span></div>
        <div class="settings-row__control">
          <select class="settings-select settings-select--media-device">
            <option>MacBook Pro Microphone (Built-in)</option>
          </select>
          <button class="btn btn--sm btn--icon" type="button">↻</button>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row__text"><span class="settings-row__title">Camera</span></div>
        <div class="settings-row__control">
          <select class="settings-select settings-select--media-device">
            <option>System default</option>
          </select>
          <button class="btn btn--sm btn--icon" type="button">↻</button>
        </div>
      </div>
    </main>
  `;
}

async function openControlsFixture(
  options: {
    mobile: boolean;
    width: number;
    paneWidth: number;
    theme: "light" | "dark";
    collectionItems?: boolean;
  } = {
    mobile: true,
    width: 390,
    paneWidth: 390,
    theme: "light",
  },
): Promise<ControlsFixture> {
  let page: Page | undefined;
  try {
    page = await (options.mobile ? mobileContext : desktopContext).newPage();
    await page.setViewportSize({ width: options.width, height: 844 });
    await page.emulateMedia({ colorScheme: options.theme, reducedMotion: "reduce" });
    // Match typography.ts: Claw UI uses Instrument Sans; editors use JetBrains
    // Mono. Serve only these checked-in public assets, without a live Gateway.
    await page.route("https://form-controls.test/fonts/*", (route) => {
      const asset = path.posix.basename(new URL(route.request().url()).pathname);
      return route.fulfill({ path: path.join(fontsRoot, asset) });
    });
    await page.setContent(
      `<!doctype html><html data-theme-mode="${options.theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="https://form-controls.test/fonts/instrument-sans.css" /><link rel="stylesheet" href="https://form-controls.test/fonts/jetbrains-mono.css" /><style>${readUiCss()}</style></head><body>${controlsHtml(options.collectionItems ?? false)}</body></html>`,
    );
    // The fixture models a scrollable pane, not the app shell or its routing.
    await page.locator("main").evaluate((main, width) => {
      main.style.width = `${width}px`;
      main.style.height = "100dvh";
      main.style.overflow = "auto";
    }, options.paneWidth);
    await page.evaluate(() => document.fonts.ready);
    const loadedFamilies = await page.evaluate(() =>
      Array.from(document.fonts)
        .filter((font) => font.status === "loaded")
        .map((font) => font.family.replaceAll('"', "")),
    );
    expect(loadedFamilies).toEqual(expect.arrayContaining(["Instrument Sans", "JetBrains Mono"]));
    return { page };
  } catch (error) {
    await page?.close().catch(() => {});
    throw error;
  }
}

async function closeControlsFixture(fixture: ControlsFixture): Promise<void> {
  await fixture.page.close().catch(() => {});
}

async function assertFormCopyAndActionsFit(page: Page, collectionItems: boolean): Promise<void> {
  const geometry = await page.evaluate(() => {
    const contentBox = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        left: rect.left + node.clientLeft + Number.parseFloat(style.paddingLeft),
        right:
          rect.left + node.clientLeft + node.clientWidth - Number.parseFloat(style.paddingRight),
        top: rect.top + node.clientTop + Number.parseFloat(style.paddingTop),
        bottom:
          rect.top + node.clientTop + node.clientHeight - Number.parseFloat(style.paddingBottom),
      };
    };
    const inside = (inner: DOMRect, outer: ReturnType<typeof contentBox>) =>
      inner.width > 0 &&
      inner.height > 0 &&
      inner.left >= outer.left - 1 &&
      inner.right <= outer.right + 1 &&
      inner.top >= outer.top - 1 &&
      inner.bottom <= outer.bottom + 1;
    const overlaps = (a: DOMRect, b: DOMRect) =>
      a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const copy = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".field > span, .settings-row__title, .settings-row__control > button",
      ),
      (node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const lines = Array.from(range.getClientRects());
        return {
          label: node.textContent,
          fits: lines.length > 0 && lines.every((line) => inside(line, contentBox(node))),
        };
      },
    );
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".field:not(.checkbox), .settings-row:not(.settings-row--actions)",
      ),
      (row) => {
        const label = row.querySelector<HTMLElement>(":scope > span, :scope > .settings-row__text");
        const control = row.querySelector<HTMLElement>("input, textarea, select");
        if (!control) {
          throw new Error("Missing labeled control fixture");
        }
        return {
          label: label?.textContent ?? control.getAttribute("aria-label"),
          fits: inside(control.getBoundingClientRect(), contentBox(row)),
          overlap: label
            ? overlaps(label.getBoundingClientRect(), control.getBoundingClientRect())
            : false,
        };
      },
    );
    const cluster = document.querySelector<HTMLElement>(
      ".settings-row--actions .settings-row__control",
    );
    if (!cluster) {
      throw new Error("Missing action cluster");
    }
    const buttons = Array.from(cluster.children, (node) => node.getBoundingClientRect());
    return {
      copy,
      rows,
      buttonCount: buttons.length,
      clusterFits: buttons.every((button) => inside(button, contentBox(cluster))),
      overlap: buttons.some((button, index) =>
        buttons.slice(index + 1).some((other) => overlaps(button, other)),
      ),
    };
  });
  expect(geometry.copy).toHaveLength(collectionItems ? 9 : 12);
  for (const copy of geometry.copy) {
    expect(copy.fits, copy.label ?? "missing label").toBe(true);
  }
  expect(geometry.rows).toHaveLength(7);
  for (const row of geometry.rows) {
    expect(row.fits, row.label ?? "missing row label").toBe(true);
    expect(row.overlap, row.label ?? "missing row label").toBe(false);
  }
  expect(geometry.buttonCount).toBe(3);
  expect(geometry.clusterFits).toBe(true);
  expect(geometry.overlap).toBe(false);
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

describeBrowserLayout("sensitive input visibility", () => {
  it("removes the mask layer from layout when the value is revealed", async () => {
    const page = await desktopContext.newPage();
    try {
      await page.setContent(
        `<!doctype html><html data-theme-mode="light"><head><style>${readUiCss()}</style></head><body>${revealedSensitiveInputHtml()}</body></html>`,
      );

      const state = await page.locator("[data-sensitive-mask]").evaluate((mask) => ({
        hidden: (mask as HTMLElement).hidden,
        display: getComputedStyle(mask).display,
      }));
      expect(state).toEqual({ hidden: true, display: "none" });
    } finally {
      await page.close().catch(() => {});
    }
  });
});

describeBrowserLayout("settings icon buttons", () => {
  it("keeps plugin and MCP remove glyphs proportionate to settings buttons", async () => {
    const page = await desktopContext.newPage();
    try {
      await page.setContent(`
        <!doctype html>
        <html data-theme-mode="light">
          <head><style>${readUiCss()}</style></head>
          <body>
            <div class="settings-row__control">
              <button class="btn btn--sm btn--icon plugins-remove" type="button">
                <svg viewBox="0 0 24 24"><path d="M3 6h18" /></svg>
              </button>
            </div>
          </body>
        </html>
      `);

      const metrics = await page.locator(".plugins-remove").evaluate((button) => {
        const glyph = button.querySelector("svg");
        if (!(glyph instanceof SVGElement)) {
          throw new Error("Missing remove button glyph");
        }
        const buttonRect = button.getBoundingClientRect();
        const glyphRect = glyph.getBoundingClientRect();
        return {
          button: [buttonRect.width, buttonRect.height],
          glyph: [glyphRect.width, glyphRect.height],
        };
      });
      expect(metrics).toEqual({ button: [32, 32], glyph: [18, 18] });
    } finally {
      await page.close().catch(() => {});
    }
  });
});

describeBrowserLayout("settings row wrapping", () => {
  it.each([393, 768, 1200])("keeps long copy beside its tile at %ipx", async (width) => {
    const page = await desktopContext.newPage();
    try {
      await page.setViewportSize({ width, height: 1000 });
      const description =
        "Calendar notes and reminders remain readable before enabling a connector. ".repeat(8);
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${readUiCss()}</style></head>
        <body><main style="max-width: 1100px">
          <div class="settings-row plugins-item">
            <span class="plugins-tile" aria-hidden="true">C</span>
            <div class="settings-row__text"><span class="settings-row__title">Connector</span>
              <span class="settings-row__desc">${description}</span></div>
            <div class="settings-row__control"><button class="btn btn--sm">Disable</button>
              <button class="btn btn--sm btn--icon" aria-label="Remove connector">×</button></div>
            <div class="plugins-row-message" role="status">Connector remains disabled.</div>
          </div>
        </main></body></html>`);
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
    } finally {
      await page.close().catch(() => {});
    }
  });
});

describeBrowserLayout("settings media device controls", () => {
  it("keeps paired selectors the same width across device labels and viewports", async () => {
    const page = await desktopContext.newPage();
    try {
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.setContent(
        `<!doctype html><html data-theme-mode="light"><head><style>${readUiCss()}</style></head><body>${mediaDeviceRowsHtml()}</body></html>`,
      );

      const measure = () =>
        page.locator(".settings-row").evaluateAll((rows) =>
          rows.map((row) => {
            const select = row.querySelector(".settings-select--media-device");
            const button = row.querySelector(".btn--icon");
            if (!(select instanceof HTMLElement) || !(button instanceof HTMLElement)) {
              throw new Error("Missing media device controls");
            }
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
    } finally {
      await page.close().catch(() => {});
    }
  });
});

describeBrowserLayout("form control sizing", () => {
  it("keeps text-entry controls large enough to avoid mobile focus zoom", async () => {
    const fixture = await openControlsFixture();
    const { page } = fixture;
    try {
      const metrics = await page.evaluate(() => {
        const selectors = [
          ".field input",
          ".field textarea",
          ".field select",
          ".settings-sidebar__search-input",
          ".settings-theme-import__input",
          ".config-raw-field textarea",
          "input.settings-input",
          ".settings-row__control textarea.settings-input",
          ".settings-select",
          ".usage-date-input",
          ".usage-select",
          ".usage-query-input",
          '.usage-filters-inline input[type="text"]',
          ".usage-filters-inline select",
          ".agent-chat__composer-combobox > textarea",
        ];
        return {
          touchPrimary: matchMedia("(hover: none) and (pointer: coarse)").matches,
          sizes: selectors.map((selector) => {
            const node = document.querySelector(selector);
            if (!(node instanceof HTMLElement)) {
              throw new Error(`Missing control ${selector}`);
            }
            return {
              selector,
              fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
            };
          }),
        };
      });

      expect(metrics.touchPrimary).toBe(true);
      for (const size of metrics.sizes) {
        expect(size.fontSize, size.selector).toBeGreaterThanOrEqual(16);
      }
    } finally {
      await closeControlsFixture(fixture);
    }
  });

  it.each(
    [
      { mobile: false, width: 1200, paneWidth: 720, collectionItems: false },
      { mobile: false, width: 1200, paneWidth: 285, collectionItems: true },
      { mobile: true, width: 390, paneWidth: 285, collectionItems: false },
      { mobile: true, width: 320, paneWidth: 320, collectionItems: false },
    ].flatMap(({ mobile, width, paneWidth, collectionItems }) =>
      (["light", "dark"] as const).map((theme) => ({
        mobile,
        width,
        paneWidth,
        collectionItems,
        theme,
      })),
    ),
  )(
    "fits control interiors at 100% and 140%: $width/$paneWidth px, touch=$mobile, collection=$collectionItems, $theme",
    async (options) => {
      const fixture = await openControlsFixture(options);
      const { page } = fixture;
      try {
        const controlSelector =
          '.field input[type="text"], .field textarea, .field select, .shell--settings input, .shell--settings textarea, .shell--settings select';
        const controls = page.locator(controlSelector);
        expect(await controls.count()).toBe(7);
        const defaults = await controls.evaluateAll((nodes) =>
          nodes.map((node) => {
            if (
              !(
                node instanceof HTMLInputElement ||
                node instanceof HTMLTextAreaElement ||
                node instanceof HTMLSelectElement
              )
            ) {
              throw new Error("Missing native form control");
            }
            return node.value;
          }),
        );
        const initialEnvironment = await page.evaluate(() => ({
          width: window.innerWidth,
          coarse: matchMedia("(pointer: coarse)").matches,
          scale: getComputedStyle(document.documentElement)
            .getPropertyValue("--control-ui-text-scale")
            .trim(),
        }));
        expect(initialEnvironment).toEqual({
          width: options.width,
          coarse: options.mobile,
          scale: "1",
        });

        for (const scale of [1, 1.4]) {
          await page.evaluate((value) => {
            document.documentElement.style.setProperty("--control-ui-text-scale", String(value));
          }, scale);
          for (const state of ["default", "edited"] as const) {
            for (let index = 0; index < defaults.length; index++) {
              const control = controls.nth(index);
              const tag = await control.evaluate((node) => node.tagName);
              const value =
                state === "default"
                  ? defaults[index]!
                  : tag === "SELECT"
                    ? "Ag09 selected"
                    : tag === "TEXTAREA"
                      ? "Ag09\npq78"
                      : "Ag09 typed";
              if (tag === "SELECT") {
                if (state === "default") {
                  await control.selectOption(value);
                } else {
                  await control.selectOption({ label: value });
                }
              } else {
                await control.fill(value);
              }
            }
            const metrics = await controls.evaluateAll((nodes) => {
              const canvas = document.createElement("canvas");
              const context = canvas.getContext("2d");
              if (!context) {
                throw new Error("Canvas text metrics unavailable");
              }
              return nodes.map((node) => {
                if (
                  !(
                    node instanceof HTMLInputElement ||
                    node instanceof HTMLTextAreaElement ||
                    node instanceof HTMLSelectElement
                  )
                ) {
                  throw new Error("Missing native form control");
                }
                const style = getComputedStyle(node);
                const px = (value: string) => Number.parseFloat(value);
                const rect = node.getBoundingClientRect();
                const value =
                  node instanceof HTMLSelectElement ? node.selectedOptions[0]!.text : node.value;
                // Native value glyphs have no DOM Range. Measure their ink budget
                // with the control font, not just the outside box. This does not
                // certify the browser's internal baseline placement or rasterization.
                context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
                context.letterSpacing = style.letterSpacing;
                const lines = value.split("\n").map((line) => context.measureText(line));
                const inkHeight = Math.max(
                  ...lines.map(
                    (line) => line.actualBoundingBoxAscent + line.actualBoundingBoxDescent,
                  ),
                );
                const lineHeight = px(style.lineHeight);
                return {
                  label: node.getAttribute("aria-label") ?? node.className + " " + node.tagName,
                  value,
                  fontSize: px(style.fontSize),
                  height: rect.height,
                  // client dimensions exclude borders and any scrollbar, but still include padding.
                  innerWidth: node.clientWidth - px(style.paddingLeft) - px(style.paddingRight),
                  innerHeight: node.clientHeight - px(style.paddingTop) - px(style.paddingBottom),
                  inkWidth: Math.max(
                    ...lines.map((line) =>
                      Math.max(
                        line.width,
                        line.actualBoundingBoxLeft + line.actualBoundingBoxRight,
                      ),
                    ),
                  ),
                  inkHeight:
                    lines.length > 1 ? inkHeight + (lines.length - 1) * lineHeight : inkHeight,
                  horizontalScroll: node.scrollWidth - node.clientWidth,
                  verticalScroll:
                    node instanceof HTMLTextAreaElement ? node.scrollHeight - node.clientHeight : 0,
                  settings: node.matches(".settings-input, .settings-select"),
                  settingsShell: Boolean(node.closest(".shell--settings")),
                  multiline: node instanceof HTMLTextAreaElement,
                  chevron:
                    node instanceof HTMLSelectElement
                      ? {
                          appearance: style.appearance,
                          image: style.backgroundImage,
                          paddingRight: px(style.paddingRight),
                          positionX: style.backgroundPositionX,
                          repeat: style.backgroundRepeat,
                        }
                      : null,
                };
              });
            });
            for (const metric of metrics) {
              const label = JSON.stringify({ scale, state, ...metric });
              expect(metric.inkWidth, label).toBeGreaterThan(0);
              expect(metric.inkHeight, label).toBeGreaterThan(0);
              // Full-width fit is for these bounded samples, not arbitrary
              // user/device strings: native selects may truncate long labels.
              expect(metric.inkWidth, label).toBeLessThanOrEqual(metric.innerWidth + 1);
              expect(metric.inkHeight, label).toBeLessThanOrEqual(metric.innerHeight + 1);
              expect(metric.horizontalScroll, label).toBeLessThanOrEqual(1);
              expect(metric.verticalScroll, label).toBeLessThanOrEqual(1);
              if (options.mobile) {
                expect(metric.fontSize, label).toBeGreaterThanOrEqual(16);
              }
              if (scale === 1 && !metric.multiline) {
                expect(metric.height, label).toBe(
                  metric.settings ? (metric.settingsShell && options.mobile ? 44 : 32) : 38,
                );
              }
              if (metric.chevron) {
                expect(metric.chevron.appearance, label).toBe("none");
                expect(metric.chevron.image, label).not.toBe("none");
                // The 16px themed glyph sits 10px from the right; its reserved
                // padding is excluded from the value's available width above.
                expect(metric.chevron.paddingRight, label).toBeGreaterThanOrEqual(32);
                expect(metric.height, label).toBeGreaterThanOrEqual(16);
                expect(metric.chevron.positionX, label).toBe("calc(100% - 10px)");
                expect(metric.chevron.repeat, label).toContain("no-repeat");
              }
            }
            // Prove the scale stimulus reaches a canonical scalable control, rather
            // than accepting unchanged geometry after a misspelled CSS variable.
            expect(
              metrics.find((metric) => metric.label === "Settings name")?.fontSize,
            ).toBeCloseTo(Math.max(16, 14 * scale), 1);
            await assertFormCopyAndActionsFit(page, options.collectionItems);
          }
        }
        const dimensions = await page
          .locator('.field input[type="checkbox"], .field input[type="radio"]')
          .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
        expect(dimensions).toHaveLength(2);
        for (const height of dimensions) {
          expect(height).toBeLessThan(38);
        }
      } finally {
        await closeControlsFixture(fixture);
      }
    },
  );
});

describeBrowserLayout("mount fallback cursor", () => {
  it("uses the arrow for recovery controls and the hand for its real link", async () => {
    const page = await desktopContext.newPage();
    try {
      await page.setContent(readStyleSheet("ui/index.html"));
      const cursors = await page.evaluate(() => {
        const cursor = (selector: string) => {
          const node = document.querySelector(selector);
          if (!(node instanceof HTMLElement)) {
            throw new Error(`Missing cursor fixture ${selector}`);
          }
          return getComputedStyle(node).cursor;
        };
        return {
          retry: cursor("#openclaw-mount-retry"),
          wait: cursor("#openclaw-mount-wait"),
          docs: cursor('.mount-fallback__panel a[href^="https://"]'),
        };
      });

      expect(cursors).toEqual({
        retry: "default",
        wait: "default",
        docs: "pointer",
      });
    } finally {
      await page.close().catch(() => {});
    }
  });
});

describeBrowserLayout("app chrome interaction styles", () => {
  it("scales sidebar typography with the Control UI text-size preference", async () => {
    const page = await desktopContext.newPage();
    try {
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.setContent(`
        <!doctype html>
        <html>
          <head><style>${readUiCss()}</style></head>
          <body>
            <span class="nav-item__text">Navigation</span>
            <span class="sidebar-recent-session__name">Recent session</span>
            <span class="session-row-trail">3m</span>
            <div class="sidebar-session-catalog-host__head">
              <span class="sidebar-session-catalog-host__label">Local host</span>
              <span class="sidebar-session-catalog-host__count">100</span>
            </div>
            <button class="sidebar-session-catalog-project__head">
              <span class="sidebar-session-catalog-project__label">Project</span>
              <span class="sidebar-session-catalog-project__count">100</span>
            </button>
            <span class="sidebar-agent-card__name">Agent</span>
            <span class="settings-sidebar__item-label">Settings</span>
            <span class="sidebar-file-view__path">workspace/file.ts</span>
            <span class="chat-workspace-rail__file-badge">3 files</span>
            <span class="session-menu__shortcut">⌘K</span>
            <div class="file-view__search">
              <input value="query" />
              <span class="file-view__search-counter">1/2</span>
            </div>
            <div class="sidebar-recent-session">
              <button class="sidebar-child-session-toggle">
                <span class="sidebar-child-session-toggle__count">100</span>
              </button>
            </div>
            <span class="file-view__save-notice">Unsaved changes</span>
            <article class="sidebar-markdown"><pre><code>const scaled = true;</code></pre></article>
            <article class="md-preview-dialog__reader sidebar-markdown">
              <h3>Preview heading</h3>
              <p>Agent file preview</p>
              <table><tbody><tr><td>Preview cell</td></tr></tbody></table>
            </article>
          </body>
        </html>
      `);

      const selectors = [
        ".nav-item__text",
        ".sidebar-recent-session__name",
        ".session-row-trail",
        ".sidebar-session-catalog-host__count",
        ".sidebar-session-catalog-project__count",
        ".sidebar-agent-card__name",
        ".settings-sidebar__item-label",
        ".sidebar-file-view__path",
        ".chat-workspace-rail__file-badge",
        ".session-menu__shortcut",
        ".file-view__search-counter",
        ".file-view__save-notice",
        ".sidebar-markdown pre code",
        ".md-preview-dialog__reader.sidebar-markdown > p",
        ".md-preview-dialog__reader.sidebar-markdown > h3",
        ".md-preview-dialog__reader.sidebar-markdown td",
      ];
      const readFontSizes = () =>
        page.evaluate((targets) => {
          return Object.fromEntries(
            targets.map((selector) => {
              const node = document.querySelector(selector);
              if (!(node instanceof HTMLElement)) {
                throw new Error(`Missing sidebar typography fixture ${selector}`);
              }
              return [selector, Number.parseFloat(getComputedStyle(node).fontSize)];
            }),
          );
        }, selectors);

      const baseline = await readFontSizes();
      const baselineInput = await page.$eval(".file-view__search input", (node) =>
        Number.parseFloat(getComputedStyle(node).fontSize),
      );
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--control-ui-text-scale", "1.4");
      });
      const scaled = await readFontSizes();
      const scaledInput = await page.$eval(".file-view__search input", (node) =>
        Number.parseFloat(getComputedStyle(node).fontSize),
      );

      for (const selector of selectors) {
        const baselineSize = baseline[selector];
        const scaledSize = scaled[selector];
        if (baselineSize === undefined || scaledSize === undefined) {
          throw new Error(`Missing computed sidebar font size for ${selector}`);
        }
        expect(scaledSize, selector).toBeCloseTo(baselineSize * 1.4, 1);
      }
      expect(baselineInput).toBe(12);
      expect(scaledInput).toBeCloseTo(12 * 1.4, 1);
      for (const selector of [
        ".sidebar-child-session-toggle",
        ".sidebar-session-catalog-host__count",
        ".sidebar-session-catalog-project__count",
      ]) {
        const fits = await page.$eval(selector, (node) => node.scrollWidth <= node.clientWidth);
        expect(fits, selector).toBe(true);
      }
    } finally {
      await page.close().catch(() => {});
    }
  });

  it("scales mobile sidebar variants while preserving the coarse-pointer input floor", async () => {
    const page = await mobileContext.newPage();
    try {
      await page.setContent(`
        <!doctype html>
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <style>${readUiCss()}</style>
          </head>
          <body>
            <div class="shell shell--mobile-nav">
              <span class="nav-item">Mobile navigation</span>
              <div class="file-view__search"><input value="query" /></div>
              <input class="settings-sidebar__search-input" value="settings" />
              <div class="sidebar-recent-session sidebar-recent-session--child">
                <span class="sidebar-recent-session__name">Child session</span>
                <span class="session-row-trail">3m</span>
              </div>
            </div>
          </body>
        </html>
      `);

      const readSizes = () =>
        page.evaluate(() => {
          const fontSize = (selector: string) => {
            const node = document.querySelector(selector);
            if (!(node instanceof HTMLElement)) {
              throw new Error(`Missing mobile sidebar fixture ${selector}`);
            }
            return Number.parseFloat(getComputedStyle(node).fontSize);
          };
          return {
            childName: fontSize(".sidebar-recent-session--child .sidebar-recent-session__name"),
            childTrail: fontSize(".sidebar-recent-session--child .session-row-trail"),
            coarsePointer: matchMedia("(hover: none) and (pointer: coarse)").matches,
            fileSearch: fontSize(".file-view__search input"),
            settingsSearch: fontSize(".settings-sidebar__search-input"),
            navItem: fontSize(".shell--mobile-nav .nav-item"),
          };
        });

      const baseline = await readSizes();
      expect(baseline).toMatchObject({
        childName: 12,
        childTrail: 10,
        coarsePointer: true,
        fileSearch: 16,
        settingsSearch: 16,
        navItem: 12,
      });

      await page.evaluate(() => {
        document.documentElement.style.setProperty("--control-ui-text-scale", "1.4");
      });
      const scaled = await readSizes();
      expect(scaled.childName).toBeCloseTo(12 * 1.4, 1);
      expect(scaled.childTrail).toBeCloseTo(10 * 1.4, 1);
      expect(scaled.fileSearch).toBeCloseTo(12 * 1.4, 1);
      expect(scaled.settingsSearch).toBeCloseTo(12.5 * 1.4, 1);
      expect(scaled.navItem).toBeCloseTo(12 * 1.4, 1);
    } finally {
      await page.close().catch(() => {});
    }
  });

  it("uses one canonical scrollbar width while preserving normal content scroll and text entry", async () => {
    const page = await desktopContext.newPage();
    try {
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.setContent(`
        <!doctype html>
        <html>
          <head><style>${readUiCss()}</style></head>
          <body>
            <aside class="settings-sidebar">
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
            <section class="chat-thread" style="height: 100px">Selectable transcript</section>
            <div class="board-tabs__track">Hidden horizontal rail</div>
          </body>
        </html>
      `);

      const metrics = await page.evaluate(() => {
        const style = (selector: string) => {
          const node = document.querySelector(selector);
          if (!(node instanceof HTMLElement)) {
            throw new Error(`Missing interaction fixture ${selector}`);
          }
          return getComputedStyle(node);
        };
        const scrollbarWidth = (selector: string) => {
          const node = document.querySelector(selector);
          if (!(node instanceof HTMLElement)) {
            throw new Error(`Missing scrollbar fixture ${selector}`);
          }
          return getComputedStyle(node, "::-webkit-scrollbar").width;
        };
        return {
          chatSelection: style(".chat-thread").userSelect,
          chromeSelection: style(".settings-card").userSelect,
          contentScrollbar: scrollbarWidth(".content"),
          inputSelection: style(".settings-sidebar__search-input").userSelect,
          regularSidebarScrollbar: scrollbarWidth(".sidebar-shell__body"),
          regularSidebarSelection: style(".sidebar-shell__body").userSelect,
          settingsSidebarScrollbar: scrollbarWidth(".settings-sidebar__nav"),
          settingsSidebarSelection: style(".settings-sidebar__nav").userSelect,
          // The board tab rail intentionally hides its scrollbar (a drag/wheel
          // affordance, not a styling variant); the new blanket
          // `* { scrollbar-width: thin }` rule in base.css must not win over
          // its higher-specificity `scrollbar-width: none`.
          hiddenRailScrollbarWidth: style(".board-tabs__track").scrollbarWidth,
        };
      });

      expect(metrics).toEqual({
        chatSelection: "text",
        chromeSelection: "auto",
        contentScrollbar: "12px",
        hiddenRailScrollbarWidth: "none",
        inputSelection: "text",
        regularSidebarScrollbar: "12px",
        regularSidebarSelection: "none",
        settingsSidebarScrollbar: "12px",
        settingsSidebarSelection: "none",
      });
    } finally {
      await page.close().catch(() => {});
    }
  });
});
