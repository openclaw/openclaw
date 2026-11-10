import { expect, it } from "vitest";
import { withBrowserPage } from "../test-helpers/browser-page.ts";
import { readStyles, styleFixture } from "./style-fixture.test-support.ts";

const colors = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"];
const fixture = styleFixture("session-row-tint-", { required: true });

fixture.describe("sidebar session row tint", () => {
  it.each(["light", "dark"])("preserves readable tag and selection paints in %s", async (theme) => {
    await withBrowserPage(fixture.page(), async (page) => {
      const rows = [false, true]
        .flatMap((pinned) =>
          ["none", ...colors].map(
            (
              color,
            ) => `<div class="${pinned ? "sidebar-zone-entry" : ""}"><div id="${pinned ? "pinned-" : "recent-"}${color}"
          class="sidebar-recent-session session-row-host ${color !== "none" ? "sidebar-recent-session--colored" : ""}"
          style="--session-color:var(--session-color-${color})">
          <a class="sidebar-recent-session__link" href="#"><span class="sidebar-recent-session__text">
            <span class="sidebar-recent-session__title-row"><span class="sidebar-recent-session__name">Design review</span></span>
            <span class="sidebar-recent-session__details"><span class="sidebar-recent-session__subtitle">Ready for review</span></span>
          </span></a><span class="sidebar-recent-session__aside session-row-aside"><span class="session-row-trail">3m</span></span>
        </div></div>`,
          ),
        )
        .join("");
      await page.setContent(
        `<!doctype html><html data-theme-mode="${theme}"><head><style>${readStyles("styles/base", "styles/layout", "styles/components")}</style>
        <style>.sidebar{width:280px}.sidebar-recent-session,.sidebar-zone-entry .sidebar-recent-session{transition:none}</style></head>
        <body><aside class="sidebar"><div class="sidebar-shell">${rows}</div></aside></body></html>`,
      );
      // Force real :hover selectors without timed mouse motion or transitions.
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
            const surface = getComputedStyle(document.querySelector(".sidebar")!).backgroundColor;
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
              rgb.reduce((sum, v, i) => {
                const s = v / 255;
                const linear = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
                return sum + linear * [0.2126, 0.7152, 0.0722][i]!;
              }, 0);
            return Array.from(
              document.querySelectorAll<HTMLElement>(".sidebar-recent-session"),
            ).map((row) => {
              const selected = rowState.includes("selected"),
                active = rowState.includes("active");
              row.classList.toggle("sidebar-recent-session--active", active);
              row.classList.toggle("sidebar-recent-session--selected", selected);
              const style = getComputedStyle(row);
              const fill = getComputedStyle(row, "::after");
              const colored = row.classList.contains("sidebar-recent-session--colored");
              const hover = rowState.includes("hover");
              const background = paint(fill.backgroundColor);
              const token = selected
                ? "--accent"
                : active && !colored
                  ? "--text"
                  : "--session-color";
              // Neutral active paint differs by mode and strengthens on hover;
              // multiselection keeps its independent accent wash over either state.
              const tints =
                mode === "light"
                  ? { idle: 0.09, hover: 0.14, active: 0.06, activeHover: 0.09 }
                  : { idle: 0.12, hover: 0.18, active: 0.08, activeHover: 0.11 };
              // An open colored row keeps its tag color one step stronger.
              const alpha = selected
                ? 0.14
                : active && colored
                  ? tints.idle * (hover ? 2.4 : 2)
                  : active
                    ? tints[hover ? "activeHover" : "active"]
                    : tints[hover ? "hover" : "idle"];
              const expected = paint(style.getPropertyValue(token), alpha);
              const metadata = [".sidebar-recent-session__subtitle", ".session-row-trail"].map(
                (selector) => {
                  const textStyle = getComputedStyle(row.querySelector(selector)!);
                  // Composite the text over the row and its actual opaque sidebar.
                  paint(fill.backgroundColor);
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
                outerBackground: style.backgroundColor,
                fillBackground: fill.backgroundColor,
                insets: [
                  Number.parseFloat(style.borderTopWidth) + Number.parseFloat(fill.top),
                  Number.parseFloat(style.borderBottomWidth) + Number.parseFloat(fill.bottom),
                ],
                background,
                expected,
                metadata,
                title: paint(title.color),
                expectedTitle: paint(
                  style.getPropertyValue(active || selected ? "--text-strong" : "--text"),
                ),
              };
            });
          },
          { state, theme },
        );
        for (const sample of samples) {
          const label = theme + "/" + state + "/" + sample.id;
          expect(sample, label).toMatchObject({
            outerBackground: "rgba(0, 0, 0, 0)",
            insets: [1, 1],
            title: sample.expectedTitle,
          });
          if (sample.colored || state.includes("active") || state.includes("selected")) {
            sample.background.forEach((channel, i) =>
              expect(
                Math.abs(channel - sample.expected[i]!),
                label + " inset row paint",
              ).toBeLessThanOrEqual(1),
            );
          } else if (state === "idle") {
            expect(sample.fillBackground).toBe("rgba(0, 0, 0, 0)");
          }
          if (sample.colored) {
            for (const ratio of sample.metadata) {
              expect(ratio, label + " metadata AA").toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      }
      await cdp.detach();
    });
  });
});
