// Control UI tests cover hover-marquee behavior with real text layout.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowserLayout = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

type BrowserFixture = {
  browser: Browser;
  page: Page;
};

// Transpile the real dependency-free module so the page exercises production
// code, not a copy. esbuild's API is unusable under the jsdom test environment.
function bundleHoverMarquee(): string {
  const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
  const source = readFileSync(path.resolve(import.meta.dirname, "hover-marquee.ts"), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `window.HoverMarquee = (() => { const exports = {}; ${transpiled}; return exports; })();`;
}

function rowHtml(label: string) {
  return `
    <div class="sidebar-recent-session session-row-host" style="width: 200px">
      <a class="sidebar-recent-session__link" href="#">
        <span class="sidebar-recent-session__name hover-marquee">${label}</span>
      </a>
    </div>
  `;
}

async function openRowFixture(label: string): Promise<BrowserFixture> {
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  let page: Page | undefined;
  try {
    page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    const css = [
      "ui/src/styles/base.css",
      "ui/src/styles/layout.css",
      "ui/src/styles/components.css",
    ]
      .map((file) => readStyleSheet(file))
      .join("\n");
    await page.setContent(`<style>${css}</style>${rowHtml(label)}`);
    await page.addScriptTag({ content: bundleHoverMarquee() });
    await page.evaluate(() => {
      const marquee = (
        window as unknown as {
          HoverMarquee: {
            startHoverMarquee: (host: HTMLElement) => void;
            stopHoverMarquee: (host: HTMLElement) => void;
          };
        }
      ).HoverMarquee;
      const row = document.querySelector<HTMLElement>(".sidebar-recent-session");
      if (!row) {
        throw new Error("Missing fixture row");
      }
      row.addEventListener("mouseenter", () => marquee.startHoverMarquee(row));
      row.addEventListener("mouseleave", () => marquee.stopHoverMarquee(row));
    });
    return { browser, page };
  } catch (error) {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function closeRowFixture(fixture: BrowserFixture) {
  await fixture.page.close().catch(() => {});
  await fixture.browser.close().catch(() => {});
}

function readLabelState(page: Page) {
  return page.evaluate(() => {
    const label = document.querySelector<HTMLElement>(".hover-marquee");
    if (!label) {
      throw new Error("Missing marquee label");
    }
    // Mirror the production measurement: a mid-transition negative indent
    // shrinks scrollWidth, so add it back for a stable overflow readout.
    const indent = Number.parseFloat(getComputedStyle(label).textIndent) || 0;
    return {
      scrolling: label.classList.contains("hover-marquee--scrolling"),
      shift: label.style.getPropertyValue("--hover-marquee-shift"),
      overflow: label.scrollWidth - indent - label.clientWidth,
      textOverflow: getComputedStyle(label).textOverflow,
    };
  });
}

function waitForIndent(page: Page, expected: number) {
  return page.waitForFunction((target) => {
    const label = document.querySelector<HTMLElement>(".hover-marquee");
    if (!label) {
      return false;
    }
    return Math.abs(Number.parseFloat(getComputedStyle(label).textIndent) - target) < 1;
  }, expected);
}

describeBrowserLayout("hover marquee", () => {
  it("scrolls the clipped tail into view on hover and restores on leave", async () => {
    const fixture = await openRowFixture("Fix stale iMessage group-allowlist warning copy");
    const { page } = fixture;
    try {
      await page.hover(".sidebar-recent-session");
      const hovered = await readLabelState(page);
      expect(hovered.overflow).toBeGreaterThan(0);
      expect(hovered.scrolling).toBe(true);
      expect(hovered.shift).toBe(`-${hovered.overflow}px`);
      expect(hovered.textOverflow).toBe("clip");
      // The label animates all the way to the measured shift.
      await waitForIndent(page, -hovered.overflow);

      await page.mouse.move(0, 400);
      const rested = await readLabelState(page);
      expect(rested.scrolling).toBe(false);
      expect(rested.textOverflow).toBe("ellipsis");
      await waitForIndent(page, 0);
    } finally {
      await closeRowFixture(fixture);
    }
  });

  it("leaves labels that fit untouched", async () => {
    const fixture = await openRowFixture("Short");
    const { page } = fixture;
    try {
      await page.hover(".sidebar-recent-session");
      const hovered = await readLabelState(page);
      expect(hovered.overflow).toBeLessThanOrEqual(0);
      expect(hovered.scrolling).toBe(false);
      expect(hovered.textOverflow).toBe("ellipsis");
    } finally {
      await closeRowFixture(fixture);
    }
  });
});
