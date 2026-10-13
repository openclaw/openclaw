import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const colors = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"];
let browser: Browser;

// CSS owns this contract. The existing session-color E2E owns applying/removing
// colors through menus; this bounded browser fixture isolates cascade and paint.
describe("sidebar session row tint", () => {
  beforeAll(async () => {
    expect(canRunPlaywrightChromium(executablePath), "Chromium is required for paint proof").toBe(
      true,
    );
    browser = await chromium.launch({ executablePath, headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it.each(["light", "dark"])("preserves readable tag and selection paints in %s", async (theme) => {
    const page = await browser.newPage();
    try {
      const css = ["base", "layout", "components"]
        .map((name) => readStyleSheet(`ui/src/styles/` + name + `.css`))
        .join("\n");
      const rows = [false, true]
        .flatMap((pinned) =>
          ["none", ...colors].map((color) => {
            const id = (pinned ? "pinned-" : "recent-") + color;
            return (
              `<div class="` +
              (pinned ? "sidebar-zone-entry" : "") +
              `"><div id="` +
              id +
              `"
          class="sidebar-recent-session session-row-host ` +
              (color !== "none" ? "sidebar-recent-session--colored" : "") +
              `"
          style="--session-color:var(--session-color-` +
              color +
              `)">
          <a class="sidebar-recent-session__link" href="#"><span class="sidebar-recent-session__text">
            <span class="sidebar-recent-session__title-row"><span class="sidebar-recent-session__name">Design review</span></span>
            <span class="sidebar-recent-session__details"><span class="sidebar-recent-session__subtitle">Ready for review</span></span>
          </span></a><span class="sidebar-recent-session__aside session-row-aside"><span class="session-row-trail">3m</span></span>
        </div></div>`
            );
          }),
        )
        .join("");
      await page.setContent(
        `<!doctype html><html data-theme-mode="` +
          theme +
          `"><head><style>` +
          css +
          `</style>
        <style>.sidebar{width:280px}.sidebar-recent-session,.sidebar-zone-entry .sidebar-recent-session{transition:none}</style></head>
        <body><aside class="sidebar"><div class="sidebar-shell">` +
          rows +
          `</div></aside></body></html>`,
      );
      // Force the real :hover selector on all rows together, without timed mouse
      // motion, transitions, or starting a browser per palette/state combination.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument");
      const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: ".sidebar-recent-session",
      });
      for (const state of [
        "idle",
        "hover",
        "active",
        "active-hover",
        "selected",
        "selected-active-hover",
      ]) {
        await Promise.all(
          nodeIds.map((nodeId) =>
            cdp.send("CSS.forcePseudoState", {
              nodeId,
              forcedPseudoClasses: state.includes("hover") ? ["hover"] : [],
            }),
          ),
        );
        const samples = await page.evaluate(
          ({ state: rowState, theme: mode }) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
            const sidebar = document.querySelector(".sidebar")!;
            const surface = getComputedStyle(sidebar).backgroundColor;
            const paint = (color: string, alpha = 1) => {
              ctx.clearRect(0, 0, 1, 1);
              ctx.globalAlpha = 1;
              ctx.fillStyle = surface;
              ctx.fillRect(0, 0, 1, 1);
              ctx.globalAlpha = alpha;
              ctx.fillStyle = color;
              ctx.fillRect(0, 0, 1, 1);
              return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
            };
            const luminance = (rgb: number[]) =>
              rgb
                .map((v) => {
                  const s = v / 255;
                  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
                })
                .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
            return Array.from(
              document.querySelectorAll<HTMLElement>(".sidebar-recent-session"),
            ).map((row) => {
              row.classList.toggle("sidebar-recent-session--active", rowState.includes("active"));
              row.classList.toggle(
                "sidebar-recent-session--selected",
                rowState.includes("selected"),
              );
              const style = getComputedStyle(row);
              const colored = row.classList.contains("sidebar-recent-session--colored");
              const selected = rowState.includes("selected");
              const active = rowState.includes("active");
              const hover = rowState.includes("hover");
              const background = paint(style.backgroundColor);
              const token = selected ? "--accent" : active ? "--text" : "--session-color";
              const alpha = selected
                ? 0.14
                : active
                  ? 0.1
                  : hover
                    ? mode === "light"
                      ? 0.14
                      : 0.18
                    : mode === "light"
                      ? 0.09
                      : 0.12;
              const expected = paint(style.getPropertyValue(token), alpha);
              const metadata = [".sidebar-recent-session__subtitle", ".session-row-trail"].map(
                (selector) => {
                  const element = row.querySelector(selector)!;
                  const textStyle = getComputedStyle(element);
                  // Composite the text over the row and its actual opaque sidebar.
                  paint(style.backgroundColor);
                  ctx.fillStyle = textStyle.color;
                  ctx.globalAlpha = Number(textStyle.opacity);
                  ctx.fillRect(0, 0, 1, 1);
                  const foreground = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
                  const a = luminance(foreground),
                    b = luminance(background);
                  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
                },
              );
              const title = getComputedStyle(row.querySelector(".sidebar-recent-session__name")!);
              return {
                id: row.id,
                colored,
                background,
                expected,
                metadata,
                title: paint(title.color),
                expectedTitle: paint(style.getPropertyValue(active ? "--text-strong" : "--text")),
                stripe: getComputedStyle(row, "::before").width,
              };
            });
          },
          { state, theme },
        );
        for (const sample of samples) {
          const label = theme + "/" + state + "/" + sample.id;
          if (sample.colored || state.includes("active") || state.includes("selected")) {
            sample.background.forEach((channel, i) =>
              expect(
                Math.abs(channel - sample.expected[i]!),
                label + " full-row paint",
              ).toBeLessThanOrEqual(1),
            );
          } else if (state === "idle") {
            expect(
              await page
                .locator("#" + sample.id)
                .evaluate((row) => getComputedStyle(row).backgroundColor),
            ).toBe("rgba(0, 0, 0, 0)");
          }
          expect(sample.title, label + " neutral title").toEqual(sample.expectedTitle);
          if (sample.colored) {
            expect(sample.stripe, label + " retained stripe").toBe("3px");
            for (const ratio of sample.metadata) {
              expect(ratio, label + " metadata AA").toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      }
      await cdp.detach();
    } finally {
      await page.close();
    }
  });
});
