import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "session companion retry" });
const unavailable = { code: "UNAVAILABLE", retryable: true };
const timeoutError = { ...unavailable, message: "Side chat timed out." };

suite.define(() => {
  it.each(["composer", "/btw", "/side"] as const)("retries %s failures in place", async (entry) => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:companion-retry";
      const mainAnswer = "The main conversation must remain visible.";
      const sideAnswer = "The earlier side answer must remain visible.";
      const question = "What should happen next?";
      const followup = "What should I verify?";
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: [{ role: "assistant", content: mainAnswer }],
        methodResponses: {
          "sessions.companion.state": {
            exchanges: [{ question: "What changed?", answer: sideAnswer, ts: 1000 }],
          },
          "sessions.companion.ask": {
            __mockError: {
              ...unavailable,
              message: "Session history is unavailable.",
              details: { reason: "context-unavailable" },
            },
          },
        },
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await page.getByText(mainAnswer, { exact: true }).waitFor();
      await openChatSidePanelType(page, "Side chat");
      const side = page.locator("openclaw-chat-session-rail");
      await side.getByText(sideAnswer, { exact: true }).waitFor();
      const pending = side.locator(".chat-session-rail__exchange--pending");
      const failed = side.locator(".chat-session-rail__exchange--error");
      const questionSelector = ".chat-group.user .chat-bubble";
      const composer =
        entry === "composer"
          ? side.getByRole("textbox")
          : page.getByRole("textbox", { name: "Chat composer", exact: true });
      const send = async (text: string) => {
        await composer.fill(entry === "composer" ? text : `${entry} ${text}`);
        await composer.press("Enter");
      };
      const questions = async () =>
        (await side.locator(questionSelector).allTextContents()).map((text) => text.trim());
      await send(question);
      await failed.waitFor();
      await gateway.deferNext("sessions.companion.ask");
      await send(followup);
      await pending.locator(".chat-working-indicator .chat-reading-indicator").waitFor();
      expect(await pending.locator(".chat-session-rail__hint").count()).toBe(0);
      expect(await questions()).toEqual(["What changed?", question, followup]);
      expect(await side.locator(".chat-session-rail__retry").isDisabled()).toBe(true);
      await gateway.rejectDeferred("sessions.companion.ask", timeoutError);
      await expect.poll(async () => failed.count()).toBe(2);
      await gateway.deferNext("sessions.companion.ask");
      await side.locator(".chat-session-rail__retry").first().click();
      await pending.waitFor();
      expect(await questions()).toEqual(["What changed?", question, followup]);
      expect(await pending.locator(questionSelector).textContent()).toContain(question);
      await gateway.resolveDeferred("sessions.companion.ask", {
        answer: "Retry recovered the answer.",
        ts: 2000,
      });
      await side.getByText("Retry recovered the answer.", { exact: true }).waitFor();
      expect(await questions()).toEqual(["What changed?", question, followup]);
      expect(await failed.locator(questionSelector).textContent()).toContain(followup);
      expect(await page.getByText(mainAnswer, { exact: true }).isVisible()).toBe(true);
      expect(await side.getByText(sideAnswer, { exact: true }).isVisible()).toBe(true);
      const requests = await gateway.getRequests("sessions.companion.ask");
      const ask = (text: string) => ({ sessionKey, agentId: "main", question: text });
      expect(requests.map(({ params }) => params)).toEqual([question, followup, question].map(ask));
      for (const method of ["chat.send", "sessions.reset", "sessions.companion.reset"]) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
      expect(errors).toEqual([]);
    });
  });
});
