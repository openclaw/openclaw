import type { Question, QuestionRecord, QuestionResolveResult } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";

type QuestionFooterFixtures = {
  openQuestionPage: (
    viewport: { height: number; width: number },
    hasTouch: boolean,
  ) => Promise<{ gateway: MockGatewayControls; page: Page }>;
  questionRecord: (id: string, questions: Question[]) => QuestionRecord;
  questionSessionKey: string;
  screenshot: (page: Page, name: string) => Promise<void>;
};

export function defineQuestionFooterTests({
  openQuestionPage,
  questionRecord,
  questionSessionKey,
  screenshot,
}: QuestionFooterFixtures) {
  it.each([
    { height: 844, screenshotName: "portrait", width: 390 },
    { height: 390, screenshotName: "landscape", width: 844 },
  ])(
    "keeps a collapsed question separate from PRs, notices, and the input on $screenshotName",
    async ({ height, screenshotName, width }) => {
      const { gateway, page } = await openQuestionPage({ height, width }, true);
      const composer = page.locator(".agent-chat__input");
      const draft = composer.locator(".agent-chat__composer-combobox > textarea");
      await draft.fill("Review the footer controls");
      await draft.press("Enter");
      const sent = requireRecord((await gateway.waitForRequest("chat.send")).params);
      const runId = requireString(sent.idempotencyKey, "sent run ID");
      await gateway.emitGatewayEvent("chat", {
        sessionKey: questionSessionKey,
        runId,
        state: "error",
        errorMessage: "The verification run failed. Please try again.",
      });
      await page.locator(".chat-error").waitFor();
      const watchedKey = await waitForWatchedSessionKey(gateway, questionSessionKey);
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          [watchedKey]: {
            pullRequests: [
              {
                number: 42,
                owner: "example",
                repo: "demo",
                title: "Improve question layout",
                branch: "fix/question-layout",
                url: "https://github.com/example/demo/pull/42",
                state: "open",
              },
            ],
            rateLimited: false,
            status: "ready",
          },
        },
      });
      const pullRequest = page.locator(".chat-pr__link");
      await pullRequest.waitFor();
      await draft.fill("Keep this follow-up draft");
      const prompt = "Which progress note should I use?";
      const request = questionRecord("question-mobile-context", [
        {
          questionId: "progress_note",
          header: "Progress note",
          question: prompt,
          options: [
            { label: "Concise", description: "Keep the update short." },
            { label: "Detailed", description: "Include the supporting evidence." },
          ],
        },
      ]);
      await gateway.emitGatewayEvent("question.requested", request);
      const panel = page.locator("openclaw-chat-question-panel");
      await panel.getByText(prompt, { exact: true }).waitFor();
      await panel.locator(".chat-question-panel__collapse").tap();
      await composer.waitFor();
      expect(await draft.inputValue()).toBe("Keep this follow-up draft");

      const shell = page.locator(".agent-chat__composer-shell");
      const expand = panel.locator(".chat-question-panel__collapsed-button");
      for (const theme of ["dark", "light"]) {
        await page.evaluate((mode) => {
          document.documentElement.dataset.themeMode = mode;
        }, theme);
        await draft.focus();
        const layout = await shell.evaluate((element) => {
          const question = element.querySelector<HTMLElement>(".chat-question-panel--collapsed")!;
          const input = element.querySelector<HTMLElement>(".agent-chat__input")!;
          const row = element.querySelector<HTMLElement>(".chat-pr")!;
          const notice = element.querySelector<HTMLElement>(".chat-error")!;
          const stack = element.querySelector<HTMLElement>(".chat-footer__context")!;
          const questionStyle = getComputedStyle(question);
          const inputStyle = getComputedStyle(input);
          return {
            shellBorder: getComputedStyle(element).borderTopWidth,
            shellShadow: getComputedStyle(element).boxShadow,
            prBottom: row.getBoundingClientRect().bottom,
            noticeTop: notice.getBoundingClientRect().top,
            noticeBottom: notice.getBoundingClientRect().bottom,
            questionTop: question.getBoundingClientRect().top,
            contextBottom: stack.getBoundingClientRect().bottom,
            inputTop: input.getBoundingClientRect().top,
            inputBottom: input.getBoundingClientRect().bottom,
            questionBottomCorners: [
              questionStyle.borderBottomLeftRadius,
              questionStyle.borderBottomRightRadius,
            ],
            inputTopCorners: [inputStyle.borderTopLeftRadius, inputStyle.borderTopRightRadius],
            touchTargetHeight: question.querySelector("button")!.getBoundingClientRect().height,
            inputOutsideContext: !input.closest(".chat-footer__context"),
          };
        });
        expect(layout.shellBorder).toBe("0px");
        expect(layout.shellShadow).toBe("none");
        expect(layout.prBottom).toBeLessThanOrEqual(layout.noticeTop);
        expect(layout.noticeBottom).toBeLessThanOrEqual(layout.questionTop);
        expect(layout.contextBottom).toBeLessThan(layout.inputTop);
        expect(layout.inputBottom).toBeLessThanOrEqual(height);
        expect(layout.inputOutsideContext).toBe(true);
        expect(layout.touchTargetHeight).toBeGreaterThanOrEqual(48);
        for (const radius of [...layout.questionBottomCorners, ...layout.inputTopCorners]) {
          expect(Number.parseFloat(radius)).toBeGreaterThan(0);
        }
        await screenshot(
          page,
          "07-question-mobile-context-" + screenshotName + "-" + theme + ".png",
        );
      }
      await pullRequest.click({ trial: true });
      await expand.tap();
      await expect.poll(() => composer.count()).toBe(0);
      await panel.getByRole("radio", { name: /Concise/ }).tap();
      const answers = { answers: { progress_note: ["Concise"] } };
      await gateway.setMethodResponse("question.resolve", {
        status: "answered",
        answers,
      } satisfies QuestionResolveResult);
      await panel.getByRole("button", { name: "Submit", exact: true }).tap();
      expect((await gateway.waitForRequest("question.resolve")).params).toEqual({
        id: request.id,
        answers,
      });
      await expect.poll(() => panel.count()).toBe(0);
      await composer.waitFor();
      expect(await draft.inputValue()).toBe("Keep this follow-up draft");
      await pullRequest.click({ trial: true });
    },
  );
}
