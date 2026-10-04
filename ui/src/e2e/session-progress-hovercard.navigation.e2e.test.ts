import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([390, 1440])("keeps a pressed sidebar link clickable at %i pixels", async (width) => {
    const selectedSessionKey = "agent:main:selected-pointer";
    const sessionKey = "agent:main:pointer-destination";
    await suite.withPage(
      {
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width, height: 844 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          methodResponses: {
            "progressCard.get": { card: null },
            "sessions.list": chatSessionListResponse([
              { key: selectedSessionKey, kind: "direct", label: "Selected session", updatedAt: 2 },
              { key: sessionKey, kind: "direct", label: "Destination session", updatedAt: 1 },
            ]),
          },
          sessionKey: selectedSessionKey,
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        if (width === 390) {
          await page
            .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
            .first()
            .click();
        }
        const link = page.locator(
          `.sidebar-recent-session[data-session-key="${sessionKey}"] .sidebar-recent-session__link`,
        );
        const card = page.locator(".session-progress-hovercard");
        await link.waitFor({ state: "visible" });
        // Warm the lazy provider before the measured mouse gesture.
        await link.focus();
        await card.waitFor({ state: "visible" });
        await page.mouse.move(width - 5, 10);
        await link.evaluate((element) => element.blur());
        await card.waitFor({ state: "detached" });
        await expect
          .poll(() => link.evaluate((element) => element.getBoundingClientRect().left))
          .toBeGreaterThanOrEqual(0);
        const bounds = await link.boundingBox();
        expect(bounds).not.toBeNull();
        if (!bounds) {
          throw new Error("Expected sidebar link bounds");
        }
        const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        try {
          await card.waitFor({ state: "visible" });
          expect(
            await link.evaluate((element, coordinates) => {
              const hit = document.elementFromPoint(coordinates.x, coordinates.y);
              return hit !== null && element.contains(hit);
            }, point),
          ).toBe(true);
        } finally {
          await page.mouse.up();
        }
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe("/chat/main/pointer-destination");
        if (width === 390) {
          await expect
            .poll(() => page.locator(".shell-nav").getAttribute("aria-hidden"))
            .toBe("true");
        }
      },
    );
  });
});
