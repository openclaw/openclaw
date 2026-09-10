import { expect, it } from "vitest";
import type { ChatPaneElement } from "../pages/chat/route-draft-focus-handoff.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI route readiness" });

suite.define(() => {
  it("keeps a short session's draft and focus while its first transcript loads", async () => {
    await suite.withPage({ viewport: { width: 1200, height: 800 } }, async ({ page }) => {
      const sessionKey = "agent:main:thread:12345678-90ab-4def-8234-567890abcdef";
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [{ key: sessionKey, kind: "direct", updatedAt: 1, displayName: "Draft timing" }],
        historyMessages: [{ role: "assistant", content: "The conversation is ready." }],
        heldMethods: ["chat.startup", "chat.history"],
      });
      await page.goto(`${suite.server.baseUrl}chat/main/draft-timing-12345678`);
      const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
      const composer = pane.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible" });
      await expect.poll(() => composer.isEnabled()).toBe(true);
      await expect.poll(() => pane.locator(".loading-skeleton").isVisible()).toBe(true);
      expect(await composer.evaluate((element) => element === document.activeElement)).toBe(false);
      await composer.fill("Draft written before history arrives.");
      const input = await composer.elementHandle();
      await expect.poll(() => pane.locator(".chat-send-btn--send").isDisabled()).toBe(true);
      await composer.press("Enter");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      const pendingDraft = await composer.inputValue();
      expect(pendingDraft.trim()).toBe("Draft written before history arrives.");
      // Enter inserts a newline while sending is disabled; let textarea autosizing finish.
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }),
      );
      const before = await composer.boundingBox();

      await gateway.resolveDeferred("chat.startup");
      await expect.poll(() => pane.locator(".loading-skeleton").count()).toBe(0);
      await expect.poll(() => pane.textContent()).toContain("The conversation is ready.");
      expect(
        await input!.evaluate(
          (element) => element.isConnected && element === document.activeElement,
        ),
      ).toBe(true);
      expect(await composer.inputValue()).toBe(pendingDraft);
      const after = await composer.boundingBox();
      expect(after?.x).toBeCloseTo(before!.x, 0);
      expect(after?.y).toBeCloseTo(before!.y, 0);
      expect(after?.width).toBeCloseTo(before!.width, 0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await expect.poll(() => pane.locator(".chat-send-btn--send").isEnabled()).toBe(true);
      await composer.press("Enter");
      const sent = await gateway.waitForRequest("chat.send");
      expect(sent.params).toMatchObject({
        sessionKey,
        message: "Draft written before history arrives.",
      });
    });
  });

  it.each([
    { name: "root", basePath: "" },
    { name: "encoded mount", basePath: "/nested/$&;=()+,![]{}'`/%25PATH%25" },
  ])("navigates exact session keys at the $name", async ({ basePath }) => {
    await suite.withPage({ viewport: { width: 1200, height: 800 } }, async ({ page }) => {
      const initialSessionKey = "agent:runner:route:initial";
      const mountUrl = new URL(suite.server.baseUrl);
      mountUrl.pathname = basePath || "/";
      await installMockGateway(page, {
        basePath: basePath ? mountUrl.pathname : "",
        sessionKey: initialSessionKey,
      });
      await page.goto(controlUiSessionUrl(mountUrl.href, initialSessionKey));
      const visiblePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
      await expect
        .poll(() => visiblePane.evaluate((pane) => (pane as ChatPaneElement).sessionKey))
        .toBe(initialSessionKey);

      const encodedBase = basePath ? mountUrl.pathname : "";
      for (const [rest, suffix] of [
        ["a/b", "a%2Fb"],
        ["a:b", "a/b"],
        ["%2F%25%3F%23", "%252F%2525%253F%2523"],
        ["a?b#c", "a%3Fb%23c"],
      ]) {
        const sessionKey = `agent:runner:route:${rest}`;
        await navigateToControlUiSession(page, sessionKey);
        expect(new URL(page.url()).pathname).toBe(`${encodedBase}/chat/runner/route/${suffix}`);
        expect(await visiblePane.evaluate((pane) => (pane as ChatPaneElement).sessionKey)).toBe(
          sessionKey,
        );
      }
    });
  });
});
