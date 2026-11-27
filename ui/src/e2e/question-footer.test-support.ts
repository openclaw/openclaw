import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import type { Question, QuestionRecord, QuestionResolveResult } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  recordControlUiE2eFailureFacts,
} from "../test-helpers/control-ui-e2e-diagnostics.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openDetailsPullRequests } from "./chat-details.test-support.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { waitForWatchedSessionKey } from "./chat-github-publication.test-support.ts";

type QuestionFooterFixtures = {
  artifactDir: () => string;
  openQuestionPage: (
    viewport: { height: number; width: number },
    hasTouch: boolean,
  ) => Promise<{ gateway: MockGatewayControls; page: Page }>;
  questionRecord: (id: string, questions: Question[]) => QuestionRecord;
  questionSessionKey: string;
};

export function defineQuestionFooterTests({
  artifactDir,
  openQuestionPage,
  questionRecord,
  questionSessionKey,
}: QuestionFooterFixtures) {
  it("keeps the message box reachable beside an expanded question and queued steer", async () => {
    const { gateway, page } = await openQuestionPage({ width: 1200, height: 797 }, false);
    await page.goto(`${new URL(page.url()).origin}/settings/appearance`);
    await page.locator("[data-settings-follow-up-mode]").selectOption("steer");
    await page.goto(controlUiSessionUrl(new URL(page.url()).origin + "/", questionSessionKey));
    const editor = page.locator(".agent-chat__composer-combobox > textarea");
    await editor.fill("Review the release plan");
    await editor.press("Enter");
    await gateway.waitForRequest("chat.send");
    await page.getByRole("button", { name: "Stop", exact: true }).waitFor();
    await editor.fill("Keep the existing verification work");
    await editor.press("Control+Enter");
    const queued = page.locator(".chat-queue__item", {
      hasText: "Keep the existing verification work",
    });
    await queued.waitFor();
    await editor.fill("A separate follow-up draft");
    const originalEditor = await editor.elementHandle();
    const request = questionRecord("question-with-steer", [
      {
        questionId: "proof_route",
        header: "Proof route",
        question: "Which route should the remote verification use?",
        options: [
          {
            label: "Use the existing test environment",
            description:
              "Continue the bounded verification without changing persistent configuration.",
          },
          {
            label: "Keep the current route",
            description: "Leave verification waiting until its existing environment is available.",
          },
        ],
        isOther: true,
      },
    ]);
    await gateway.emitGatewayEvent("question.requested", request);
    const panel = page.locator(".chat-question-panel");
    await panel.getByText(request.questions[0]!.question, { exact: true }).waitFor();
    await queued.waitFor();
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      const frame = await takeControlUiScreenshotFrame(
        page,
        page.locator(".agent-chat__composer-shell"),
        [panel, queued],
        { animations: "disabled" },
      );
      await writeFile(path.join(artifactDir(), "question-with-steer.png"), frame.png);
    }
    await editor.waitFor({ state: "visible", timeout: 2000 });
    expect(await editor.evaluate((node, original) => node === original, originalEditor)).toBe(true);
    expect(await editor.inputValue()).toBe("A separate follow-up draft");
    await editor.fill("I can still steer while answering");
    expect(await panel.getAttribute("class")).not.toContain("--collapsed");
    for (const viewport of [
      { width: 1200, height: 500 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expect
        .poll(() =>
          editor.evaluate((node) => {
            const box = node.getBoundingClientRect();
            return box.height > 0 && box.top >= 0 && box.bottom <= innerHeight;
          }),
        )
        .toBe(true);
      await editor.click({ trial: true });
    }
    await page.setViewportSize({ width: 1200, height: 797 });
    await editor.press("Control+Enter");
    await page
      .locator(".chat-queue__item", { hasText: "I can still steer while answering" })
      .waitFor();
    await queued.waitFor();
    expect(await panel.getAttribute("class")).not.toContain("--collapsed");
    expect(await gateway.getRequests("question.resolve")).toHaveLength(0);
  });

  it("keeps a collapsed question separate from PRs, notices, and the input in portrait and landscape", async () => {
    const { gateway, page } = await openQuestionPage({ height: 844, width: 390 }, true);
    for (const { height, width, orientation } of [
      { height: 844, orientation: "portrait", width: 390 },
      { height: 390, orientation: "landscape", width: 844 },
    ]) {
      await page.setViewportSize({ height, width });
      const sentCount = (await gateway.getRequests("chat.send")).length;
      const resolutionCount = (await gateway.getRequests("question.resolve")).length;
      const composer = page.locator(".agent-chat__input");
      const draft = composer.locator(".agent-chat__composer-combobox > textarea");
      await draft.fill("Review the footer controls");
      await draft.press("Enter");
      const sent = requireRecord(
        (await gateway.waitForRequest("chat.send", { after: sentCount })).params,
      );
      const runId = requireString(sent.idempotencyKey, "sent run ID");
      const errorMessage = `The ${orientation} verification run failed. Please try again.`;
      await gateway.emitGatewayEvent("chat", {
        sessionKey: questionSessionKey,
        runId,
        state: "error",
        errorMessage,
      });
      await page.locator(".chat-error").filter({ hasText: errorMessage }).waitFor();
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
      await closeChatDetails(page);
      await draft.fill("Keep this follow-up draft");
      const prompt = "Which progress note should I use?";
      const request = questionRecord(`question-mobile-context-${orientation}`, [
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
      if (width > height) {
        // A child tooltip consumes Escape; dismiss Details through its native owner.
        await composer.locator(".chat-send-btn--send").hover();
        await page.locator("openclaw-tooltip .tooltip-surface[popover]:popover-open").waitFor();
      }
      await closeChatDetails(page);
      // Closing Details animates the footer back into place before it can be tapped.
      await waitForLayoutSettled(page, ".chat-question-panel__collapsed-button");
      await expand.tap();
      try {
        await expect.poll(() => expand.count()).toBe(0);
        await expect.poll(() => composer.count()).toBe(1);
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
      expect(
        (await gateway.waitForRequest("question.resolve", { after: resolutionCount })).params,
      ).toEqual({
        id: request.id,
        answers,
      });
      await expect.poll(() => panel.count()).toBe(0);
      await composer.waitFor();
      expect(await draft.inputValue()).toBe("Keep this follow-up draft");
      await openDetailsPullRequests(page);
      await pullRequest.click({ trial: true });
      await closeChatDetails(page);
    }
  });
}
