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

function createDictationMethodResponses(sessionId: string) {
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
  sessionId: string,
  options: Parameters<typeof installMockGateway>[1] = {},
  route = "chat",
) {
  const gateway = await installMockGateway(page, {
    deferredMethods: ["talk.session.create"],
    ...options,
    methodResponses: createDictationMethodResponses(sessionId),
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

suite.define(() => {
  it.each([false, true])(
    "dictates during a running turn and sends explicitly (wait for completion: %s)",
    async (waitForCompletion) => {
      await suite.withPage(
        { permissions: ["microphone"], viewport: { width: 390, height: 844 } },
        async ({ page }) => {
          const { gateway, textarea, admit, emit } = await openDictation(page, "active-dictation", {
            heldMethods: ["chat.send"],
            deferredMethods: ["talk.session.create"],
            sessionInfo: {
              key: "agent:main:main",
              activeRunIds: ["active-dictation-run"],
              hasActiveRun: true,
            },
            inFlightRun: {
              runId: "active-dictation-run",
              text: "I’m reviewing the next steps.",
              plan: {
                steps: [
                  { step: "Read the request", status: "completed" },
                  { step: "Review the next steps", status: "in_progress" },
                  { step: "Summarize the result", status: "pending" },
                ],
              },
            },
          });
          const microphone = page.getByRole("button", { name: "Dictation", exact: true });
          await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor();
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
          await expect.poll(() => textarea.inputValue()).toBe("Please check the tests too.");
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
            await page.getByRole("button", { name: "Stop and keep text", exact: true }).click();
            expect(await textarea.inputValue()).toBe("Please check the tests too.");
            expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          }
          await capture("dictated-draft");
          await page
            .getByRole("button", { name: waitForCompletion ? "Send message" : "Send", exact: true })
            .click();
          const request = await gateway.waitForRequest("chat.send");
          expect(request.params).toMatchObject({ message: "Please check the tests too." });
          await expect.poll(() => textarea.inputValue()).toBe("");
          // The local user bubble acknowledges Send before the held Gateway ACK.
          await page
            .locator(".chat-bubble")
            .getByText("Please check the tests too.", { exact: true })
            .waitFor();
          await capture("dictation-send-pending");
          expect(await gateway.getRequests("chat.send")).toHaveLength(1);
          await gateway.resolveDeferred("chat.send");
        },
      );
    },
  );

  it.each([
    { name: "caret insertion", start: 5, end: 5, expected: "ship please it", cancel: false },
    { name: "selection replacement", start: 5, end: 7, expected: "ship please", cancel: false },
    { name: "cancel after blur", start: 7, end: 7, expected: "ship it please", cancel: true },
  ])("preserves the draft through $name", async ({ name, start, end, expected, cancel }) => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const { gateway, textarea, admit, emit } = await openDictation(
        page,
        "dictation-preview-proof",
      );
      await textarea.fill("ship it");
      await textarea.evaluate(
        (element: HTMLTextAreaElement, selection) =>
          element.setSelectionRange(selection.start, selection.end),
        { start, end },
      );
      await page.getByRole("button", { name: "Start voice input" }).hover();
      await page.mouse.down();
      await admit();
      await page.mouse.up();
      await emit("please");
      await expect.poll(() => textarea.inputValue()).toBe(expected);
      await page.mouse.move(0, 0);
      const dictationStop = page.getByRole("button", { name: "Stop and keep text" });
      await dictationStop.evaluate(finishElementAnimations);
      const dictationAppearance = await dictationStop.evaluate((element) => {
        const textColor = document.createElement("span");
        textColor.style.color = "var(--text-strong)";
        element.append(textColor);
        const appearance = {
          color: getComputedStyle(element).color,
          textStrong: getComputedStyle(textColor).color,
        };
        textColor.remove();
        return appearance;
      });
      expect(dictationAppearance.color).toBe(dictationAppearance.textStrong);
      if (cancel) {
        await page.getByRole("button", { name: "Sessions", exact: true }).click();
        await page.locator(".shell--nav-collapsed").waitFor();
        expect(await isFocused(textarea)).toBe(false);
        await page.keyboard.press("Escape");
      } else {
        await page.getByRole("button", { name: "Stop and keep text" }).click();
      }
      await gateway.waitForRequest("talk.session.close");
      const committedDraft = cancel ? "ship it" : expected;
      expect(await textarea.inputValue()).toBe(committedDraft);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await captureComposer(page, `dictation-${name.replaceAll(" ", "-")}-committed.png`);
      expect(await textarea.inputValue()).toBe(committedDraft);
    });
  });

  it.each([
    { name: "captured selection", editedDraft: null, expected: "ship please now it" },
    {
      name: "live draft edits",
      editedDraft: "ship it today",
      expected: "ship it today please now",
    },
  ])("keeps every matching final after Stop with $name", async ({ editedDraft, expected }) => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const { gateway, textarea, admit, emit, close } = await openDictation(
        page,
        "dictation-late-final-proof",
        {
          deferredMethods: ["talk.session.create", "talk.session.close"],
        },
      );
      await textarea.fill("ship it");
      await textarea.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 5));

      await page.getByRole("button", { name: "Start voice input" }).hover();
      await page.mouse.down();
      await admit();
      await page.mouse.up();
      await page.getByRole("button", { name: "Stop and keep text" }).click();
      await gateway.waitForRequest("talk.session.close");
      if (editedDraft) {
        await textarea.fill(editedDraft);
      }

      await emit("ignore this", true, "stale-dictation");
      await emit("please", true);
      await emit("now", true);
      await close();
      await captureComposer(page, "dictation-late-finals.png");

      await expect.poll(() => textarea.inputValue()).toBe(expected);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it.each([false, true])(
    "cancels new-session dictation after dismissing any tooltip (open: %s)",
    async (tooltipOpen) => {
      await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
        const { gateway, textarea, admit, emit } = await openDictation(
          page,
          "dictation-direct-proof",
          {
            featureMethods: [
              "chat.metadata",
              "chat.startup",
              "sessions.create",
              "sessions.dispatch",
            ],
          },
          "new",
        );
        await textarea.fill("keep this draft");
        await page.getByRole("button", { name: "Dictate", exact: true }).click();
        await admit();
        await emit("discard this speech");
        await expect.poll(() => textarea.inputValue()).toContain("discard this speech");
        await emit("discard this speech", true);
        await expect.poll(() => textarea.inputValue()).toBe("keep this draft discard this speech");
        await emit("too");
        await expect
          .poll(() => textarea.inputValue())
          .toBe("keep this draft discard this speech too");
        await emit("", true);
        await expect
          .poll(() => textarea.inputValue())
          .toBe("keep this draft discard this speech too");
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
          const stop = page.getByRole("button", { name: "Stop and keep text" });
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
        await expect.poll(() => textarea.inputValue()).toBe("keep this draft");
        await gateway.waitForRequest("talk.session.close");
        expect(await page.getByRole("button", { name: "Dictate", exact: true }).isVisible()).toBe(
          true,
        );
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(await readOnly(textarea)).toBe(false);
        expect(await gateway.getRequests("talk.session.close")).toHaveLength(1);
        await captureComposer(
          page,
          `dictation-new-session-${tooltipOpen ? "tooltip" : "composer"}-cancelled.png`,
        );
      });
    },
  );

  it("preserves new-session edits before late finals commit", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const { gateway, textarea, admit, emit, close } = await openDictation(
        page,
        "dictation-new-session-late-final",
        {
          deferredMethods: ["talk.session.create", "talk.session.close"],
          featureMethods: ["chat.metadata", "chat.startup", "sessions.create", "sessions.dispatch"],
        },
        "new",
      );
      await textarea.fill("keep draft");
      await page.getByRole("button", { name: "Dictate", exact: true }).click();
      await admit();
      await page.getByRole("button", { name: "Stop and keep text" }).click();
      await gateway.waitForRequest("talk.session.close");
      await textarea.fill("keep draft today");

      for (const text of ["spoken", "task"]) {
        await emit(text, true);
      }
      await close();

      await expect.poll(() => textarea.inputValue()).toBe("keep draft today spoken task");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await captureComposer(page, "dictation-new-session-late-finals.png");
    });
  });

  it("keeps the hold-to-dictate preference keyboard accessible without changing the microphone", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: { "talk.catalog": catalog(true, true) },
      });
      await installTalkBrowserFixtures(page);
      await page.goto(`${suite.server.baseUrl}chat`);

      const voice = page.getByRole("button", { name: "Start voice input" });
      await voice.hover();
      const trigger = page.getByRole("button", { name: "Microphone input" });
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
    });
  });

  it("gates unavailable voice capabilities in the microphone picker", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
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
      await page.getByRole("button", { name: "Start voice input" }).click();
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
    });
  });

  it("keeps dictation activity and the insert/discard actions visible", async () => {
    await suite.withPage(
      { permissions: ["microphone"], viewport: { width: 390, height: 844 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [TALK_READY_HISTORY_MESSAGE],
          methodResponses: createDictationMethodResponses("dictation-browser-proof"),
        });
        await installTalkBrowserFixtures(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForTalkReady(page);

        const microphone = page.getByRole("button", { name: "Dictation" });
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
        const { composerBox, controls } = await composer.evaluate((element) => {
          const bounds = (target: Element) => {
            const { x, y, width, height } = target.getBoundingClientRect();
            return { x, y, width, height };
          };
          return {
            composerBox: bounds(element),
            controls: [
              ".agent-chat__dictation-phase",
              ".chat-mobile-dictation-action .chat-send-btn--dictating",
              ".chat-send-btn--dictation-commit",
            ].map((selector) => {
              const control = element.querySelector(selector);
              return {
                selector,
                box: control?.checkVisibility({ visibilityProperty: true })
                  ? bounds(control)
                  : null,
              };
            }),
          };
        });
        expect(composerBox.width).toBeGreaterThan(0);
        expect(composerBox.height).toBeGreaterThan(0);
        for (const { selector, box } of controls) {
          expect(box, selector).not.toBeNull();
          if (!box) {
            throw new Error("expected visible dictation control layout box");
          }
          expect(box.width).toBeGreaterThan(0);
          expect(box.height).toBeGreaterThan(0);
          expect(box.x).toBeGreaterThanOrEqual(composerBox.x);
          expect(box.x + box.width).toBeLessThanOrEqual(composerBox.x + composerBox.width);
        }

        await stop.click();
        await expect.poll(() => microphone.isVisible()).toBe(true);
      },
    );
  });
});
