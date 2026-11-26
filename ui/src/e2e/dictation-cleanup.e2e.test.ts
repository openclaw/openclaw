import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  installTalkBrowserFixtures,
  TALK_READY_HISTORY_MESSAGE,
} from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// Real Chromium and the shipped UI, with synthetic capture and Gateway transcripts.
// These scenarios do not qualify microphones, recognizers, or screen readers.
const suite = createControlUiE2eSuite({
  name: "Control UI conservative dictation cleanup",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});
const raw = "um please call me tomorrow";
const sessionId = "cleanup-dictation-fixture";
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Dictation cleanup", exact: true });
const focused = (locator: Locator) => locator.evaluate((element) => element.matches(":focus"));
const expectDraft = async (textarea: Locator, value: string) => {
  await expect.poll(() => textarea.inputValue()).toBe(value);
};

async function openFixture(page: Page, route: "chat" | "new" = "chat") {
  const gateway = await installMockGateway(page, {
    deferredMethods: ["talk.session.create"],
    historyMessages: [TALK_READY_HISTORY_MESSAGE],
    ...(route === "new"
      ? {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.create", "sessions.dispatch"],
        }
      : {}),
    methodResponses: {
      "talk.catalog": {
        transcription: { ready: true, providers: [] },
        realtime: { providers: [] },
        speech: { providers: [] },
        modes: [],
        transports: [],
        brains: [],
      },
      "talk.session.create": {
        sessionId,
        transcriptionSessionId: sessionId,
        audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      },
      "sessions.create": { key: "agent:main:cleanup-draft", initialRun: { status: "idle" } },
    },
  });
  await installTalkBrowserFixtures(page);
  await page.goto(`${suite.server.baseUrl}${route}`);
  const textarea = page.locator(
    route === "new" ? ".new-session-page__message" : ".agent-chat__composer-combobox textarea",
  );
  await textarea.waitFor();
  return {
    gateway,
    textarea,
    finishRecording: async (whileFinalizing?: () => Promise<void>) => {
      if (route === "new") {
        await button(page, "Dictate").click();
      } else {
        await button(page, "Start voice input").hover();
        await page.mouse.down();
        await gateway.waitForRequest("talk.session.create");
        await page.mouse.up();
      }
      await gateway.waitForRequest("talk.session.create");
      await gateway.resolveDeferred("talk.session.create");
      await gateway.emitGatewayEvent("talk.event", {
        transcriptionSessionId: sessionId,
        type: "partial",
        text: raw,
      });
      await button(page, "Stop and keep text").click();
      await gateway.waitForRequest("talk.session.close");
      await whileFinalizing?.();
      await gateway.emitGatewayEvent("talk.event", {
        transcriptionSessionId: sessionId,
        type: "transcript",
        text: raw,
        final: true,
      });
      await gateway.emitGatewayEvent("talk.event", {
        transcriptionSessionId: sessionId,
        type: "close",
        reason: "completed",
      });
      await expect.poll(() => textarea.isEditable()).toBe(true);
    },
  };
}

async function openCleanupByKeyboard(page: Page, review = false) {
  const trigger = button(page, review ? "Review dictation" : "Dictation cleanup");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await dialog(page).waitFor();
  return trigger;
}

async function enableCleanup(page: Page) {
  const trigger = await openCleanupByKeyboard(page);
  const mode = page.getByLabel("Cleanup mode", { exact: true });
  expect(await mode.inputValue()).toBe("off");
  await mode.focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => mode.inputValue()).toBe("conservative");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await dialog(page).waitFor({ state: "detached" });
  await expect.poll(() => focused(trigger)).toBe(true);
}

async function tabToOriginalChoice(page: Page) {
  const mode = page.getByLabel("Cleanup mode", { exact: true });
  const choose = button(page, "Use original");
  await mode.focus();
  for (let index = 0; index < 14 && !(await focused(choose)); index++) {
    await page.keyboard.press("Tab");
  }
  expect(await focused(choose)).toBe(true);
  await page.keyboard.press("Enter");
}

suite.define(() => {
  it("preserves recognized output by default and persists only an explicit cleanup opt-in", () =>
    suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const { gateway, textarea, finishRecording } = await openFixture(page);
      await finishRecording();
      await expectDraft(textarea, raw);
      expect(await button(page, "Review dictation").count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await enableCleanup(page);
      await page.reload();
      await openCleanupByKeyboard(page);
      expect(await page.getByLabel("Cleanup mode", { exact: true }).inputValue()).toBe(
        "conservative",
      );
      await page.getByLabel("Cleanup mode", { exact: true }).selectOption("off");
      await page.keyboard.press("Escape");
      await page.reload();
      await openCleanupByKeyboard(page);
      expect(await page.getByLabel("Cleanup mode", { exact: true }).inputValue()).toBe("off");
    }));

  it("lets a ready review own Escape and keeps the original recoverable", () =>
    suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const { gateway, textarea, finishRecording } = await openFixture(page);
      await enableCleanup(page);
      await finishRecording();
      const trigger = await openCleanupByKeyboard(page, true);
      await page.getByLabel("Original recognized text", { exact: true }).focus();
      await page.keyboard.press("Escape");
      await dialog(page).waitFor({ state: "detached" });
      await expect.poll(() => focused(trigger)).toBe(true);
      await expectDraft(textarea, "");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      await openCleanupByKeyboard(page, true);
      await expect
        .poll(() => dialog(page).getByRole("status").textContent())
        .toBe("Cleanup is unavailable. The original recognized text is unchanged.");
      const original = page.getByLabel("Original recognized text", { exact: true });
      await expectDraft(original, raw);
      expect(await original.evaluate((element: HTMLTextAreaElement) => element.readOnly)).toBe(
        true,
      );
      expect(await dialog(page).getByRole("status").getAttribute("aria-live")).toBe("polite");
      expect(await button(page, "Use cleaned draft").count()).toBe(0);
      expect(await button(page, "Review again").count()).toBe(0);
      await tabToOriginalChoice(page);
      await dialog(page).waitFor({ state: "detached" });
      await expectDraft(textarea, raw);
      expect(await button(page, "Review dictation").count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    }));

  it("keeps original text recoverable when a user edit revokes replacement in New Session", () =>
    suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const { gateway, textarea, finishRecording } = await openFixture(page, "new");
      await enableCleanup(page);
      const previousDraft = "Existing unsent draft";
      await textarea.fill(previousDraft);
      await finishRecording(async () => {
        await textarea.press("Enter");
        await expectDraft(textarea, previousDraft);
        expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await openCleanupByKeyboard(page, true);
        expect(await button(page, "Use original").isDisabled()).toBe(true);
        await page.keyboard.press("Escape");
        await dialog(page).waitFor({ state: "detached" });
      });
      await openCleanupByKeyboard(page, true);
      await page.keyboard.press("Escape");
      await dialog(page).waitFor({ state: "detached" });
      const edited = "Please bring the approved agenda";
      await textarea.fill(edited);
      await openCleanupByKeyboard(page, true);
      await expectDraft(page.getByLabel("Original recognized text", { exact: true }), raw);
      expect(await button(page, "Use original").isDisabled()).toBe(true);
      expect(await button(page, "Use cleaned draft").count()).toBe(0);
      expect(await button(page, "Copy original text").isEnabled()).toBe(true);
      await button(page, "Dismiss review").click();
      await expectDraft(textarea, edited);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    }));
});
