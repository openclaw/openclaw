import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { ChatPaneElement } from "../pages/chat/chat-pane-elements.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI route readiness" });
const readSelection = (composer: Locator) =>
  composer.evaluate((element: HTMLTextAreaElement) => ({
    start: element.selectionStart,
    end: element.selectionEnd,
    direction: element.selectionDirection,
  }));

suite.define(() => {
  it.each([
    ["desktop selection", 1200, 800, "no-preference", false],
    ["mobile composition", 390, 844, "reduce", true],
  ] as const)(
    "accepts a message and preserves the next draft's %s while first history loads",
    async (_name, width, height, reducedMotion, ime) => {
      const options = { viewport: { width, height }, reducedMotion };
      await suite.withPage(options, async ({ page, context }) => {
        const sessionKey = "agent:main:thread:12345678-90ab-4def-8234-567890abcdef";
        const sessionId = "session:history-ready";
        const activeLeafEntryId = "history-ready-leaf";
        const submittedMessage = "Send before history.";
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [
            {
              key: sessionKey,
              sessionId,
              activeLeafEntryId,
              kind: "direct",
              updatedAt: 1,
              displayName: "Draft timing",
              hasActiveRun: false,
            },
          ],
          historyMessages: [{ role: "assistant", content: "Ready." }],
          heldMethods: ["chat.startup", "chat.history"],
        });
        await page.goto(`${suite.server.baseUrl}chat/main/draft-timing-12345678`);
        const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
        const composer = pane.locator(".agent-chat__composer-combobox textarea");
        const transcript = pane.locator(".chat-thread");
        const historyLoading = transcript.locator(
          ime ? ".chat-conversation-loading" : ".lazy-view-state--loading",
        );
        await composer.waitFor({ state: "visible" });
        await expect.poll(() => composer.isEnabled()).toBe(true);
        await expect.poll(() => historyLoading.isVisible()).toBe(true);
        await gateway.waitForRequest("chat.startup");
        expect(await historyLoading.getAttribute("aria-busy")).toBe("true");
        expect(await transcript.getByText("Ready.", { exact: true }).count()).toBe(0);
        expect(await composer.evaluate((el) => el === document.activeElement)).toBe(false);
        await composer.fill(submittedMessage);
        await expect.poll(() => pane.locator(".chat-send-btn--send").isEnabled()).toBe(true);
        if (width > 400) {
          await composer.press("Enter");
        } else {
          await pane.getByRole("button", { name: "Send message" }).click();
        }
        await expect.poll(() => composer.inputValue()).toBe("");
        await pane.locator(".chat-queue").getByText(submittedMessage, { exact: true }).waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        // Updating the queue remounts the transcript placeholder, whose shared
        // reveal animation briefly hides it; history must remain held throughout.
        await expect.poll(() => historyLoading.isVisible()).toBe(true);
        expect(await transcript.getByText("Ready.", { exact: true }).count()).toBe(0);

        await composer.fill("Next draft before history.");
        const input = await composer.elementHandle();
        let pendingDraft = await composer.inputValue();
        await composer.evaluate((element: HTMLTextAreaElement) =>
          element.setSelectionRange(6, 13, "backward"),
        );
        const cdp = ime ? await context.newCDPSession(page) : null;
        if (cdp) {
          await cdp.send("Input.imeSetComposition", {
            text: "編集中",
            selectionStart: 1,
            selectionEnd: 2,
          });
          pendingDraft = await composer.inputValue();
          expect(pendingDraft).toContain("編集中");
        }
        const selection = await readSelection(composer);
        await page.evaluate(
          () =>
            new Promise((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(resolve));
            }),
        );
        const before = await composer.boundingBox();

        await gateway.resolveDeferred("chat.startup");
        await expect.poll(() => historyLoading.count()).toBe(0);
        await expect.poll(() => pane.textContent()).toContain("Ready.");
        expect(
          await input!.evaluate(
            (element) => element.isConnected && element === document.activeElement,
          ),
        ).toBe(true);
        expect(await composer.inputValue()).toBe(pendingDraft);
        expect(await readSelection(composer)).toEqual(selection);
        expect(await composer.boundingBox()).toMatchObject({
          x: expect.closeTo(before!.x, 0),
          y: expect.closeTo(before!.y, 0),
          width: expect.closeTo(before!.width, 0),
        });
        const sent = await gateway.waitForRequest("chat.send");
        expect(sent.params).toMatchObject({
          sessionKey,
          sessionId,
          expectedLeafEntryId: activeLeafEntryId,
          message: submittedMessage,
        });
        if (cdp) {
          await cdp.send("Input.insertText", { text: "編集済み" });
          pendingDraft = await composer.inputValue();
          expect(pendingDraft).toContain("編集済み");
          await cdp.detach();
        }
        expect(await composer.inputValue()).toBe(pendingDraft);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      });
    },
  );

  it("navigates an exact session key at an encoded mount", async () => {
    await suite.withPage({ viewport: { width: 1200, height: 800 } }, async ({ page }) => {
      const basePath = "/nested/$&;=()+,![]{}'`/%25PATH%25";
      const initialSessionKey = "agent:runner:route:initial";
      const mountUrl = new URL(suite.server.baseUrl);
      mountUrl.pathname = basePath;
      await installMockGateway(page, {
        basePath: mountUrl.pathname,
        sessionKey: initialSessionKey,
      });
      await page.goto(controlUiSessionUrl(mountUrl.href, initialSessionKey));
      const visiblePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
      await expect
        .poll(() => visiblePane.evaluate((pane) => (pane as ChatPaneElement).sessionKey))
        .toBe(initialSessionKey);

      const sessionKey = "agent:runner:route:a/b";
      await navigateToControlUiSession(page, sessionKey);
      expect(new URL(page.url()).pathname).toBe(`${mountUrl.pathname}/chat/runner/route/a%2Fb`);
      expect(await visiblePane.evaluate((pane) => (pane as ChatPaneElement).sessionKey)).toBe(
        sessionKey,
      );
    });
  });
});
