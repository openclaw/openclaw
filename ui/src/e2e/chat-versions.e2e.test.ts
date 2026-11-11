import { expect, it } from "vitest";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionPath, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Conversation versions" });
const key = "agent:main:release-notes";
const previousKey = "agent:main:planning";

suite.define(() => {
  it("aligns version labels in the session menu and retires it on browser Back", () =>
    suite.withPage(
      { viewport: { width: 1200, height: 800 }, colorScheme: "dark" },
      async ({ page }) => {
        const draft = "Here is a concise draft:";
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          sessions: [
            { key, label: "Release notes", kind: "direct", updatedAt: Date.now() },
            { key: previousKey, label: "Planning", kind: "direct", updatedAt: Date.now() - 1 },
          ],
          historyMessages: [{ id: "answer", role: "assistant", content: draft }],
          methodResponses: {
            "sessions.branches.list": {
              branches: [
                {
                  leafEntryId: "current",
                  headline: "A simpler way to stay organized",
                  messageCount: 4,
                  active: true,
                },
                ...Array.from({ length: 15 }, (_, index) => ({
                  leafEntryId: index === 0 ? "earlier" : `earlier-${index}`,
                  headline: index === 0 ? "Earlier" : `Earlier draft ${index}`,
                  messageCount: 6 + index,
                  active: false,
                })),
              ],
            },
          },
        });
        await page.goto(new URL(controlUiSessionPath(previousKey), suite.server.baseUrl).href);
        await page.getByText(draft, { exact: false }).waitFor();
        await page
          .locator(
            `.sidebar-recent-session[data-session-key="${key}"] a.sidebar-recent-session__link`,
          )
          .click();
        await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(key));
        const pane = page.locator(`openclaw-chat-pane[data-mcp-app-owner-key*="${key}"]`);
        await pane.getByText(draft, { exact: false }).waitFor();
        await pane.locator(".chat-header-session-menu__trigger").click();
        const versions = pane.locator('button[data-value="submenu:versions"]');
        await versions.hover();
        const menuSurface = pane
          .locator(".oc-menu")
          .filter({ has: page.locator(".chat-pane__branch-item") })
          .last();
        const current = menuSurface.locator('.chat-pane__branch-item[data-active="true"]');
        await waitForControlUiProofSurface(menuSurface, [
          menuSurface.getByRole("note"),
          current.locator(".chat-pane__branch-copy"),
          current.locator(".chat-pane__branch-active svg"),
        ]);
        // Measure one DOM generation so a rerender cannot detach an icon between reads.
        const geometry = await menuSurface.evaluate((surface) => {
          const active = '.chat-pane__branch-item[data-active="true"]';
          const measure = (selector: string) => {
            const element = surface.querySelector(selector);
            if (
              !element?.isConnected ||
              !element.checkVisibility({ checkOpacity: true, visibilityProperty: true })
            ) {
              throw new Error(`Invisible versions element: ${selector}`);
            }
            const { x, y, width, height } = element.getBoundingClientRect();
            if (width <= 0 || height <= 0) {
              throw new Error(`Empty versions element: ${selector}`);
            }
            return { x, y, width, height };
          };
          const text = measure(`${active} .chat-pane__branch-copy`);
          const badge = measure(`${active} .chat-pane__branch-active`);
          measure(`${active} .chat-pane__branch-active svg`);
          const centerY = (box: typeof text) => box.y + box.height / 2;
          return {
            textGap: badge.x - text.x - text.width,
            verticalOffset: Math.abs(centerY(badge) - centerY(text)),
          };
        });
        expect(geometry.textGap).toBeGreaterThanOrEqual(0);
        expect(geometry.verticalOffset).toBeLessThanOrEqual(1);
        // Long histories scroll inside a bounded submenu instead of filling the viewport.
        const bounds = await menuSurface.evaluate((surface) => ({
          height: surface.getBoundingClientRect().height,
          scrolls: surface.scrollHeight > surface.clientHeight,
        }));
        expect(bounds.height).toBeLessThanOrEqual(360);
        expect(bounds.scrolls).toBe(true);

        // Browser Back changes presentation without an outside pointer dismissal.
        expect(await gateway.getRequests("sessions.branches.switch")).toHaveLength(0);
        await page.goBack();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(controlUiSessionPath(previousKey));
        const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const composer = activePane.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        expect(await pane.getAttribute("inert")).not.toBeNull();
        await expect.poll(() => current.isVisible()).toBe(false);
        await composer.fill("Continue planning after browser Back");
        expect(await composer.inputValue()).toBe("Continue planning after browser Back");
        expect(await gateway.getRequests("sessions.branches.switch")).toHaveLength(0);
      },
    ));
});
