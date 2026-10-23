import { expect, it } from "vitest";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionPath, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Conversation versions" });
const key = "agent:main:release-notes";
const previousKey = "agent:main:planning";
const helpText =
  "Saved copies of this conversation from rewinds or repairs. You can return to an earlier version here.";
const branch = (id: string, headline: string, count: number, active = false) => ({
  leafEntryId: id,
  headline,
  messageCount: count,
  active,
});

suite.define(() => {
  it("explains versions on demand without switching, and preserves keyboard selection", () =>
    suite.withPage(
      { viewport: { width: 1200, height: 800 }, colorScheme: "dark" },
      async ({ page }) => {
        const draft = "Here is a concise draft:";
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          agentModel: "mock/mock-model",
          models: [{ id: "mock-model", name: "Mock model", provider: "mock" }],
          sessions: [
            { key, label: "Release notes", kind: "direct", updatedAt: Date.now() },
            { key: previousKey, label: "Planning", kind: "direct", updatedAt: Date.now() - 1 },
          ],
          historyMessages: [{ id: "answer", role: "assistant", content: draft }],
          methodResponses: {
            "sessions.branches.list": {
              branches: [
                branch("current", "A simpler way to stay organized", 4, true),
                branch("earlier", "Earlier announcement", 6),
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
        const trigger = pane.getByRole("button", { name: "Versions", exact: true });
        await trigger.press("Enter");
        const menu = pane.locator(".chat-pane__branches-menu");
        const menuSurface = menu.locator(".oc-menu");
        const info = menu.getByRole("button", { name: "About versions" });
        const help = page.getByRole("dialog", { name: "About versions" });
        const helpSurface = menu.locator(".chat-pane__versions-help");
        await expect
          .poll(() => info.evaluate((element) => element === document.activeElement))
          .toBe(true);
        expect(await help.isVisible()).toBe(false);
        const current = menu.locator('.chat-pane__branch-item[data-active="true"]');
        await waitForControlUiProofSurface(menuSurface, [
          info,
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
          const infoBox = measure(".chat-pane__versions-info svg");
          const heading = measure(".chat-pane__versions-heading > span");
          const text = measure(`${active} .chat-pane__branch-copy`);
          const badge = measure(`${active} .chat-pane__branch-active`);
          measure(`${active} .chat-pane__branch-active svg`);
          const centerY = (box: typeof infoBox) => box.y + box.height / 2;
          return {
            headline: surface.querySelector(`${active} .chat-pane__branch-headline`)?.textContent,
            headingGap: infoBox.x - heading.x - heading.width,
            textGap: badge.x - text.x - text.width,
            verticalOffset: Math.abs(centerY(badge) - centerY(text)),
          };
        });
        expect(geometry.headline).toBe("A simpler way to stay organized");
        expect(geometry.headingGap).toBeGreaterThanOrEqual(0);
        expect(geometry.headingGap).toBeLessThanOrEqual(8);
        expect(geometry.textGap).toBeGreaterThanOrEqual(0);
        expect(geometry.verticalOffset).toBeLessThanOrEqual(1);

        await info.press("Enter");
        await help.waitFor();
        expect((await helpSurface.textContent())?.trim()).toBe(helpText);
        expect(await gateway.getRequests("sessions.branches.switch")).toHaveLength(0);

        await page.keyboard.press("Escape");
        await expect.poll(() => help.isVisible()).toBe(false);
        expect(await menuSurface.isVisible()).toBe(true);
        await info.click();
        await help.waitFor();
        await pane.locator(".agent-chat__composer-combobox textarea").click();
        await expect.poll(() => help.isVisible()).toBe(false);
        await expect.poll(() => menuSurface.isVisible()).toBe(false);
        expect(await gateway.getRequests("sessions.branches.switch")).toHaveLength(0);

        await trigger.press("Enter");
        await info.press("ArrowDown");
        await page.keyboard.press("Enter");
        const switched = await gateway.waitForRequest("sessions.branches.switch");
        expect(switched.params).toMatchObject({ leafEntryId: "earlier" });
        await expect.poll(() => menuSurface.isVisible()).toBe(false);

        // Browser Back changes presentation without an outside pointer dismissal.
        await trigger.press("Enter");
        await info.press("Enter");
        await help.waitFor();
        const switchCount = (await gateway.getRequests("sessions.branches.switch")).length;
        await page.goBack();
        await expect
          .poll(() => new URL(page.url()).pathname)
          .toBe(controlUiSessionPath(previousKey));
        const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const composer = activePane.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        expect(await pane.count()).toBe(1);
        expect(await pane.getAttribute("inert")).not.toBeNull();
        await expect.poll(() => menuSurface.isVisible()).toBe(false);
        await expect.poll(() => helpSurface.isVisible()).toBe(false);
        await composer.fill("Continue planning after browser Back");
        expect(await composer.inputValue()).toBe("Continue planning after browser Back");
        expect(await gateway.getRequests("sessions.branches.switch")).toHaveLength(switchCount);
      },
    ));
});
