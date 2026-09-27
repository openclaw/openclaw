import path from "node:path";
import photon from "@silvia-odwyer/photon-node";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Spatial overflow fades" });
const table = `| Service | Owner | Region | Status | Version | Deploy | Incidents | Priority | Last reviewed | Next review | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Gateway | Platform | eu-west-1 | Healthy | Stable | Complete | 0 | Normal | September 20, 2026 | September 27, 2026 | A long operational note that keeps this column wide |
| Scheduler | Operations | us-east-1 | Healthy | Stable | Complete | 0 | Normal | September 20, 2026 | September 27, 2026 | Background jobs are running on schedule |`;

// Calibrate the real scroller with a solid paint layer, without replacing its
// mask, geometry or overflow state. Sampling the rendered pixels catches a hard
// clip even when the observer attributes and computed gradient both look valid.
async function expectClearEdge(scroller: Locator) {
  const page = scroller.page();
  await scroller.evaluate((element) => {
    element.setAttribute("data-fade-probe", "");
    element.parentElement!.setAttribute("data-fade-probe-parent", "");
  });
  const probe = await page.addStyleTag({
    content:
      "[data-fade-probe] { background: white !important; } [data-fade-probe] > * { visibility: hidden !important; } [data-fade-probe-parent] { background: black !important; }",
  });
  try {
    const image = photon.PhotonImage.new_from_byteslice(
      await scroller.screenshot({ animations: "disabled" }),
    );
    try {
      const width = image.get_width();
      const pixels = image.get_raw_pixels();
      const sample = (y: number) => pixels[(y * width + Math.floor(width / 2)) * 4]!;
      for (const edge of ["top", "bottom"]) {
        const ramp = Array.from({ length: 36 }, (_, y) =>
          sample(edge === "top" ? y : image.get_height() - 1 - y),
        );
        expect(ramp[0], `${edge}: content clears the clipping boundary`).toBeLessThanOrEqual(3);
        expect(ramp[4], `${edge}: no bright strip at the edge`).toBeLessThan(30);
        expect(ramp[35], `${edge}: interior stays fully legible`).toBeGreaterThanOrEqual(250);
        for (let y = 1; y < ramp.length; y++) {
          const step = ramp[y]! - ramp[y - 1]!;
          expect(step, `${edge}: opacity does not reverse at pixel ${y}`).toBeGreaterThanOrEqual(
            -1,
          );
          expect(step, `${edge}: no abrupt opacity jump at pixel ${y}`).toBeLessThan(25);
        }
      }
    } finally {
      image.free();
    }
  } finally {
    await probe.evaluate((el) => el.parentNode?.removeChild(el));
    await scroller.evaluate((el) => {
      el.removeAttribute("data-fade-probe");
      el.parentElement!.removeAttribute("data-fade-probe-parent");
    });
  }
}

suite.define(() => {
  it.each([390, 1280])("preserves scroll endpoints and controls at %ipx", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 800 }, colorScheme: "dark", reducedMotion: "reduce" },
      async ({ page }) => {
        const key = "agent:main:dashboard:fade-proof";
        const sessions = Array.from({ length: 40 }, (_, i) => ({
          key: i === 0 ? key : `agent:main:dashboard:proof-${i}`,
          label: i === 0 ? "Review overflow fades" : `Design review ${i}`,
          kind: "direct",
          updatedAt: 40 - i,
        }));
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          sessions,
          methodResponses: {
            "sessions.list": {
              count: sessions.length,
              defaults: { contextTokens: null, model: "example-model", modelProvider: "example" },
              path: "",
              sessions,
              ts: Date.now(),
            },
          },
          historyMessages: [
            ...Array.from({ length: 8 }, (_, i) => ({
              role: "assistant",
              content: `## Review note ${i + 1}\n\nThe interface should stay readable while scrolling through long conversations. Keep controls reachable and preserve the surrounding context.`,
            })),
            { role: "assistant", content: table },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        const viewport = page.locator(".markdown-table__viewport").last();
        await viewport.waitFor();
        const shell = viewport.locator("..");
        const tableOverflows = await viewport.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
        if (tableOverflows) {
          await expect.poll(() => shell.getAttribute("class")).toContain("can-scroll-right");
        } else {
          expect(await viewport.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
        }
        const capture = async (name: string) => {
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
            return;
          }
          for (const mode of ["dark", "light"] as const) {
            await page.emulateMedia({ colorScheme: mode });
            await expect
              .poll(() => page.locator("html").getAttribute("data-theme-mode"))
              .toBe(mode);
            await page.screenshot({
              path: path.join(suite.artifactDir, `${width}-${name}-${mode}.png`),
              animations: "disabled",
            });
          }
        };
        await capture("table-start");
        if (tableOverflows) {
          await viewport.evaluate((el) => {
            el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
          });
          await expect.poll(() => shell.getAttribute("class")).toContain("can-scroll-left");
          await expect.poll(() => shell.getAttribute("class")).toContain("can-scroll-right");
          await capture("table-middle");
          await viewport.evaluate((el) => {
            el.scrollLeft = el.scrollWidth;
          });
          await expect.poll(() => shell.getAttribute("class")).not.toContain("can-scroll-right");
          await capture("table-end");
        }
        if (width > 768) {
          // The list intentionally shows only ten rows until expanded; use the
          // same short viewport as the existing sidebar containment regression.
          await page.setViewportSize({ width, height: 500 });
          const sidebar = page.locator(".sidebar-shell__body");
          await expect.poll(() => sidebar.getAttribute("class")).toContain("scroll-top");
          await sidebar.evaluate((el) => {
            el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
          });
          await expect.poll(() => sidebar.getAttribute("class")).toContain("scroll-middle");
          await capture("sidebar-middle");
          await expectClearEdge(sidebar);
          await sidebar.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          await expect.poll(() => sidebar.getAttribute("class")).toContain("scroll-bottom");
          await capture("sidebar-end");
          await page.setViewportSize({ width, height: 800 });
        }
        const thread = page.locator(".chat-thread").first();
        await thread.evaluate((el) => {
          el.scrollTop = el.scrollHeight / 2;
        });
        await capture("transcript-middle");
        await gateway.setOnline(false);
        await gateway.closeLatest();
        for (let i = 1; i <= 7; i++) {
          await composer.fill(`Review item ${i}: verify smooth edges and readable content`);
          await composer.press("Enter");
          await page.locator(".chat-queue__item", { hasText: `Review item ${i}:` }).waitFor();
        }
        const queue = page.locator(".chat-queue__scroll");
        await expect.poll(() => queue.getAttribute("data-scrollable")).toBe("true");
        await capture("queue-start");
        await queue.evaluate((el) => {
          el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
        });
        await expect.poll(() => queue.getAttribute("data-at-start")).toBe("false");
        await expect.poll(() => queue.getAttribute("data-at-end")).toBe("false");
        await capture("queue-middle");
        await expectClearEdge(queue);
        await queue.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await expect.poll(() => queue.getAttribute("data-at-end")).toBe("true");
        await capture("queue-end");
        const last = queue.locator(".chat-queue__item").last().locator(".chat-queue__grip");
        await last.focus();
        expect(await last.evaluate((el) => el.matches(":focus"))).toBe(true);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
      },
    );
  });
});
