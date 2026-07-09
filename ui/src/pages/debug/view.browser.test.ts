// Control UI browser tests cover the diagnostics table's responsive geometry.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../../test-helpers/control-ui-e2e.ts";

const VIEWPORTS = [
  [390, 844],
  [1440, 900],
] as const;

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowserLayout = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

type BrowserFixture = {
  context: BrowserContext;
  page: Page;
};

function readUiCss(): string {
  return ["ui/src/styles/base.css", "ui/src/styles/components.css"]
    .map((file) => readStyleSheet(file))
    .join("\n");
}

function diagnosticsTableHtml(): string {
  const rows = [
    ["Runtime", "Surface", "OpenClaw for macOS", "OK", "ok"],
    ["Display", "Viewport", "1,440 × 900", "OK", "ok"],
    [
      "Media",
      "Microphone inputs",
      "2 detected · Device enumeration does not confirm microphone permission or readability.",
      "Unknown",
      "unknown",
    ],
  ];
  return `
    <main>
      <section class="card debug-ui-diagnostics">
        <div class="row debug-ui-diagnostics__header">
          <div><div class="card-title">UI Diagnostics</div></div>
          <div class="debug-ui-diagnostics__actions"><button class="btn">Refresh diagnostics</button></div>
        </div>
        <div class="data-table-wrapper debug-ui-diagnostics__frame">
          <div class="data-table-container debug-ui-diagnostics__scroller">
            <table class="data-table debug-ui-diagnostics__table">
              <thead><tr><th>Area</th><th>Signal</th><th>Value</th><th>Status</th></tr></thead>
              <tbody>
                ${rows
                  .map(
                    ([area, signal, value, status, tone]) => `
                      <tr>
                        <td><span class="debug-ui-diagnostics__area">${area}</span></td>
                        <th class="debug-ui-diagnostics__signal" scope="row">${signal}</th>
                        <td><div class="debug-ui-diagnostics__value">${value}</div></td>
                        <td><span class="debug-ui-diagnostics__status debug-ui-diagnostics__status--${tone}">${status}</span></td>
                      </tr>`,
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>`;
}

async function openFixture(
  browser: Browser,
  width: number,
  height: number,
): Promise<BrowserFixture> {
  const context = await browser.newContext({ viewport: { width, height } });
  let page: Page | undefined;
  try {
    page = await context.newPage();
    await page.setContent(
      `<!doctype html><html><head><style>${readUiCss()} body { margin: 0; padding: 12px; }</style></head><body>${diagnosticsTableHtml()}</body></html>`,
    );
    return { context, page };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

describeBrowserLayout("debug diagnostics responsive layout", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
  });

  it.each(VIEWPORTS)("keeps every diagnostic row readable at %dx%d", async (width, height) => {
    const fixture = await openFixture(browser, width, height);
    try {
      const metrics = await fixture.page.evaluate(() => {
        const table = document.querySelector(".debug-ui-diagnostics__table");
        const firstRow = document.querySelector(".debug-ui-diagnostics__table tbody tr");
        const scroller = document.querySelector(".debug-ui-diagnostics__scroller");
        const cells = [...document.querySelectorAll(".debug-ui-diagnostics__table tbody tr > *")];
        if (
          !(table instanceof HTMLElement) ||
          !(firstRow instanceof HTMLElement) ||
          !(scroller instanceof HTMLElement)
        ) {
          throw new Error("Missing diagnostics table fixture elements");
        }
        const scrollerStyle = getComputedStyle(scroller);
        return {
          bodyOverflow: document.documentElement.scrollWidth - window.innerWidth,
          tableDisplay: getComputedStyle(table).display,
          rowDisplay: getComputedStyle(firstRow).display,
          scrollerMaxHeight: scrollerStyle.maxHeight,
          scrollerOverflow: scrollerStyle.overflow,
          cellsInsideViewport: cells.every((cell) => {
            const rect = cell.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= window.innerWidth;
          }),
        };
      });

      expect(metrics.bodyOverflow).toBeLessThanOrEqual(1);
      expect(metrics.cellsInsideViewport).toBe(true);
      expect(metrics.rowDisplay).toBe(width <= 560 ? "grid" : "table-row");
      expect(metrics.tableDisplay).toBe(width <= 560 ? "block" : "table");
      expect(metrics.scrollerMaxHeight).toBe(width <= 560 ? "none" : "468px");
      expect(metrics.scrollerOverflow).toBe(width <= 560 ? "visible" : "auto");
    } finally {
      await fixture.context.close().catch(() => {});
    }
  });
});
