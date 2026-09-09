import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "side chat multiline",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:multiline-proof";
const secondSessionKey = "agent:main:second-draft";
const askMethod = "sessions.companion.ask";
const firstQuestion = "First paragraph.\nSecond paragraph.";
const retryQuestion = "Keep the first paragraph.\n\nKeep the second paragraph.";
const selectedText =
  "Review the deployment checklist and explain which checks protect the pending release before the final verification step.";
const mainDraft = "Main draft.\nKeep this paragraph.";

function activePane(page: Page) {
  return page.locator('openclaw-chat-pane[aria-hidden="false"]');
}

function mainComposer(page: Page) {
  return activePane(page).locator(
    ".agent-chat__composer-combobox > textarea:not(.chat-session-rail__input)",
  );
}

function sideChat(page: Page) {
  return activePane(page).locator("openclaw-chat-session-rail");
}

async function editorGeometry(input: Locator) {
  return input.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      height: element.clientHeight,
      width: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      scrollTop: element.scrollTop,
      maxHeight: style.maxHeight,
      lineHeight: style.lineHeight,
      overflowY: style.overflowY,
      left: rect.left,
      right: rect.right,
    };
  });
}

async function withSideChat(
  width: number,
  scope: string,
  run: (fixture: {
    page: Page;
    gateway: MockGatewayControls;
    capture: (stage: string) => Promise<void>;
  }) => Promise<void>,
) {
  const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
  const artifactDir = artifactRoot
    ? createControlUiE2eArtifactDir(`side-chat-${scope}-${width}`, artifactRoot)
    : undefined;
  await suite.withPage(
    {
      locale: "en-US",
      viewport: { width, height: 800 },
      ...(artifactDir ? { recordVideo: { dir: artifactDir, size: { width, height: 800 } } } : {}),
    },
    async ({ page }) => {
      await page.addInitScript(() => {
        const events: object[] = [];
        Object.defineProperty(window, "sideChatInputEvents", { value: events });
        for (const type of [
          "compositionstart",
          "compositionupdate",
          "compositionend",
          "keydown",
          "keyup",
        ]) {
          document.addEventListener(type, (event) => {
            if (
              !(event.target instanceof Element) ||
              !event.target.matches(".chat-session-rail__input")
            ) {
              return;
            }
            if (event instanceof KeyboardEvent && event.key !== "Enter") {
              return;
            }
            events.push({
              type: event.type,
              trusted: event.isTrusted,
              prevented: event.defaultPrevented,
              ...(event instanceof KeyboardEvent
                ? { key: event.key, shift: event.shiftKey, composing: event.isComposing }
                : {}),
              ...(event instanceof CompositionEvent ? { data: event.data } : {}),
            });
          });
        }
      });
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [
          createControlUiSessionRow(sessionKey, "Paragraph questions", 2),
          createControlUiSessionRow(secondSessionKey, "Second draft", 1),
        ],
        historyMessages: [{ role: "assistant", content: selectedText }],
        methodResponses: {
          "sessions.companion.state": { exchanges: [] },
          [askMethod]: { answer: "Both paragraphs arrived together.", ts: 1_000 },
        },
      });
      const capture = async (stage: string) => {
        const input = sideChat(page).getByRole("textbox", { name: "Ask in side chat" });
        const ask = sideChat(page).getByRole("button", { name: "Ask", exact: true });
        const askBounds = await ask.boundingBox();
        // Rendered text, rather than textContent, detects collapsed paragraph breaks.
        const questions = await sideChat(page)
          .locator(".chat-session-rail__question")
          .allInnerTexts();
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, `${stage}.png`) });
          await writeFile(
            path.join(artifactDir, `${stage}.json`),
            JSON.stringify(
              {
                viewport: page.viewportSize(),
                draft: await input.inputValue(),
                geometry: await editorGeometry(input),
                askBounds,
                askDisabled: await ask.isDisabled(),
                inputDisabled: await input.isDisabled(),
                inputFocused: await input.evaluate((element) => document.activeElement === element),
                inputEvents: await page.evaluate(() => Reflect.get(window, "sideChatInputEvents")),
                layout: await input.evaluate((element) => {
                  const nodes = [];
                  for (let node: Element | null = element; node; node = node.parentElement) {
                    const style = getComputedStyle(node);
                    const rect = node.getBoundingClientRect();
                    nodes.push({
                      tag: node.tagName,
                      class: node.className,
                      top: rect.top,
                      bottom: rect.bottom,
                      height: rect.height,
                      minHeight: style.minHeight,
                      flex: style.flex,
                      overflowY: style.overflowY,
                    });
                  }
                  return nodes;
                }),
                questions,
                requests: await gateway.getRequests(askMethod),
              },
              null,
              2,
            ),
          );
        }
        expect(askBounds).not.toBeNull();
        expect(askBounds!.y).toBeGreaterThanOrEqual(0);
        expect(askBounds!.y + askBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
        expect(askBounds!.x).toBeGreaterThanOrEqual(0);
        expect(askBounds!.x + askBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      };
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await mainComposer(page).fill("Main draft.");
      await mainComposer(page).press("Shift+Enter");
      await mainComposer(page).pressSequentially("Keep this paragraph.");
      expect(await mainComposer(page).inputValue()).toBe(mainDraft);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await openChatSidePanelType(page, "Side chat");
      await sideChat(page).getByRole("textbox", { name: "Ask in side chat" }).waitFor();
      await run({ page, gateway, capture });
    },
  );
}

suite.define(() => {
  it.each([1200, 560])("sends paragraphs once and recovers from failure at %spx", async (width) => {
    await withSideChat(width, "submission", async ({ page, gateway, capture }) => {
      const companion = sideChat(page);
      const input = companion.getByRole("textbox", { name: "Ask in side chat" });
      const ask = companion.getByRole("button", { name: "Ask", exact: true });
      await input.fill(" ");
      await input.press("Shift+Enter");
      await input.press("Enter");
      expect(await ask.isDisabled()).toBe(true);
      expect(await gateway.getRequests(askMethod)).toHaveLength(0);

      await input.fill("First paragraph.");
      const shortHeight = await input.evaluate((element) => element.clientHeight);
      await input.press("Shift+Enter");
      await input.pressSequentially("Second paragraph.");
      expect(await input.inputValue()).toBe(firstQuestion);
      expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await mainComposer(page).inputValue()).toBe(mainDraft);
      expect(await gateway.getRequests(askMethod)).toHaveLength(0);
      await expect
        .poll(() => input.evaluate((element) => element.clientHeight))
        .toBeGreaterThan(shortHeight);
      await capture("01-paragraphs");

      // These are controlled browser composition events, not an operating-system IME session.
      await input.dispatchEvent("compositionstart", { data: "" });
      await input.dispatchEvent("compositionupdate", { data: "文" });
      for (const shiftKey of [false, true]) {
        await input.dispatchEvent("keydown", {
          key: "Enter",
          isComposing: true,
          shiftKey,
          bubbles: true,
        });
        await input.dispatchEvent("keyup", {
          key: "Enter",
          isComposing: true,
          shiftKey,
          bubbles: true,
        });
      }
      await input.dispatchEvent("compositionend", { data: "文" });
      expect(await gateway.getRequests(askMethod)).toHaveLength(0);
      expect(await input.inputValue()).toBe(firstQuestion);
      expect(await input.evaluate((element) => element === document.activeElement)).toBe(true);
      await capture("01b-composition");

      const beforeEnter = (await gateway.getRequests(askMethod)).length;
      await input.press("Enter");
      const entered = await gateway.waitForRequest(askMethod, { after: beforeEnter });
      expect(entered.params).toEqual({ sessionKey, agentId: "main", question: firstQuestion });
      await companion.getByText("Both paragraphs arrived together.", { exact: true }).waitFor();
      await expect
        .poll(() => {
          // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- Visible paragraph boundaries are the regression contract.
          return companion.locator(".chat-session-rail__question").innerText();
        })
        .toBe(firstQuestion);
      await expect.poll(() => input.inputValue()).toBe("");
      await expect.poll(() => input.evaluate((element) => element.clientHeight)).toBe(shortHeight);
      expect(await gateway.getRequests(askMethod)).toHaveLength(beforeEnter + 1);
      await capture("02-enter-success");

      await input.fill("Keep the first paragraph.");
      await input.press("Shift+Enter");
      await input.press("Shift+Enter");
      await input.pressSequentially("Keep the second paragraph.");
      await gateway.deferNext(askMethod);
      const beforeAsk = (await gateway.getRequests(askMethod)).length;
      await ask.click();
      const asked = await gateway.waitForRequest(askMethod, { after: beforeAsk });
      expect(asked.params).toEqual({ sessionKey, agentId: "main", question: retryQuestion });
      const pending = companion.locator(".chat-session-rail__exchange--pending");
      await expect
        .poll(() => {
          // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- Pending bubbles must visibly preserve paragraphs too.
          return pending.locator(".chat-session-rail__question").innerText();
        })
        .toBe(retryQuestion);
      expect(await input.isDisabled()).toBe(true);
      expect(await ask.isDisabled()).toBe(true);
      expect(await input.inputValue()).toBe("");
      await expect.poll(() => input.evaluate((element) => element.clientHeight)).toBe(shortHeight);
      const askBounds = await ask.boundingBox();
      expect(askBounds).not.toBeNull();
      await page.mouse.click(
        askBounds!.x + askBounds!.width / 2,
        askBounds!.y + askBounds!.height / 2,
      );
      await page.keyboard.press("Enter");
      expect(await gateway.getRequests(askMethod)).toHaveLength(beforeAsk + 1);
      await capture("03-pending");

      await gateway.rejectDeferred(askMethod, {
        code: "UNAVAILABLE",
        message: "Please try again.",
        retryable: true,
      });
      const failed = companion.locator(".chat-session-rail__exchange--error");
      await expect
        .poll(() => {
          // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- Failed questions must retain their visible blank line.
          return failed.locator(".chat-session-rail__question").innerText();
        })
        .toBe(retryQuestion);
      await expect.poll(() => input.isEnabled()).toBe(true);
      await capture("04-retryable-error");
      await gateway.deferNext(askMethod);
      const beforeRetry = (await gateway.getRequests(askMethod)).length;
      await failed.getByRole("button", { name: "Retry", exact: true }).click();
      const retried = await gateway.waitForRequest(askMethod, { after: beforeRetry });
      expect(retried.params).toEqual(asked.params);
      await gateway.resolveDeferred(askMethod, {
        answer: "The retry preserved both paragraphs.",
        ts: 2_000,
      });
      await companion.getByText("The retry preserved both paragraphs.", { exact: true }).waitFor();
      expect(await companion.locator(".chat-session-rail__question").allInnerTexts()).toEqual([
        firstQuestion,
        retryQuestion,
      ]);
      expect(await failed.count()).toBe(0);
      expect(await pending.count()).toBe(0);
      expect(await gateway.getRequests(askMethod)).toHaveLength(beforeRetry + 1);
      await capture("05-retry-success");

      await input.fill("After reconnect.\nAsk once.");
      const beforeOffline = (await gateway.getRequests(askMethod)).length;
      await gateway.setOnline(false);
      await expect.poll(() => input.isDisabled()).toBe(true);
      expect(await ask.isDisabled()).toBe(true);
      const offlineAskBounds = await ask.boundingBox();
      expect(offlineAskBounds).not.toBeNull();
      await page.mouse.click(
        offlineAskBounds!.x + offlineAskBounds!.width / 2,
        offlineAskBounds!.y + offlineAskBounds!.height / 2,
      );
      await page.keyboard.press("Enter");
      expect(await input.inputValue()).toBe("After reconnect.\nAsk once.");
      expect(await gateway.getRequests(askMethod)).toHaveLength(beforeOffline);
      await capture("06-disconnected");
      await gateway.setMethodResponse("sessions.companion.state", {
        exchanges: [
          { question: firstQuestion, answer: "Both paragraphs arrived together.", ts: 1_000 },
          { question: retryQuestion, answer: "The retry preserved both paragraphs.", ts: 2_000 },
        ],
      });
      await gateway.setMethodResponse(askMethod, {
        answer: "Reconnected and answered.",
        ts: 3_000,
      });
      await gateway.setOnline(true);
      await expect.poll(() => input.isEnabled()).toBe(true);
      expect(await input.inputValue()).toBe("After reconnect.\nAsk once.");
      await ask.click();
      const reconnected = await gateway.waitForRequest(askMethod, { after: beforeOffline });
      expect(reconnected.params).toEqual({
        sessionKey,
        agentId: "main",
        question: "After reconnect.\nAsk once.",
      });
      await companion.getByText("Reconnected and answered.", { exact: true }).waitFor();
      expect(await companion.locator(".chat-session-rail__question").allInnerTexts()).toEqual([
        firstQuestion,
        retryQuestion,
        "After reconnect.\nAsk once.",
      ]);
      expect(await gateway.getRequests(askMethod)).toHaveLength(beforeOffline + 1);
      await expect.poll(() => input.inputValue()).toBe("");
      await capture("07-reconnected-ask-success");

      expect(await mainComposer(page).inputValue()).toBe(mainDraft);
      await mainComposer(page).press("Enter");
      const mainSend = await gateway.waitForRequest("chat.send", { after: 0 });
      expect(mainSend.params).toMatchObject({ sessionKey, message: mainDraft });
      if (
        !mainSend.params ||
        typeof mainSend.params !== "object" ||
        !("idempotencyKey" in mainSend.params) ||
        typeof mainSend.params.idempotencyKey !== "string"
      ) {
        throw new Error("chat.send did not include its request identifier");
      }
      await gateway.emitChatFinal({
        sessionKey,
        runId: mainSend.params.idempotencyKey,
        text: "Main composer still works.",
      });
      await activePane(page)
        .locator(".chat-thread-inner")
        .getByText("Main composer still works.", { exact: true })
        .waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      expect(await gateway.getRequests(askMethod)).toHaveLength(beforeOffline + 1);
      await capture("08-main-composer-success");
    });
  });

  it.each([1200, 560])(
    "keeps drafts bounded through prefill, resize, and session changes at %spx",
    async (width) => {
      await withSideChat(width, "layout", async ({ page, gateway, capture }) => {
        const input = sideChat(page).getByRole("textbox", { name: "Ask in side chat" });
        await input.fill("Short.");
        const shortHeight = await input.evaluate((element) => element.clientHeight);
        const wrappedDraft = "Explain the changes and the remaining verification steps. ".repeat(5);
        await input.fill(wrappedDraft);
        await expect
          .poll(() => input.evaluate((element) => element.clientHeight))
          .toBeGreaterThan(shortHeight);
        expect(
          await input.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true);
        await capture("01-wrapped");
        await input.fill("A line of context.\n".repeat(20));
        await expect
          .poll(() => input.evaluate((element) => element.scrollHeight > element.clientHeight + 1))
          .toBe(true);
        const capped = await editorGeometry(input);
        // At the fixture's default 16px type, the unchanged cap is six 24px lines plus 8px of insets.
        expect(capped.lineHeight).toBe("24px");
        expect(capped.height).toBeLessThanOrEqual(152);
        expect(capped.height).toBeGreaterThan(shortHeight);
        expect(capped.overflowY).toBe("auto");
        await input.press("ControlOrMeta+End");
        await expect.poll(() => input.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await capture("02-bounded-scrolling");
        await input.press("ControlOrMeta+A");
        await input.press("Backspace");
        await input.pressSequentially("Short.");
        await expect
          .poll(() => input.evaluate((element) => element.clientHeight))
          .toBe(shortHeight);
        expect(await input.evaluate((element) => element.scrollTop)).toBe(0);

        await input.fill("");
        await input.pressSequentially("a".repeat(198));
        await input.press("Shift+Enter");
        await input.pressSequentially("b".repeat(201));
        await input.pressSequentially("overflow");
        expect(await input.inputValue()).toBe(`${"a".repeat(198)}\n${"b".repeat(201)}`);
        expect(await input.inputValue()).toHaveLength(400);
        expect(await gateway.getRequests(askMethod)).toHaveLength(0);
        await capture("03-native-character-limit");

        await input.fill("Short.");
        const text = activePane(page)
          .locator(".chat-bubble .chat-text p")
          .filter({ hasText: selectedText });
        const popup = page.getByRole("toolbar", { name: "Selection actions" });
        const select = async () => {
          // The established selection fixture uses the browser Selection API; activation remains a visible click.
          await text.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          });
          await text.dispatchEvent("pointerup", { button: 0, pointerType: "mouse" });
          await popup.waitFor({ state: "visible" });
        };
        await select();
        await page.keyboard.press("Escape");
        await popup.waitFor({ state: "detached" });
        expect(await input.inputValue()).toBe("Short.");
        await select();
        await popup.getByRole("button", { name: "Ask in side chat", exact: true }).click();
        const prefill = `Regarding "${selectedText}": `;
        await expect.poll(() => input.inputValue()).toBe(prefill);
        await expect
          .poll(() => input.evaluate((element) => element.clientHeight))
          .toBeGreaterThan(shortHeight);
        expect(await mainComposer(page).inputValue()).toBe(mainDraft);
        expect(await gateway.getRequests(askMethod)).toHaveLength(0);
        await capture("04-prefill");

        const resizeDraft =
          "Compare the completed checks with the remaining tasks and explain the next verification step before publishing the release.";
        await input.fill(resizeDraft);
        await expect
          .poll(() => input.evaluate((element) => element.clientHeight))
          .toBeGreaterThan(shortHeight);
        const beforeResize = await editorGeometry(input);
        const divider = page.getByRole("separator", { name: "Resize side panel" });
        if (width === 1200) {
          await divider.waitFor({ state: "visible" });
          const bounds = await divider.boundingBox();
          expect(bounds).not.toBeNull();
          await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
          await page.mouse.down();
          await page.mouse.move(bounds!.x + 180, bounds!.y + bounds!.height / 2, { steps: 5 });
          await page.mouse.up();
          await expect
            .poll(() => input.evaluate((element) => element.clientWidth))
            .toBeLessThan(beforeResize.width);
        } else {
          expect(await divider.isVisible()).toBe(false);
          await page.setViewportSize({ width: 400, height: 800 });
          await expect
            .poll(() => input.evaluate((element) => element.clientWidth))
            .toBeLessThan(beforeResize.width);
        }
        expect(await input.inputValue()).toBe(resizeDraft);
        await expect
          .poll(() => input.evaluate((element) => element.clientHeight))
          .toBeGreaterThan(beforeResize.height);
        await expect
          .poll(() =>
            input.evaluate(
              (element) =>
                element.scrollHeight <= element.clientHeight + 1 ||
                getComputedStyle(element).overflowY === "auto",
            ),
          )
          .toBe(true);
        expect(
          await input.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true);
        expect(await input.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(152);
        await capture("05-resized");
        await page.setViewportSize({ width, height: 800 });
        await input.fill(wrappedDraft);

        await activePane(page)
          .locator('[data-region-header="side"]')
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await input.waitFor({ state: "hidden" });
        await activePane(page).locator(".chat-side-panel-toggle").click();
        await input.waitFor({ state: "visible" });
        expect(await input.inputValue()).toBe(wrappedDraft);
        await expect
          .poll(() => input.evaluate((element) => element.clientHeight))
          .toBeGreaterThan(shortHeight);
        await capture("06-reopened");
        await activePane(page)
          .locator('[data-region-header="side"]')
          .getByRole("button", { name: "Close Side chat", exact: true })
          .click();
        await input.waitFor({ state: "detached" });
        await openChatSidePanelType(page, "Side chat");
        await expect.poll(() => input.inputValue()).toBe(wrappedDraft);
        await expect
          .poll(() => input.evaluate((element) => element.clientHeight))
          .toBeGreaterThan(shortHeight);
        await capture("07-reattached");

        const selectSession = async (key: string) => {
          const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
          const expandSidebar = activePane(page).getByRole("button", {
            name: "Expand sidebar",
            exact: true,
          });
          if (await expandSidebar.isVisible()) {
            await expandSidebar.click();
            await page.locator(".nav-drawer").waitFor();
          }
          await row.locator("a.sidebar-recent-session__link").click();
          await expect
            .poll(() => row.getAttribute("class"))
            .toContain("sidebar-recent-session--active");
        };
        await selectSession(secondSessionKey);
        await activePane(page).locator(".chat-side-panel-toggle").click();
        await activePane(page)
          .locator(".side-panel-empty__type")
          .filter({ hasText: "Side chat" })
          .click();
        await expect.poll(() => input.inputValue()).toBe("");
        await input.fill("Second session.");
        await expect
          .poll(() => input.evaluate((element) => element.clientHeight))
          .toBe(shortHeight);
        await selectSession(sessionKey);
        await input.waitFor({ state: "visible" });
        await expect.poll(() => input.inputValue()).toBe(wrappedDraft);
        await expect
          .poll(() => input.evaluate((element) => element.clientHeight))
          .toBeGreaterThan(shortHeight);
        expect(await mainComposer(page).inputValue()).toBe(mainDraft);
        await capture("08-restored-session");
        await selectSession(secondSessionKey);
        await expect.poll(() => input.inputValue()).toBe("Second session.");
        await expect
          .poll(() => input.evaluate((element) => element.clientHeight))
          .toBe(shortHeight);
        expect(await gateway.getRequests(askMethod)).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await capture("09-second-session");

        await selectSession(sessionKey);
        for (const starter of await sideChat(page).locator(".chat-session-rail__starter").all()) {
          await starter.hover();
        }
        await capture("10-long-question-ready");
        await gateway.setMethodResponse(askMethod, {
          answer: "The long question arrived.",
          ts: 4_000,
        });
        await sideChat(page).getByRole("button", { name: "Ask", exact: true }).click();
        const longQuestion = await gateway.waitForRequest(askMethod, { after: 0 });
        expect(longQuestion.params).toEqual({
          sessionKey,
          agentId: "main",
          question: wrappedDraft.trim(),
        });
        await sideChat(page).getByText("The long question arrived.", { exact: true }).waitFor();
        expect(await gateway.getRequests(askMethod)).toHaveLength(1);
        await capture("11-long-question-sent");

        await selectSession(secondSessionKey);
        await input.fill(wrappedDraft);
        await sideChat(page).getByRole("button", { name: "What's left?", exact: true }).click();
        const starterQuestion = await gateway.waitForRequest(askMethod, { after: 1 });
        expect(starterQuestion.params).toEqual({
          sessionKey: secondSessionKey,
          agentId: "main",
          question: "What's left?",
        });
        await sideChat(page).getByText("The long question arrived.", { exact: true }).waitFor();
        expect(await gateway.getRequests(askMethod)).toHaveLength(2);
        await capture("12-starter-success");
      });
    },
  );
});
