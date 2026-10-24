import { withTimeout } from "@openclaw/fs-safe/advanced";
import type { Question, QuestionRecord, QuestionResolveResult } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import {
  captureControlUiE2eFailureDiagnostics,
  recordControlUiE2eFailureFacts,
} from "../test-helpers/control-ui-e2e-diagnostics.ts";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { openDetailsPullRequests } from "./chat-details.test-support.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";

type QuestionFooterFixtures = {
  openQuestionPage: (
    viewport: { height: number; width: number },
    hasTouch: boolean,
  ) => Promise<{ gateway: MockGatewayControls; page: Page }>;
  questionRecord: (id: string, questions: Question[]) => QuestionRecord;
  questionSessionKey: string;
};

export function defineQuestionFooterTests({
  openQuestionPage,
  questionRecord,
  questionSessionKey,
}: QuestionFooterFixtures) {
  it.each([
    { height: 844, orientation: "portrait", width: 390 },
    { height: 390, orientation: "landscape", width: 844 },
  ])(
    "keeps a collapsed question separate from PRs, notices, and the input on $orientation",
    async ({ height, width }) => {
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
      const pullRequests = await openDetailsPullRequests(page);
      const pullRequest = pullRequests.locator(".chat-pr-mobile__row");
      await pullRequest.waitFor();
      await page.keyboard.press("Escape");
      await draft.fill("Keep this follow-up draft");
      const prompt = "Which progress note should I use?";
      const request = questionRecord("question-mobile-context", [
        {
          questionId: "progress_note",
          header: "Progress note",
          question: prompt,
          options: [{ label: "Concise" }, { label: "Detailed" }],
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
        const layout = await shell.evaluate((element, viewportHeight) => {
          const get = (selector: string) => element.querySelector<HTMLElement>(selector)!;
          const question = get(".chat-question-panel--collapsed");
          const input = get(".agent-chat__input");
          const q = question.getBoundingClientRect();
          const i = input.getBoundingClientRect();
          const rounded = (node: Element, edge: string) =>
            ["left", "right"].every(
              (side) =>
                Number.parseFloat(
                  getComputedStyle(node).getPropertyValue(`border-${edge}-${side}-radius`),
                ) > 0,
            );
          const shellStyle = getComputedStyle(element);
          return {
            borderless: shellStyle.borderTopWidth === "0px",
            shadowless: shellStyle.boxShadow === "none",
            noPullRequests: element.querySelector(".chat-pr") === null,
            noticeBeforeQuestion: get(".chat-error").getBoundingClientRect().bottom <= q.top,
            contextBeforeInput: get(".chat-footer__context").getBoundingClientRect().bottom < i.top,
            inputInViewport: i.bottom <= viewportHeight,
            inputOutsideContext: !input.closest(".chat-footer__context"),
            touchTarget: question.querySelector("button")!.getBoundingClientRect().height >= 48,
            rounded: rounded(question, "bottom") && rounded(input, "top"),
          };
        }, height);
        expect(Object.entries(layout).filter(([, passed]) => !passed)).toEqual([]);
      }
      await openDetailsPullRequests(page);
      await pullRequest.click({ trial: true });
      await page.keyboard.press("Escape");
      await expand.tap();
      try {
        await expect.poll(() => composer.count()).toBe(0);
      } catch (error) {
        recordControlUiE2eFailureFacts(page, { questionFooterLandscape: width > height });
        await withTimeout(
          page.evaluate(() => {
            const details = document.querySelector<HTMLElement>(".chat-mobile-host");
            return {
              questionFooterComposerCount: document.querySelectorAll(".agent-chat__input").length,
              questionFooterCollapsedCount: document.querySelectorAll(
                ".chat-question-panel--collapsed",
              ).length,
              questionFooterExpandCount: document.querySelectorAll(
                ".chat-question-panel__collapsed-button",
              ).length,
              questionFooterDetailsHidden: details?.hidden ?? null,
              questionFooterDetailsVisible:
                details?.checkVisibility({ visibilityProperty: true }) ?? false,
            };
          }),
          1_000,
        )
          .then((facts) => recordControlUiE2eFailureFacts(page, facts))
          .catch(() => undefined);
        await captureControlUiE2eFailureDiagnostics(page, {
          error: error instanceof Error ? error : new Error(String(error)),
          label: "question footer expansion",
        });
        throw error;
      }
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
      await openDetailsPullRequests(page);
      await pullRequest.click({ trial: true });
      await page.keyboard.press("Escape");
    },
  );
}
