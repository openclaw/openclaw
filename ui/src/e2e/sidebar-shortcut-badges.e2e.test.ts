import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  createSidebarFooterProofSuite,
  openSidebarFooterProofPage,
} from "./sidebar-footer-proof.test-support.ts";

const suite = createSidebarFooterProofSuite("Control UI shortcut badge menus");

suite.define(() => {
  it("right-aligns account shortcuts with the sidebar tooltip badge style", async () => {
    const { page, sidebar, context } = await openSidebarFooterProofPage(suite);
    try {
      await sidebar.locator(".sidebar-identity-card").click();
      const menu = sidebar.locator(".sidebar-identity-menu");
      const shortcuts = menu.locator("kbd.session-menu__shortcut");
      await shortcuts.first().waitFor({ state: "visible" });
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const frame = await takeControlUiScreenshotFrame(page, menu, [shortcuts.first()], {
          animations: "disabled",
          elements: [menu],
        });
        await writeFile(
          path.join(suite.artifactDir, "account-shortcuts.png"),
          frame.elements[0]!.png,
        );
      }
      const hints = await shortcuts.evaluateAll((elements) =>
        elements.map((element) => {
          const style = getComputedStyle(element);
          const row = element.closest<HTMLElement>('[role="menuitem"]')!;
          return {
            right: element.getBoundingClientRect().right,
            endGap:
              row.getBoundingClientRect().right -
              Number.parseFloat(getComputedStyle(row).paddingInlineEnd) -
              element.getBoundingClientRect().right,
            padding: Number.parseFloat(style.paddingInlineEnd),
            radius: style.borderRadius,
            background: style.backgroundColor,
          };
        }),
      );
      expect(hints).toHaveLength(2);
      expect(
        Math.max(...hints.map((hint) => hint.right)) - Math.min(...hints.map((hint) => hint.right)),
      ).toBeLessThan(1);
      for (const hint of hints) {
        expect(Math.abs(hint.endGap)).toBeLessThan(1);
        expect(hint.padding).toBeGreaterThan(0);
        expect(hint.radius).toBe("4px");
        expect(hint.background).not.toBe("rgba(0, 0, 0, 0)");
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
