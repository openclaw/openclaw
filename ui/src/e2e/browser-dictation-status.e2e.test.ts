import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  captureComposerProof,
  installTalkBrowserFixtures,
  TALK_READY_HISTORY_MESSAGE,
  waitForTalkReady,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

function catalog(transcription: boolean, realtime?: boolean) {
  return {
    transcription: { ready: transcription, providers: [] },
    realtime: { ...(realtime === undefined ? {} : { ready: realtime }), providers: [] },
    speech: { providers: [] },
    modes: [],
    transports: [],
    brains: [],
  };
}

const sessionId = "dictation-test";
function createDictationMethodResponses() {
  return {
    "talk.catalog": catalog(true),
    "talk.session.create": {
      sessionId,
      transcriptionSessionId: sessionId,
      audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
    },
  };
}

const suite = createControlUiE2eSuite({
  name: "Control UI browser dictation status",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

async function openDictation(
  page: Page,
  {
    route = "chat",
    ...options
  }: Parameters<typeof installMockGateway>[1] & {
    route?: "chat" | "new";
  } = {},
) {
  const gateway = await installMockGateway(page, {
    deferredMethods: ["talk.session.create"],
    ...(route === "new"
      ? {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.create", "sessions.dispatch"],
        }
      : {}),
    ...options,
    methodResponses: createDictationMethodResponses(),
  });
  await installTalkBrowserFixtures(page);
  await page.goto(`${suite.server.baseUrl}${route}`);
  return {
    gateway,
    textarea: page.locator(
      route === "new" ? ".new-session-page__message" : ".agent-chat__composer-combobox textarea",
    ),
    admit: async () => {
      await gateway.waitForRequest("talk.session.create");
      await gateway.resolveDeferred("talk.session.create");
    },
    emit: (text: string, final = false, id = sessionId) =>
      gateway.emitGatewayEvent("talk.event", {
        transcriptionSessionId: id,
        type: final ? "transcript" : "partial",
        text,
        ...(final ? { final: true } : {}),
      }),
    close: () =>
      gateway.emitGatewayEvent("talk.event", {
        transcriptionSessionId: sessionId,
        type: "close",
        reason: "completed",
      }),
  };
}

async function captureFullPage(page: Page, name: string) {
  await page.screenshot({
    animations: "disabled",
    path: path.join(suite.artifactDir, `voice-controls/${name}.png`),
  });
}

const captureComposer = (page: Page, name: string) => captureComposerProof(suite, page, name);
const isFocused = (locator: Locator) =>
  locator.evaluate((element) => document.activeElement === element);
const readOnly = (locator: Locator) =>
  locator.evaluate((element: HTMLTextAreaElement) => element.readOnly);
const button = (page: Page, name: string, exact = false) =>
  page.getByRole("button", { name, exact });
const expectDraft = async (textarea: Locator, value: string) => {
  await expect.poll(() => textarea.inputValue()).toBe(value);
};

suite.define(() => {
  it.each([false, true])(
    "dictates during a running turn and sends explicitly (wait for completion: %s)",
    (waitForCompletion) =>
      suite.withPage(
        { permissions: ["microphone"], viewport: { width: 390, height: 844 } },
        async ({ page }) => {
          const { gateway, textarea, admit, emit, close } = await openDictation(page, {
            heldMethods: ["chat.send"],
            sessionInfo: {
              key: "agent:main:main",
              activeRunIds: ["active-dictation-run"],
              hasActiveRun: true,
            },
            inFlightRun: {
              runId: "active-dictation-run",
              text: "I’m reviewing the next steps.",
            },
          });
          const microphone = button(page, "Dictation", true);
          await button(page, "Stop generating", true).waitFor();
          await page
            .locator('[data-chat-talk-capability="dictation"]')
            .waitFor({ state: "detached" });
          const capture = async (stage: string) => {
            const surface = page.locator(".agent-chat__composer-shell");
            const frame = await takeControlUiScreenshotFrame(page, surface, [textarea], {
              animations: "disabled",
            });
            await writeFile(
              path.join(suite.artifactDir, `${stage}-${waitForCompletion}.png`),
              frame.png,
            );
          };
          await capture("active-turn-microphone");
          expect(await microphone.isEnabled()).toBe(true);
          await microphone.click();
          await admit();
          await emit("Please check the tests too.");
          await expectDraft(textarea, "Please check the tests too.");
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          if (waitForCompletion) {
            await gateway.emitChatFinal({
              runId: "active-dictation-run",
              text: "Review complete.",
            });
            await page
              .locator(".chat-bubble")
              .getByText("Review complete.", { exact: true })
              .waitFor();
            await button(page, "Stop and keep text", true).click();
            await gateway.waitForRequest("talk.session.close");
            await close();
            await expectDraft(textarea, "Please check the tests too.");
            expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          }
          await capture("dictated-draft");
          await button(page, waitForCompletion ? "Send message" : "Send", true).click();
          if (!waitForCompletion) {
            await gateway.waitForRequest("talk.session.close");
            await close();
          }
          const request = await gateway.waitForRequest("chat.send");
          expect(request.params).toMatchObject({ message: "Please check the tests too." });
          await expectDraft(textarea, "");
          // The local user bubble acknowledges Send before the held Gateway ACK.
          await page
            .locator(".chat-bubble")
            .getByText("Please check the tests too.", { exact: true })
            .waitFor();
          await capture("dictation-send-pending");
          expect(await gateway.getRequests("chat.send")).toHaveLength(1);
          await gateway.resolveDeferred("chat.send");
        },
      ),
  );

  it.each([
    { name: "caret insertion", start: 5, end: 5, expected: "ship please it", cancel: false },
    { name: "selection replacement", start: 5, end: 7, expected: "ship please", cancel: false },
    { name: "cancel after blur", start: 7, end: 7, expected: "ship it please", cancel: true },
  ])("preserves the draft through $name", ({ name, start, end, expected, cancel }) =>
    suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const { gateway, textarea, admit, emit, close } = await openDictation(page);
      await textarea.fill("ship it");
      await textarea.evaluate(
        (element: HTMLTextAreaElement, selection) =>
          element.setSelectionRange(selection.start, selection.end),
        { start, end },
      );
      await button(page, "Start voice input").hover();
      await page.mouse.down();
      await admit();
      await page.mouse.up();
      await emit("please");
      await expectDraft(textarea, expected);
      await page.mouse.move(0, 0);
      const dictationStop = button(page, "Stop and keep text");
      await dictationStop.evaluate(finishElementAnimations);
      expect(
        await dictationStop.evaluate((element) => {
          const textColor = document.createElement("span");
          textColor.style.color = "var(--text-strong)";
          element.append(textColor);
          const matches = getComputedStyle(element).color === getComputedStyle(textColor).color;
          textColor.remove();
          return matches;
        }),
      ).toBe(true);
      if (cancel) {
        await button(page, "Sessions", true).click();
        await page.locator(".shell--nav-collapsed").waitFor();
        expect(await isFocused(textarea)).toBe(false);
        await page.keyboard.press("Escape");
      } else {
        await button(page, "Stop and keep text").click();
      }
      await gateway.waitForRequest("talk.session.close");
      if (!cancel) {
        await close();
      }
      const committedDraft = cancel ? "ship it" : expected;
      await expectDraft(textarea, committedDraft);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await captureComposer(page, `dictation-${name.replaceAll(" ", "-")}-committed.png`);
      expect(await textarea.inputValue()).toBe(committedDraft);
    }),
  );

  it.each([
    ["captured selection", "chat", null, "ship please now it"],
    ["live draft edits", "chat", "ship it today", "ship it today please now"],
    ["new-session edits", "new", "keep draft today", "keep draft today spoken task"],
  ] as const)(
    "keeps every matching final after Stop with %s",
    (_name, route, editedDraft, expected) =>
      suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
        const isNew = route === "new";
        const { gateway, textarea, admit, emit, close } = await openDictation(page, {
          route,
          deferredMethods: ["talk.session.create", "talk.session.close"],
        });
        await textarea.fill(isNew ? "keep draft" : "ship it");
        if (isNew) {
          await button(page, "Dictate", true).click();
          await admit();
        } else {
          await textarea.evaluate((element: HTMLTextAreaElement) =>
            element.setSelectionRange(5, 5),
          );
          await button(page, "Start voice input").hover();
          await page.mouse.down();
          await admit();
          await page.mouse.up();
        }
        await button(page, "Stop and keep text").click();
        await gateway.waitForRequest("talk.session.close");
        if (editedDraft) {
          await textarea.fill(editedDraft);
        }

        if (!isNew) {
          await emit("ignore this", true, "stale-dictation");
        }
        for (const text of isNew ? ["spoken", "task"] : ["please", "now"]) {
          await emit(text, true);
        }
        await close();
        if (!isNew) {
          await captureComposer(page, "dictation-late-finals.png");
        }
        await expectDraft(textarea, expected);
        expect(await gateway.getRequests(isNew ? "sessions.create" : "chat.send")).toHaveLength(0);
        if (isNew) {
          await captureComposer(page, "dictation-new-session-late-finals.png");
        }
      }),
  );

  it.each([false, true])(
    "cancels new-session dictation after dismissing any tooltip (open: %s)",
    (tooltipOpen) =>
      suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
        const { gateway, textarea, admit, emit } = await openDictation(page, { route: "new" });
        await textarea.fill("keep this draft");
        await button(page, "Dictate", true).click();
        await admit();
        await emit("discard this speech");
        await expect.poll(() => textarea.inputValue()).toContain("discard this speech");
        await emit("discard this speech", true);
        await expectDraft(textarea, "keep this draft discard this speech");
        await emit("too");
        await expectDraft(textarea, "keep this draft discard this speech too");
        await emit("", true);
        await expectDraft(textarea, "keep this draft discard this speech too");
        await captureComposer(
          page,
          `dictation-new-session-${tooltipOpen ? "tooltip" : "composer"}-preview.png`,
        );
        // Clicking Dictate changes the hovered button into Stop; its hover hint
        // can open while transcripts arrive. Establish which surface Escape owns.
        await textarea.hover();
        await textarea.focus();
        const openTooltips = page.locator(
          "openclaw-tooltip .tooltip-surface[popover]:popover-open",
        );
        await expect.poll(() => openTooltips.count()).toBe(0);
        if (tooltipOpen) {
          const stop = button(page, "Stop and keep text");
          const tooltip = stop.locator("..").locator(".tooltip-surface[popover]");
          await stop.hover();
          await expect
            .poll(() => tooltip.evaluate((element) => element.matches(":popover-open")))
            .toBe(true);

          await page.keyboard.press("Escape");

          await expect
            .poll(() => tooltip.evaluate((element) => element.matches(":popover-open")))
            .toBe(false);
          expect(await textarea.inputValue()).toBe("keep this draft discard this speech too");
          expect(await readOnly(textarea)).toBe(true);
          expect(await isFocused(textarea)).toBe(true);
          expect(await gateway.getRequests("talk.session.close")).toHaveLength(0);
        }
        await page.keyboard.press("Escape");
        await expectDraft(textarea, "keep this draft");
        await gateway.waitForRequest("talk.session.close");
        expect(await button(page, "Dictate", true).isVisible()).toBe(true);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(await readOnly(textarea)).toBe(false);
        expect(await gateway.getRequests("talk.session.close")).toHaveLength(1);
        await captureComposer(
          page,
          `dictation-new-session-${tooltipOpen ? "tooltip" : "composer"}-cancelled.png`,
        );
      }),
  );

  it("keeps the hold-to-dictate preference keyboard accessible without changing the microphone", () =>
    suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: { "talk.catalog": catalog(true, true) },
      });
      await installTalkBrowserFixtures(page);
      await page.goto(`${suite.server.baseUrl}chat`);

      const voice = button(page, "Start voice input");
      await voice.hover();
      const trigger = button(page, "Microphone input");
      await trigger.click();
      const picker = page.locator(".chat-talk-input-picker");
      const selectedDevice = picker.getByRole("menuitemradio", { name: "USB Audio Interface" });
      await selectedDevice.click();
      await expect.poll(() => picker.getAttribute("open")).toBeNull();
      await expect.poll(() => isFocused(trigger)).toBe(false);
      await voice.hover();
      await trigger.click();
      const toggle = picker.getByRole("menuitemcheckbox", { name: "Hold to start dictation" });
      await expect.poll(() => picker.getAttribute("open")).not.toBeNull();
      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("true");

      await picker.getByRole("menuitemradio", { name: "System default" }).focus();
      await page.keyboard.press("End");
      await expect.poll(() => isFocused(toggle)).toBe(true);
      await page.keyboard.press("Space");

      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
      await expect.poll(() => picker.getAttribute("open")).not.toBeNull();
      await expect.poll(() => selectedDevice.getAttribute("aria-checked")).toBe("true");
      await captureComposer(page, "microphone-picker-hold-toggle.png");
      await captureFullPage(page, "microphone-picker-hold-toggle-full");
      await page.keyboard.press("Home");
      await page.keyboard.press("Enter");
      await expect.poll(() => picker.getAttribute("open")).toBeNull();
      await expect.poll(() => isFocused(trigger)).toBe(true);
      await trigger.click();
      await selectedDevice.click();
      await expect.poll(() => picker.getAttribute("open")).toBeNull();
      await expect.poll(() => isFocused(trigger)).toBe(false);
    }));

  it("gates unavailable voice capabilities in the microphone picker", () =>
    suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        heldMethods: ["chat.startup", "talk.catalog"],
        historyMessages: [TALK_READY_HISTORY_MESSAGE],
        methodResponses: { "talk.catalog": catalog(false, false) },
      });
      await installTalkBrowserFixtures(page);
      await page.goto(`${suite.server.baseUrl}chat`);

      // The enabled dictation microphone can be clicked before history/catalog admission.
      await gateway.waitForRequest("chat.startup");
      await gateway.waitForRequest("talk.catalog");
      await button(page, "Start voice input").click();
      await gateway.resolveDeferred("talk.catalog");
      await gateway.resolveDeferred("chat.startup");
      await page.getByText(TALK_READY_HISTORY_MESSAGE.content, { exact: true }).waitFor();
      const unavailable = page.locator('[data-status="unavailable"]');
      await expect.poll(() => unavailable.count()).toBe(2);
      const picker = page.locator(".chat-talk-input-picker");
      await expect.poll(() => picker.getByRole("menuitem", { name: /Configure/ }).count()).toBe(2);
      await captureComposer(page, "microphone-picker-capability-gating.png");
      await captureFullPage(page, "microphone-picker-capability-gating-full");
      await picker.locator('[data-chat-talk-capability="dictation"]').focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
    }));

  it("keeps dictation activity and the insert/discard actions visible", () =>
    suite.withPage(
      { permissions: ["microphone"], viewport: { width: 390, height: 844 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [TALK_READY_HISTORY_MESSAGE],
          methodResponses: createDictationMethodResponses(),
        });
        await installTalkBrowserFixtures(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForTalkReady(page);

        const microphone = button(page, "Dictation");
        await microphone.click();
        await gateway.waitForRequest("talk.session.create");

        const composer = page.locator(".agent-chat__input--dictating");
        const phase = composer.locator(".agent-chat__dictation-phase");
        const stop = composer.getByRole("button", { name: "Stop and keep text" });
        const send = composer.getByRole("button", { name: "Send", exact: true });
        await expect.poll(() => phase.isVisible()).toBe(true);
        await expect
          .poll(() => phase.textContent().then((text) => text?.trim()))
          .toBe("Listening…");
        expect(await composer.locator(".agent-chat__dictation-wave").count()).toBe(0);
        expect(await composer.locator(".agent-chat__dictation-elapsed").count()).toBe(0);
        await expect.poll(() => stop.isVisible()).toBe(true);
        await expect.poll(() => send.isVisible()).toBe(true);
        await captureComposer(page, "dictation-status-actions.png");
        await captureFullPage(page, "dictation-latched-after-release");
        // Read one rendered frame: owner publications can replace the status
        // between Playwright's element lookup and its separate box request.
        const layout = await composer.evaluate((element) => {
          const composerBox = element.getBoundingClientRect();
          const controls = [
            ".agent-chat__dictation-phase",
            ".chat-mobile-dictation-action .chat-send-btn--dictating",
            ".chat-send-btn--dictation-commit",
          ].map((selector) => {
            const control = element.querySelector(selector);
            if (!control?.checkVisibility({ visibilityProperty: true })) {
              return false;
            }
            const box = control.getBoundingClientRect();
            return (
              box.width > 0 &&
              box.height > 0 &&
              box.x >= composerBox.x &&
              box.right <= composerBox.right
            );
          });
          return { composerSized: composerBox.width > 0 && composerBox.height > 0, controls };
        });
        expect(layout).toEqual({ composerSized: true, controls: [true, true, true] });

        await stop.click();
        await expect.poll(() => microphone.isVisible()).toBe(true);
      },
    ));
});
