import { expect, it } from "vitest";
import { waitForControlUiInitialRoster } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForSessionRosterHydration } from "./session-management.test-support.ts";

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
  ])("keeps sidebar insets symmetric with overflow=$overflow at $width px", ({ overflow, width }) =>
    suite.withPage({ viewport: { height: 500, width } }, async ({ page }) => {
      const sessionKey = "agent:main:dashboard:active-session";
      const sessions = Array.from({ length: overflow ? 40 : 3 }, (_, index) => ({
        key: index === 0 ? sessionKey : `agent:main:dashboard:session-${index}`,
        kind: "direct",
        label: index === 0 ? "Plan the next interface update" : `Review session ${index}`,
        category: "Design & UX",
        updatedAt: 40 - index,
      }));
      await installMockGateway(page, { sessions, sessionKey });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      // The active row can render before roster admission; overflow needs the full roster.
      await waitForSessionRosterHydration(page);
      // Force classic scrollbars without overriding the authored WebKit styles.
      await page.addStyleTag({
        content: ".sidebar-shell__body { scrollbar-width: auto; scrollbar-color: auto; }",
      });
      if (width === 390) {
        await navigationDrawerToggle(page).click();
        // Navigation skips the closed drawer; geometry needs its full roster after opening.
        await waitForControlUiInitialRoster(page);
      }
      if (overflow) {
        await page.getByRole("button", { name: "Show more", exact: true }).click();
        const body = page.locator(".sidebar-shell__body");
        const toolbar = page.locator(".sidebar-session-toolbar");
        const toolbarBefore = await toolbar.boundingBox();
        const last = page.locator(
          '.sidebar-recent-session[data-session-key="agent:main:dashboard:session-19"]',
        );
        await expect
          .poll(async () => {
            await body.evaluate((element) => {
              element.scrollTop = element.scrollHeight;
            });
            return last.isVisible();
          })
          .toBe(true);
        // The session toolbar stays pinned and unobscured above the scrolled list.
        expect(await toolbar.boundingBox()).toEqual(toolbarBefore);
        expect(
          await toolbar.evaluate((element) => {
            const title = element.firstElementChild!;
            const box = title.getBoundingClientRect();
            return title.contains(
              document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2),
            );
          }),
        ).toBe(true);
        await body.evaluate((element) => {
          element.scrollTop = 0;
        });
      }
      const active = page.locator(
        `.sidebar-recent-session--active[data-session-key="${sessionKey}"]`,
      );
      await active.waitFor();
      if (overflow) {
        // Rows commit before the shared layout frame publishes the scroll mask.
        await page
          .locator(
            ".sidebar-shell__body--scroll-top, .sidebar-shell__body--scroll-middle, .sidebar-shell__body--scroll-bottom",
          )
          .waitFor();
      }
      const geometry = await active.evaluate((row) => {
        const sidebar = row.closest<HTMLElement>(".sidebar-shell");
        const scroller = row.closest<HTMLElement>(".sidebar-shell__body");
        if (!sidebar || !scroller) {
          throw new Error("sidebar session geometry owner not found");
        }
        const rowRect = row.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();
        const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth;
        const listRect = row.closest(".sidebar-recent-sessions__list")!.getBoundingClientRect();
        const scrollerStyle = getComputedStyle(scroller);
        return {
          leftInset: rowRect.left - sidebarRect.left,
          rightInset: sidebarRect.right - rowRect.right - scrollbarWidth,
          listLeft: listRect.left,
          listRight: listRect.right,
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

      expect(geometry.overflows).toBe(overflow);
      expect(geometry.scrollbarWidth > 0).toBe(overflow);
      expect(geometry.rightInset, JSON.stringify(geometry)).toBeCloseTo(geometry.leftInset, 1);
      expect(geometry.rowLeft).toBeCloseTo(geometry.listLeft, 1);
      expect(geometry.rowRight).toBeCloseTo(geometry.listRight, 1);
      // The mobile rail reserves 6px gutters to preserve session title space.
      expect(geometry.clearance).toBeGreaterThanOrEqual(width === 390 ? 6 : 8);
      if (overflow) {
        expect(geometry.maskImage.match(/linear-gradient/g)).toHaveLength(2);
        expect(geometry.maskPosition.split(", ").at(-1)?.split(" ")[0]).toBe("100%");
        expect(geometry.maskSize.split(", ")).toContain("12px 100%");
      }

      const rtlMaskPosition = await active.evaluate((row) => {
        document.documentElement.dir = "rtl";
        return getComputedStyle(row.closest<HTMLElement>(".sidebar-shell__body")!).maskPosition;
      });
      if (overflow) {
        expect(rtlMaskPosition.split(", ").at(-1)?.split(" ")[0]).toBe("0%");
      }
    }),
  );

  it("keeps a focused session outline inside the sidebar clip", () =>
    suite.withPage({ viewport: { height: 500, width: 1280 } }, async ({ page }) => {
      const sessionKey = "agent:main:dashboard:focused-session";
      await installMockGateway(page, {
        sessions: [{ key: sessionKey, kind: "direct", label: "Focused session", updatedAt: 1 }],
        sessionKey,
      });

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
    }));
});
