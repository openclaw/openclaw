import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI reasoning visibility" });

suite.define(() => {
  it.each([
    { reasoningLevel: "off", withTools: false },
    { reasoningLevel: "on", withTools: false },
    { reasoningLevel: "stream", withTools: false },
    { reasoningLevel: "off", withTools: true },
    { reasoningLevel: "on", withTools: true },
    { reasoningLevel: "stream", withTools: true },
  ])("keeps reasoning in work: %o", async ({ reasoningLevel, withTools }) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const sessionKey = "agent:main:dashboard:reasoning-visibility";
      const reasoningText = "Compare the evidence before answering.";
      const code = 'const label = "*literal*";\n\nconsole.log(label);\n';
      const conclusion = "Compare both outputs.";
      const finalText = "The answer is ready.";
      const thinking = `${reasoningText}\n\n\`\`\`ts\n${code}\`\`\`\n\n${conclusion}`;
      const tool = { type: "toolCall", id: "read", name: "read" };
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessionInfo: { reasoningLevel },
        sessions: [{ key: sessionKey, kind: "direct", reasoningLevel }],
        historyMessages: [
          { role: "user", content: "Check the evidence." },
          ...["reasoning-1", "reasoning-2"].map((id) => ({
            role: "assistant",
            content: [{ type: "thinking", thinking }],
            __openclaw: { id },
          })),
          ...(withTools
            ? [
                { role: "assistant", content: [tool] },
                { role: "toolResult", toolCallId: "read", toolName: "read", content: "Read." },
              ]
            : []),
          { role: "assistant", content: [{ type: "text", text: finalText }] },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const answer = pane.getByText(finalText, { exact: true });
      const reasoningItems = pane.locator(".chat-thinking", { hasText: reasoningText });
      const reasoning = reasoningItems.first();
      const worked = pane.locator(".chat-work-group > .chat-activity-group__summary");

      for (const reload of [false, true]) {
        if (reload) {
          await page.reload();
        }
        await answer.waitFor();
        await expect.poll(() => reasoning.isVisible()).toBe(false);
        if (withTools || reasoningLevel === "on") {
          await worked.click();
          await expect.poll(() => worked.getAttribute("aria-expanded")).toBe("true");
        } else {
          expect(await worked.count()).toBe(0);
        }
        await expect.poll(() => reasoning.isVisible()).toBe(reasoningLevel === "on");
        if (reasoningLevel === "on") {
          expect(await reasoningItems.count()).toBe(2);
          expect(await reasoningItems.locator("pre code").allTextContents()).toEqual([code, code]);
          expect(await reasoningItems.locator("p").allTextContents()).toEqual([
            "Reasoning:",
            reasoningText,
            conclusion,
            "Reasoning:",
            reasoningText,
            conclusion,
          ]);
        }
        expect(await answer.isVisible()).toBe(true);
      }

      const menuTrigger = pane.locator(".chat-header-session-menu__trigger");
      const menu = pane.locator("openclaw-chat-header-session-menu > .chat-header-session-menu");
      const toggle = menu.getByRole("menuitemcheckbox", { name: "Reasoning" });
      for (const showReasoning of [false, true]) {
        await menuTrigger.click();
        await menu.getByRole("menuitem", { name: "View", exact: true }).click();
        await toggle.click();
        await expect.poll(() => toggle.getAttribute("aria-checked")).toBe(String(showReasoning));
        await menuTrigger.click();
        await expect
          .poll(() => reasoning.isVisible())
          .toBe(showReasoning && reasoningLevel === "on");
        expect(await answer.isVisible()).toBe(true);
      }
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    });
  });
});
