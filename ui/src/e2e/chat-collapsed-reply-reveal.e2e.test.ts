import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  exactButton,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { polledAttribute, polledCount, polledText } from "./chat-presentation.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const earlierText = "I am checking the lunar exhibit inventory.";
const finalText = "The lunar exhibit inventory is complete.";

suite.define(() => {
  it.each([
    ["visible final answer", "inventory-final_answer", false],
    ["folded tool result", "inventory-earlier", false],
    ["deep tool result in standalone work", "inventory-earlier", true],
  ] as const)(
    "reveals the %s after replying through transcript search",
    async (_name, sourceId, deepWork) => {
      const sourceText = sourceId === "inventory-final_answer" ? finalText : earlierText;
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const sessionKey = `agent:main:dashboard:reply-reveal-${sourceId}`;
        const settledRunId = "museum-inventory-run";
        const earlierWork = deepWork
          ? Array.from({ length: 32 }, (_, index) => ({
              role: index % 2 === 1 ? "assistant" : "toolResult",
              ...(index % 2 === 1
                ? {}
                : { toolName: "read", toolCallId: `inventory-read-${index}` }),
              content: `Inspecting museum room ${index + 1}.`,
              timestamp: 1_800_000_000_001 + index,
              __openclaw: { id: `inventory-work-${index}`, seq: index + 2 },
            }))
          : [];
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const gateway = await installMockGateway(page, {
          sessionKey,
          historyMessages: [
            {
              role: "user",
              content: "Prepare the museum inventory.",
              timestamp: 1_800_000_000_000,
              __openclaw: {
                id: "inventory-prompt",
                seq: 1,
                ...(!deepWork ? { idempotencyKey: `${settledRunId}:user` } : {}),
              },
            },
            ...earlierWork,
            {
              role: "toolResult",
              toolName: "read",
              toolCallId: "inventory-earlier-read",
              ...(!deepWork ? { runId: settledRunId } : {}),
              content: earlierText,
              timestamp: 1_800_000_000_001 + earlierWork.length,
              __openclaw: { id: "inventory-earlier", seq: 2 + earlierWork.length },
            },
            {
              role: "assistant",
              phase: "final_answer",
              stopReason: "stop",
              ...(!deepWork ? { runId: settledRunId } : {}),
              content: finalText,
              timestamp: 1_800_000_000_002 + earlierWork.length,
              __openclaw: { id: "inventory-final_answer", seq: 3 + earlierWork.length },
            },
          ],
        });
        const pane = page.locator(".chat-pane-cache__pane--active");
        const source = pane.locator(`.chat-bubble[data-entry-id="${sourceId}"]`);
        const earlierMessage = pane.locator('.chat-bubble[data-entry-id="inventory-earlier"]');
        const workToggle = pane.locator(".chat-work-group > button").last();
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await polledAttribute(workToggle, "aria-expanded").toBe("false");
        expect(await earlierMessage.count()).toBe(0);

        const composer = pane.locator(".agent-chat__composer-combobox textarea");
        await composer.focus();
        const shortcut = await page.evaluate(() =>
          /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta+f" : "Control+f",
        );
        await page.keyboard.press(shortcut);
        const search = pane.getByRole("textbox", { name: "Search messages", exact: true });
        await search.fill(sourceText);
        await polledCount(pane.locator('.chat-bubble[data-entry-id="inventory-prompt"]')).toBe(0);
        await source.waitFor({ state: "visible" });
        if (sourceId === "inventory-earlier") {
          await source.locator(".chat-tool-msg-summary").click();
        }
        await source.click({ button: "right" });
        await page
          .locator(".chat-reply-context-menu")
          .getByRole("menuitem", { name: "Reply to message", exact: true })
          .click();
        await polledText(pane.locator(".chat-reply-preview__text")).toBe(sourceText);

        const followup = "Please explain that step in more detail.";
        await composer.fill(followup);
        await exactButton(pane, "Send message").click();
        const params = requireRecord((await gateway.waitForRequest("chat.send")).params);
        expect(params).toMatchObject({ sessionKey, message: followup, replyToId: sourceId });
        await expect.poll(() => composer.inputValue()).toBe("");
        await exactButton(pane, "Stop generating").waitFor({ state: "visible" });
        await gateway.emitChatFinal({
          sessionKey,
          runId: requireString(params.idempotencyKey, "reply run ID"),
          text: "Here is more detail about the inventory step.",
        });
        await exactButton(pane, "Close search").click();
        await polledAttribute(workToggle, "aria-expanded").toBe("false");
        expect(await earlierMessage.count()).toBe(0);
        const preview = pane.locator(".chat-reply-attribution--inline");

        await preview.getByRole("button").click();
        await pane
          .locator(`[data-entry-id="${sourceId}"].chat-bubble--reply-target`)
          .waitFor({ state: "visible" });
        await expect
          .poll(() =>
            source.evaluate((element, isDeep) => {
              const thread = element.closest(".chat-thread");
              if (!thread) {
                throw new Error("Reply target is outside the transcript");
              }
              const target = element.getBoundingClientRect();
              const viewport = thread.getBoundingClientRect();
              return {
                vertical:
                  Math.min(target.bottom, viewport.bottom) > Math.max(target.top, viewport.top),
                horizontal:
                  Math.min(target.right, viewport.right) > Math.max(target.left, viewport.left),
                deep: !isDeep || thread.scrollTop > thread.clientHeight,
              };
            }, deepWork),
          )
          .toEqual({ vertical: true, horizontal: true, deep: true });
        expect(await source.textContent()).toContain(sourceText);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        expect(pageErrors).toEqual([]);
      });
    },
  );
});
