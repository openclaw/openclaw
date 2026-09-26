import { expect, it } from "vitest";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../pages/chat/scroll.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  chatThreadDistanceFromBottom,
  createChatFlowE2eSuite,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { progressSubmitScenario } from "./session-progress-submit.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    { width: 1440, progress: "collapsed" },
    { width: 390, progress: "expanded" },
    { width: 1440, progress: "absent" },
  ] as const)(
    "preserves question takeover, progress, and reader intent at $width with $progress progress",
    async ({ width, progress }) => {
      const context = await suite.newBrowserContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const scenario = progressSubmitScenario(true);
      const gateway = await installMockGateway(page, {
        ...scenario,
        featureMethods: [...scenario.featureMethods, "question.list", "question.resolve"],
        methodResponses: {
          ...scenario.methodResponses,
          ...(progress === "absent" ? { "progressCard.get": { card: null } } : {}),
          "question.list": { questions: [] },
          "question.resolve": { status: "cancelled" },
        },
      });
      const requestQuestion = (id: string) =>
        gateway.emitGatewayEvent("question.requested", {
          id,
          agentId: "main",
          sessionKey: scenario.sessionKey,
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          status: "pending",
          questions: [
            {
              questionId: "next_step",
              header: "Next step",
              question: "Which follow-up should we prioritize after reviewing the workspace?",
              options: ["Review", "Validate", "Summarize", "Pause"].map((label) => ({
                label,
                description: "Check the planned changes and record the remaining review steps.",
              })),
              isOther: true,
            },
          ],
        });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Keep this draft.");
        const progressCard = page.locator(".session-progress-card--composer");
        if (progress !== "absent") {
          await progressCard.waitFor();
          const open = await progressCard.evaluate(
            (element) => (element as HTMLDetailsElement).open,
          );
          if (open !== (progress === "expanded")) {
            await progressCard.locator("summary").click();
          }
        }
        await page.locator(".chat-thread").hover();
        await page.mouse.wheel(0, 10_000);
        await waitForChatScrollIdle(page);
        await expect
          .poll(() => chatThreadDistanceFromBottom(page))
          .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);

        await requestQuestion("question-progress-follow");
        const panel = page.locator(".chat-question-panel");
        await panel.waitFor();
        expect(await progressCard.isVisible()).toBe(false);
        expect(await composer.count()).toBe(0);
        expect(await panel.evaluate((element) => document.activeElement === element)).toBe(true);
        await waitForChatScrollIdle(page);
        await expect
          .poll(() => chatThreadDistanceFromBottom(page))
          .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
        await page.keyboard.press("3");
        expect(
          await panel.getByRole("radio", { name: /Summarize/ }).getAttribute("aria-checked"),
        ).toBe("true");
        await gateway.setMethodResponse("question.resolve", {
          status: "answered",
          answers: { answers: { next_step: ["Summarize"] } },
        });
        await page.keyboard.press("Enter");
        const resolved = await gateway.waitForRequest("question.resolve");
        expect(resolved.params).toEqual({
          id: "question-progress-follow",
          answers: { answers: { next_step: ["Summarize"] } },
        });
        await composer.waitFor();
        await waitForChatScrollIdle(page);
        await expect
          .poll(() => chatThreadDistanceFromBottom(page))
          .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
        expect(await composer.inputValue()).toBe("Keep this draft.");
        expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);

        const thread = page.locator(".chat-thread");
        await thread.hover();
        await page.mouse.wheel(0, -700);
        await waitForChatScrollIdle(page);
        await requestQuestion("question-progress-reader");
        await panel.waitFor();
        await thread.hover();
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(201); // Separate gestures exceed the disclosure burst boundary.
        await page.mouse.wheel(0, -200);
        await waitForChatScrollIdle(page);
        const readingOffset = await thread.evaluate((element) => element.scrollTop);
        await gateway.setMethodResponse("question.resolve", { status: "cancelled" });
        await panel.getByRole("button", { name: "Skip", exact: true }).click();
        await composer.waitFor();
        await waitForChatScrollIdle(page);
        expect(await thread.evaluate((element) => element.scrollTop)).toBeCloseTo(readingOffset, 0);
        await page.getByRole("button", { name: "Scroll to latest" }).waitFor();
        if (progress !== "absent") {
          expect(
            await progressCard.evaluate((element) => (element as HTMLDetailsElement).open),
          ).toBe(progress === "expanded");
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
