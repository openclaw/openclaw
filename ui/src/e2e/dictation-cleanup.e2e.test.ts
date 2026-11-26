import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { rasterizeProofAnnotations } from "../test-helpers/proof-annotations.ts";
import {
  installTalkBrowserFixtures,
  TALK_READY_HISTORY_MESSAGE,
} from "./browser-talk-start-stop.fixtures.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
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
const candidate = "please call me tomorrow";
const sessionId = "cleanup-dictation-fixture";
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Dictation cleanup", exact: true });
const focused = (locator: Locator) => locator.evaluate((element) => element.matches(":focus"));
const expectDraft = async (textarea: Locator, value: string) => {
  await expect.poll(() => textarea.inputValue()).toBe(value);
};

async function openFixture(
  page: Page,
  route: "chat" | "new" = "chat",
  mode: "light" | "dark" = "dark",
) {
  const gateway = await installMockGateway(page, {
    deferredMethods: ["talk.session.create"],
    historyMessages: [TALK_READY_HISTORY_MESSAGE],
    ...(route === "new"
      ? {
          featureMethods: ["chat.metadata", "chat.startup", "sessions.create", "sessions.dispatch"],
        }
      : {}),
    methodResponses: {
      "config.get": configSnapshot(
        { ui: { prefs: { theme: "claw", themeMode: mode } } },
        `dictation-cleanup-${mode}`,
        true,
      ),
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
  await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(mode);
  return {
    gateway,
    textarea,
    finishRecording: async () => {
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

async function captureProof(
  page: Page,
  name: string,
  surface: Locator,
  target: Locator,
  label: string,
) {
  const frame = await takeControlUiScreenshotFrame(page, surface, [target], {
    animations: "disabled",
    elements: [target],
    scrollTo: target,
  });
  const viewport = page.viewportSize()!;
  const scale = await page.evaluate(() => window.devicePixelRatio);
  const annotated = await rasterizeProofAnnotations(suite.browser, {
    viewport,
    scale,
    image: frame.png,
    annotations: [
      {
        kind: "outline",
        rect: frame.elements[0]!.bounds,
        text: label,
        labelAt: { x: 16, y: 16 },
        color: "#DA8A3C",
      },
    ],
  });
  await writeFile(path.join(suite.artifactDir, `${name}.png`), frame.png);
  await writeFile(path.join(suite.artifactDir, `${name}.annotated.png`), annotated);
  await writeFile(
    path.join(suite.artifactDir, `${name}.json`),
    JSON.stringify(
      {
        name,
        label,
        browser: suite.browser.version(),
        viewport,
        scale,
        evidence: "Current implementation with synthetic capture and Gateway transcripts",
        baseline: "Current Off control is not a pre-feature checkout screenshot",
      },
      null,
      2,
    ),
  );
}

async function tabToCleanedChoice(page: Page) {
  const mode = page.getByLabel("Cleanup mode", { exact: true });
  const choose = button(page, "Use cleaned draft");
  await mode.focus();
  for (let index = 0; index < 14 && !(await focused(choose)); index++) {
    await page.keyboard.press("Tab");
    const inside = await dialog(page).evaluate((modal) => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      for (let element: Element | null = active; element;) {
        if (element === modal) {
          return true;
        }
        const root = element.getRootNode();
        element =
          element.assignedSlot ??
          element.parentElement ??
          (root instanceof ShadowRoot ? root.host : null);
      }
      return false;
    });
    expect(inside).toBe(true);
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

  it.each([
    { mode: "dark", size: "desktop", width: 1440, height: 1000 },
    { mode: "light", size: "desktop", width: 1440, height: 1000 },
    { mode: "dark", size: "narrow", width: 390, height: 844 },
    { mode: "light", size: "narrow", width: 390, height: 844 },
  ] as const)(
    "reviews and restores an unsent draft in $mode at $size width",
    ({ mode, size, width, height }) =>
      suite.withPage(
        {
          permissions: ["microphone"],
          colorScheme: mode,
          reducedMotion: "reduce",
          viewport: { width, height },
        },
        async ({ page }) => {
          const { gateway, textarea, finishRecording } = await openFixture(page, "chat", mode);
          const name = `${mode}-${size}`;
          await captureProof(
            page,
            `current-off-${name}`,
            page.locator(".agent-chat__composer-shell"),
            button(page, "Dictation cleanup"),
            "Cleanup is Off by default",
          );
          await enableCleanup(page);
          await finishRecording();
          await openCleanupByKeyboard(page, true);
          const original = page.getByLabel("Original recognized text", { exact: true });
          const cleaned = page.getByLabel("Cleaned draft", { exact: true });
          await expectDraft(original, raw);
          await expectDraft(cleaned, candidate);
          expect(await original.evaluate((element: HTMLTextAreaElement) => element.readOnly)).toBe(
            true,
          );
          expect(await dialog(page).getByRole("status").getAttribute("aria-live")).toBe("polite");
          await captureProof(
            page,
            `current-review-text-${name}`,
            dialog(page),
            cleaned,
            "Review the suggested removal",
          );
          await captureProof(
            page,
            `current-review-actions-${name}`,
            dialog(page),
            button(page, "Use cleaned draft"),
            "Explicit choice adds only to the draft",
          );
          await tabToCleanedChoice(page);
          await expectDraft(textarea, candidate);
          await button(page, "Restore original").focus();
          await page.keyboard.press("Enter");
          await expectDraft(textarea, raw);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      ),
  );

  it("keeps original text recoverable when a user edit revokes replacement in New Session", () =>
    suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const { gateway, textarea, finishRecording } = await openFixture(page, "new");
      await enableCleanup(page);
      await finishRecording();
      await openCleanupByKeyboard(page, true);
      await tabToCleanedChoice(page);
      await expectDraft(textarea, candidate);
      await page.keyboard.press("Escape");
      await dialog(page).waitFor({ state: "detached" });
      const edited = `${candidate} and bring the approved agenda`;
      await textarea.fill(edited);
      await openCleanupByKeyboard(page, true);
      await expectDraft(page.getByLabel("Original recognized text", { exact: true }), raw);
      expect(await button(page, "Restore original").isDisabled()).toBe(true);
      expect(await button(page, "Use cleaned draft").isDisabled()).toBe(true);
      expect(await button(page, "Copy original text").isEnabled()).toBe(true);
      await button(page, "Dismiss review").click();
      await expectDraft(textarea, edited);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    }));
});
