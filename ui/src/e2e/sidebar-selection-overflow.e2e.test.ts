import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI sidebar selection overflow",
  startServerBeforeBrowser: true,
  browserLaunchOptions: {
    ignoreDefaultArgs: ["--hide-scrollbars"],
    args: ["--disable-features=OverlayScrollbar,FluentOverlayScrollbar,FluentScrollbar"],
  },
});

suite.define(() => {
  it.each([
    { overflow: false, width: 1280 },
    { overflow: true, width: 1280 },
    { overflow: true, width: 390 },
  ])(
    "keeps sidebar rows and controls clear of scrolling with overflow=$overflow at $width px",
    async ({ overflow, width }) => {
      const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
      const context = await suite.newBrowserContext({
        viewport: { height: 500, width },
      });
      const page = await context.newPage();
      const sessionKey = "agent:main:dashboard:active-session";
      const sessions = Array.from({ length: overflow ? 40 : 3 }, (_, index) => ({
        key: index === 0 ? sessionKey : `agent:main:dashboard:session-${index}`,
        kind: "direct",
        label: index === 0 ? "Plan the next interface update" : `Review session ${index}`,
        category: "Design & UX",
        updatedAt: 40 - index,
      }));
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": {
            count: sessions.length,
            defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
            path: "",
            sessions,
            ts: Date.now(),
          },
        },
        sessionKey,
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        // Exercise the authored classic scrollbar regardless of macOS overlay preferences.
        // Either non-auto standard property would override the existing WebKit styles.
        await page.addStyleTag({
          content: ".sidebar-shell__body { scrollbar-width: auto; scrollbar-color: auto; }",
        });
        if (width === 390) {
          await page
            .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
            .first()
            .click();
        }
        const active = page.locator(
          `.sidebar-recent-session--active[data-session-key="${sessionKey}"]`,
        );
        await active.waitFor();
        const geometry = await active.evaluate((row) => {
          const sidebar = row.closest<HTMLElement>(".sidebar");
          const scroller = row.closest<HTMLElement>(".sidebar-shell__body");
          if (!sidebar || !scroller) {
            throw new Error("sidebar session geometry owner not found");
          }
          const rowRect = row.getBoundingClientRect();
          const sidebarRect = sidebar.getBoundingClientRect();
          const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth;
          const navRect = sidebar.querySelector(".sidebar-nav")!.getBoundingClientRect();
          const scrollerStyle = getComputedStyle(scroller);
          return {
            leftInset: rowRect.left - sidebarRect.left,
            rightInset: sidebarRect.right - rowRect.right - scrollbarWidth,
            navLeft: navRect.left,
            navRight: navRect.right,
            rowLeft: rowRect.left,
            rowRight: rowRect.right,
            scrollbarWidth,
            maskImage: scrollerStyle.maskImage,
            maskPosition: scrollerStyle.maskPosition,
            maskSize: scrollerStyle.maskSize,
            overflows: scroller.scrollHeight > scroller.clientHeight,
            clearance: scroller.getBoundingClientRect().right - scrollbarWidth - rowRect.right,
          };
        });

        if (captureProof) {
          await page.locator(".sidebar").screenshot({
            path: path.join(suite.artifactDir, `sidebar-${width}-overflow-${overflow}.png`),
            animations: "disabled",
          });
          console.log("Sidebar geometry", geometry);
        }
        expect(geometry.overflows).toBe(overflow);
        expect(geometry.scrollbarWidth > 0).toBe(overflow);
        expect(geometry.rightInset, JSON.stringify(geometry)).toBeCloseTo(geometry.leftInset, 1);
        expect(geometry.rowLeft).toBeCloseTo(geometry.navLeft, 1);
        expect(geometry.rowRight).toBeCloseTo(geometry.navRight, 1);
        expect(geometry.clearance).toBeGreaterThanOrEqual(8);
        if (overflow) {
          expect(geometry.maskImage.match(/linear-gradient/g)).toHaveLength(2);
          expect(geometry.maskPosition.split(", ").at(-1)?.split(" ")[0]).toBe("100%");
          expect(geometry.maskSize.split(", ")).toContain("12px 100%");
        }

        if (overflow && width === 1280) {
          const scroller = page.locator(".sidebar-shell__body");
          const navigation = page.getByRole("separator", { name: "Resize sidebar" });
          const shellNav = page.locator(".shell-nav");
          const navWidth = await shellNav.evaluate(
            (element) => element.getBoundingClientRect().width,
          );
          const bounds = await scroller.boundingBox();
          expect(bounds).not.toBeNull();
          const thumbX = bounds!.x + bounds!.width - geometry.scrollbarWidth / 2;
          const thumbY = bounds!.y + 24;
          await page.mouse.move(thumbX, thumbY);
          await page.mouse.down();
          await page.mouse.move(thumbX, thumbY + 100, { steps: 5 });
          if (captureProof) {
            await page.screenshot({
              path: path.join(suite.artifactDir, "sidebar-scrollbar-drag.png"),
              animations: "disabled",
            });
            console.log(
              "Sidebar scrollbar drag",
              await scroller.evaluate((element) => ({
                scrollTop: element.scrollTop,
                resizeDragging: document
                  .querySelector(".sidebar-resizer")
                  ?.classList.contains("dragging"),
              })),
            );
          }
          expect(
            await navigation.evaluate((element) => element.classList.contains("dragging")),
          ).toBe(false);
          await page.mouse.up();
          await expect
            .poll(() => scroller.evaluate((element) => element.scrollTop))
            .toBeGreaterThan(0);
          expect(await shellNav.evaluate((element) => element.getBoundingClientRect().width)).toBe(
            navWidth,
          );

          await page.mouse.down();
          await page.mouse.move(thumbX, thumbY, { steps: 5 });
          await page.mouse.up();
          await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);

          const handle = await navigation.boundingBox();
          expect(handle).not.toBeNull();
          const handleX = handle!.x + handle!.width / 2;
          const handleY = handle!.y + handle!.height / 2;
          await page.mouse.move(handleX, handleY);
          await page.mouse.down();
          await page.mouse.move(handleX + 50, handleY, { steps: 5 });
          await page.mouse.up();
          await expect
            .poll(() => shellNav.evaluate((element) => element.getBoundingClientRect().width))
            .toBe(navWidth + 50);
          await navigation.focus();
          await page.keyboard.press("Home");
          await expect.poll(() => navigation.getAttribute("aria-valuetext")).toBe("240 pixels");
        }

        const rtlMaskPosition = await active.evaluate((row) => {
          document.documentElement.dir = "rtl";
          return getComputedStyle(row.closest<HTMLElement>(".sidebar-shell__body")!).maskPosition;
        });
        if (overflow) {
          expect(rtlMaskPosition.split(", ").at(-1)?.split(" ")[0]).toBe("0%");
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("keeps a focused session outline inside the sidebar clip", async () => {
    const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
    const context = await suite.newBrowserContext({ viewport: { height: 500, width: 1280 } });
    const page = await context.newPage();
    const sessionKey = "agent:main:dashboard:focused-session";
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions: [{ key: sessionKey, kind: "direct", label: "Focused session", updatedAt: 1 }],
          ts: Date.now(),
        },
      },
      sessionKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const link = page.locator(
        `.sidebar-recent-session[data-session-key="${sessionKey}"] .sidebar-recent-session__link`,
      );
      await link.focus();
      const geometry = await link.evaluate((element) => {
        const linkRect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        let clipLeft = Number.NEGATIVE_INFINITY;
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const ancestorStyle = getComputedStyle(ancestor);
          if (["auto", "clip", "hidden", "scroll"].includes(ancestorStyle.overflowX)) {
            clipLeft = Math.max(clipLeft, ancestor.getBoundingClientRect().left);
          }
        }
        return {
          clipLeft,
          outlineLeft:
            linkRect.left -
            Number.parseFloat(style.outlineWidth) -
            Number.parseFloat(style.outlineOffset),
        };
      });

      expect(geometry.outlineLeft, JSON.stringify(geometry)).toBeGreaterThanOrEqual(
        geometry.clipLeft,
      );
      if (captureProof) {
        const artifactDir = path.join(suite.artifactDir, "sidebar-selection-overflow");
        await fs.mkdir(artifactDir, { recursive: true });
        await page.screenshot({ path: path.join(artifactDir, "focused-session-outline.png") });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
