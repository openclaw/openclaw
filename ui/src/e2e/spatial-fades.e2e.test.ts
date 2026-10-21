import photon from "@silvia-odwyer/photon-node";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Spatial overflow fades" });
const scrollTo = (scroller: Locator, fraction: number) =>
  scroller.evaluate((el, ratio) => {
    el.scrollTop = (el.scrollHeight - el.clientHeight) * ratio;
  }, fraction);
// Sample real mask pixels: correct observer attributes do not rule out a hard clip.
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
  let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
  try {
    image = photon.PhotonImage.new_from_byteslice(
      await scroller.screenshot({ animations: "disabled" }),
    );
    const width = image.get_width();
    const height = image.get_height();
    const pixels = image.get_raw_pixels();
    const sample = (y: number) => pixels[(y * width + Math.floor(width / 2)) * 4]!;
    // Skip the rounded outer pixel, which can include the parent border.
    for (const edge of ["top", "bottom"]) {
      const ramp = Array.from({ length: 36 }, (_, y) =>
        sample(edge === "top" ? y + 1 : height - 2 - y),
      );
      expect(ramp[0], `${edge}: content clears the clipping boundary`).toBeLessThanOrEqual(3);
      expect(ramp[4], `${edge}: no bright strip at the edge`).toBeLessThan(30);
      expect(ramp[35], `${edge}: interior stays fully legible`).toBeGreaterThanOrEqual(250);
      const steps = ramp.slice(1).map((value, index) => value - ramp[index]!);
      expect(Math.min(...steps), `${edge}: no reverse`).toBeGreaterThanOrEqual(-1);
      expect(Math.max(...steps), `${edge}: no abrupt opacity jump`).toBeLessThan(25);
    }
  } finally {
    image?.free();
    await probe.evaluate((el) => el.parentNode?.removeChild(el));
    await scroller.evaluate((el) => {
      el.removeAttribute("data-fade-probe");
      el.parentElement!.removeAttribute("data-fade-probe-parent");
    });
  }
}

suite.define(() => {
  it.each([390, 1280])("preserves scroll endpoints and controls at %ipx", (width) =>
    suite.withPage(
      { viewport: { width, height: 800 }, colorScheme: "dark", reducedMotion: "reduce" },
      async ({ page }) => {
        const key = "agent:main:dashboard:fade-proof";
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          sessions: Array.from({ length: 40 }, (_, i) => ({
            key: i === 0 ? key : `agent:main:dashboard:proof-${i}`,
            label: i === 0 ? "Review overflow fades" : `Design review ${i}`,
            kind: "direct",
            updatedAt: 40 - i,
          })),
          historyMessages: [{ role: "assistant", content: "Review the overflow edges." }],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        if (width > 768) {
          // Expand the capped list so the compact header still leaves a real scroll range.
          await page.getByRole("button", { name: "Show more", exact: true }).click();
          await page.setViewportSize({ width, height: 500 });
          const sidebar = page.locator(".sidebar-shell__body");
          await expect.poll(() => sidebar.getAttribute("class")).toContain("scroll-top");
          await scrollTo(sidebar, 0.5);
          await expect.poll(() => sidebar.getAttribute("class")).toContain("scroll-middle");
          await expectClearEdge(sidebar);
          await scrollTo(sidebar, 1);
          await expect.poll(() => sidebar.getAttribute("class")).toContain("scroll-bottom");
          await page.setViewportSize({ width, height: 800 });
        }
        await gateway.setOnline(false);
        await gateway.closeLatest();
        for (let i = 1; i <= 7; i++) {
          await composer.fill(`Review item ${i}: verify smooth edges and readable content`);
          await composer.press("Enter");
          await page.locator(".chat-queue__item", { hasText: `Review item ${i}:` }).waitFor();
        }
        const queue = page.locator(".chat-queue__scroll");
        await expect.poll(() => queue.getAttribute("data-scrollable")).toBe("true");
        await scrollTo(queue, 0.5);
        await expect.poll(() => queue.getAttribute("data-at-start")).toBe("false");
        await expect.poll(() => queue.getAttribute("data-at-end")).toBe("false");
        await expectClearEdge(queue);
        await scrollTo(queue, 1);
        await expect.poll(() => queue.getAttribute("data-at-end")).toBe("true");
        const last = queue.locator(".chat-queue__item").last().locator(".chat-queue__grip");
        await last.focus();
        expect(await last.evaluate((el) => el.matches(":focus"))).toBe(true);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
      },
    ),
  );
});
