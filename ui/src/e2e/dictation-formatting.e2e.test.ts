import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { installTalkBrowserFixtures } from "./browser-talk-start-stop.fixtures.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// Real shipped UI and editor transactions; STT and Gateway are synthetic.
const microphoneWav = process.env.OPENCLAW_DICTATION_FORMATTING_MICROPHONE_WAV;
// Set this flag when exercising the same capture against the unmodified base build.
const baselineOnly = process.env.OPENCLAW_DICTATION_FORMATTING_BASELINE === "1";
const speech = "Shopping list bullet milk next item eggs next item rice";
const suite = createControlUiE2eSuite({
  name: "Dictation formatting synthetic STT product proof",
  browserLaunchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      ...(microphoneWav ? [`--use-file-for-fake-audio-capture=${microphoneWav}`] : []),
    ],
  },
});
const button = (host: Page | Locator, name: string) =>
  host.getByRole("button", { name, exact: true });
const review = (page: Page) => page.getByRole("group", { name: "Review dictation", exact: true });

async function capture(page: Page, stage: string, surface: Locator, content: Locator) {
  const frame = await takeControlUiScreenshotFrame(page, surface, [content], {
    animations: "disabled",
    elements: [surface],
    scrollTo: content,
  });
  await writeFile(path.join(suite.artifactDir, `${stage}-clean.png`), frame.png);
  const crop = frame.elements[0];
  if (!crop) {
    throw new Error("Missing same-frame proof crop");
  }
  await writeFile(path.join(suite.artifactDir, `${stage}-surface.png`), crop.png);
  await writeFile(
    path.join(suite.artifactDir, `${stage}.json`),
    JSON.stringify(
      {
        stage,
        fixture: microphoneWav
          ? "Chromium fake media capture from WAV, synthetic STT and mocked Gateway; actual product UI and native editor"
          : "Synthetic STT, synthetic microphone and mocked Gateway; actual product UI and native editor",
        lane: "production bundle",
        baselineOnly,
        viewport: page.viewportSize(),
        bounds: crop.bounds,
        presentation: await page.evaluate(() => ({
          direction: getComputedStyle(document.documentElement).direction,
          zoom: getComputedStyle(document.documentElement).zoom,
          devicePixelRatio: window.devicePixelRatio,
          forcedColors: matchMedia("(forced-colors: active)").matches,
          textScale: getComputedStyle(document.documentElement).getPropertyValue(
            "--control-ui-text-scale",
          ),
        })),
        screenReader: "NOT RUN: no assistive-technology session",
      },
      null,
      2,
    ),
  );
}

async function open(
  page: Page,
  options: {
    route?: "chat" | "new";
    rail?: boolean;
    explicit?: boolean;
    rtl?: boolean;
    largeText?: boolean;
    uncertainReceipt?: boolean;
    recipient?: boolean;
  } = {},
) {
  const route = options.route ?? "chat";
  const sessionId = "formatting-synthetic-session";
  const gateway = await installMockGateway(page, {
    deferredMethods: ["talk.session.create"],
    ...(options.recipient
      ? {
          featureMethods: [...defaultControlUiFeatureMethods, "users.mentionable"],
          presenceUsers: [
            {
              self: true,
              id: "viewer",
              identity: { type: "profile", id: "viewer" },
              name: "Viewer",
            },
          ],
        }
      : route === "new"
        ? {
            featureMethods: [
              "chat.metadata",
              "chat.startup",
              "sessions.create",
              "sessions.dispatch",
            ],
          }
        : {}),
    methodResponses: {
      ...(options.recipient
        ? {
            "users.mentionable": {
              users: [{ profileId: "alice", displayName: "Alice" }],
              truncated: false,
            },
          }
        : {}),
      "sessions.companion.state": { exchanges: [] },
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
    },
  });
  if (!microphoneWav) {
    await installTalkBrowserFixtures(page);
  }
  await page.addInitScript(
    ({ key, explicit, rtl, largeText, uncertainReceipt }) => {
      const settings = JSON.parse(localStorage.getItem(key) ?? "{}");
      if (explicit) {
        settings.dictationFormatting = { version: 1, mode: "explicit" };
      }
      if (largeText) {
        settings.textScale = 140;
      }
      localStorage.setItem(key, JSON.stringify(settings));
      if (rtl) {
        localStorage.setItem("openclaw.i18n.locale", "ar");
      }
      if (uncertainReceipt) {
        // Synthetic platform failure: perform the native transaction but lose its success receipt.
        const native = document.execCommand.bind(document);
        document.execCommand = (command, ui, value) => {
          const committed = native(command, ui, value);
          return command === "insertText" ? false : committed;
        };
      }
    },
    { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), ...options },
  );
  await page.goto(`${suite.server.baseUrl}${route}`);
  if (options.rail) {
    await openChatSidePanelType(page, "Side chat");
  }
  const textarea = page.locator(
    options.rail
      ? ".chat-session-rail__input"
      : route === "new"
        ? ".new-session-page__message"
        : ".agent-chat__composer-combobox > textarea",
  );
  await textarea.waitFor();
  await gateway.waitForRequest("talk.catalog");
  const shell = page.locator(
    options.rail
      ? ".chat-session-rail__composer"
      : route === "new"
        ? ".new-session-page__composer"
        : ".agent-chat__composer-shell",
  );
  const emit = (text: string, final = false) =>
    gateway.emitGatewayEvent("talk.event", {
      transcriptionSessionId: sessionId,
      type: final ? "transcript" : "partial",
      text,
      ...(final ? { final: true } : {}),
    });
  const close = () =>
    gateway.emitGatewayEvent("talk.event", {
      transcriptionSessionId: sessionId,
      type: "close",
      reason: "completed",
    });
  return {
    gateway,
    textarea,
    shell,
    emit,
    close,
    start: async () => {
      const microphone = shell.locator(".chat-send-btn--voice:visible").first();
      if (route === "new" || options.rail) {
        await microphone.click();
      } else {
        await microphone.hover();
        await page.mouse.down();
        await gateway.waitForRequest("talk.session.create");
        await page.mouse.up();
      }
      await gateway.waitForRequest("talk.session.create");
      await gateway.resolveDeferred("talk.session.create");
      await page.locator(".agent-chat__dictation-phase--listening").waitFor({ state: "attached" });
      if (microphoneWav) {
        const audio = await gateway.waitForRequest("talk.session.appendAudio");
        expect(audio.params).toMatchObject({ sessionId, audioBase64: expect.any(String) });
      }
    },
    finish: async (text: string, explicit = true, final = true, keyboard = false) => {
      await emit(text);
      if (keyboard) {
        await textarea.press("Enter");
      } else {
        await button(page, explicit ? "Finish and review" : "Stop and keep text").click();
      }
      await gateway.waitForRequest("talk.session.close");
      if (final) {
        await emit(text, true);
      }
      await close();
      if (explicit) {
        await review(page).waitFor();
      } else {
        await expect.poll(() => textarea.inputValue()).toBe(text);
      }
    },
    noSend: async () => {
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(0);
    },
  };
}

suite.define(() => {
  it("keeps Preserve mode raw without sending", () =>
    suite.withPage(
      { permissions: ["microphone"], viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        const fixture = await open(page);
        await fixture.start();
        await fixture.finish(speech, false);
        await capture(
          page,
          baselineOnly ? "before-preserve" : "current-preserve-compatibility",
          fixture.shell,
          fixture.textarea,
        );
        await fixture.noSend();
      },
    ));

  if (baselineOnly) {
    return;
  }

  it("keeps Alice's recipient identity through Keep original and native Undo without sending", () =>
    suite.withPage(
      { permissions: ["microphone"], viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        const fixture = await open(page, { explicit: true, recipient: true });
        await fixture.textarea.click();
        await page.keyboard.type("@Ali");
        await page
          .getByRole("listbox", { name: "Mention a person" })
          .getByRole("option", { name: "Alice" })
          .click();
        const editor = fixture.shell.locator('[data-composer-editor="true"]');
        const chip = editor.locator('.chat-composer-mention[data-profile-id="alice"]');
        const before = "@Alice ";
        expect(await fixture.textarea.inputValue()).toBe(before);
        await chip.waitFor();
        await editor.press("End");
        await fixture.start();
        await fixture.finish(speech);
        const panel = review(page);
        await button(panel, "Keep original").click();
        await expect.poll(() => fixture.textarea.inputValue()).toBe(before + speech);
        await chip.waitFor();
        await capture(page, "after-recipient-retained", fixture.shell, chip);
        await editor.press("ControlOrMeta+z");
        await expect.poll(() => fixture.textarea.inputValue()).toBe(before);
        await chip.waitFor();
        await fixture.noSend();
      },
    ));

  it("finishes an explicit Side chat recording with Enter without submitting the question", () =>
    suite.withPage(
      { permissions: ["microphone"], viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        await page.clock.install({ time: new Date("2026-11-25T12:00:00Z") });
        const fixture = await open(page, { explicit: true, rail: true });
        await fixture.textarea.fill("Keep this question");
        await fixture.start();
        await pauseVirtualClock(page);
        await fixture.emit(speech);
        await fixture.textarea.press("Enter");
        await fixture.gateway.waitForRequest("talk.session.close");
        await fixture.textarea.press("Enter");
        await fixture.noSend();
        await fixture.emit(speech, true);
        await fixture.close();
        await review(page).waitFor();
        expect(await fixture.textarea.inputValue()).toBe("Keep this question");
        await capture(
          page,
          "after-rail-keyboard-review",
          fixture.shell,
          review(page).getByRole("status"),
        );
        await fixture.noSend();
      },
    ));

  it("cancels final transcript processing from its visible control and ignores late text", () =>
    suite.withPage(
      { permissions: ["microphone"], viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        await page.clock.install({ time: new Date("2026-11-25T12:00:00Z") });
        const fixture = await open(page, { explicit: true });
        await fixture.start();
        await pauseVirtualClock(page);
        await fixture.emit(speech);
        await button(page, "Finish and review").click();
        await fixture.gateway.waitForRequest("talk.session.close");
        const cancel = button(page, "Cancel dictation");
        await cancel.waitFor();
        await capture(page, "after-finalizing-cancellable", fixture.shell, cancel);
        await cancel.click();
        await cancel.waitFor({ state: "detached" });
        await fixture.emit(speech, true);
        await fixture.close();
        expect(await review(page).count()).toBe(0);
        expect(await fixture.textarea.inputValue()).toBe("");
        await fixture.noSend();
      },
    ));

  it("opts in by keyboard, reviews both formats, commits Markdown once and undoes without sending", () =>
    suite.withPage(
      {
        permissions: ["microphone", "clipboard-read", "clipboard-write"],
        viewport: { width: 1280, height: 1000 },
      },
      async ({ page }) => {
        const fixture = await open(page);
        await fixture.shell.locator(".chat-send-btn--voice:visible").first().hover();
        await button(page, "Microphone input").click();
        const mode = page.getByRole("combobox", { name: "Dictation formatting", exact: true });
        await mode.focus();
        await mode.press("End");
        await expect.poll(() => mode.inputValue()).toBe("explicit");
        expect(await mode.evaluate((element) => document.activeElement === element)).toBe(true);
        await mode.press("Escape");
        await fixture.textarea.focus();
        await fixture.start();
        await fixture.finish(speech, true, true, true);
        await fixture.noSend();
        const panel = review(page);
        const commands = panel.getByRole("checkbox");
        expect(await commands.count()).toBe(3);
        for (let index = 0; index < 3; index++) {
          await commands.nth(index).focus();
          await page.keyboard.press("Space");
        }
        await button(panel, "Interpret selected commands").focus();
        await page.keyboard.press("Enter");
        const semantic = panel.getByRole("region", { name: "Semantic preview" });
        expect(await semantic.locator("ul > li").allTextContents()).toEqual([
          "milk",
          "eggs",
          "rice",
        ]);
        expect(await fixture.textarea.inputValue()).toBe("");
        await capture(page, "after-semantic-ready", fixture.shell, semantic);
        const format = panel.getByRole("combobox", { name: "Preview format" });
        await format.selectOption("plain");
        const plain = panel.getByRole("textbox", { name: "Plain text preview" });
        expect(await plain.inputValue()).toContain("- eggs");
        await capture(page, "after-plain-ready", fixture.shell, plain);
        await button(panel, "Copy plain text").focus();
        await page.keyboard.press("Enter");
        await expect
          .poll(() => panel.getByRole("status").textContent())
          .toContain("Plain text copied.");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          await plain.inputValue(),
        );
        await button(panel, "Use formatted text").focus();
        await page.keyboard.press("Enter");
        await expect
          .poll(() => panel.getByRole("status").textContent())
          .toContain("Text was added");
        expect(await fixture.textarea.inputValue()).toContain("- milk");
        expect(await fixture.textarea.inputValue()).not.toContain("next item");
        expect(await button(panel, "Use formatted text").isDisabled()).toBe(true);
        await capture(page, "after-committed", fixture.shell, panel.getByRole("status"));
        await fixture.textarea.focus();
        await page.keyboard.press("ControlOrMeta+z");
        await expect.poll(() => fixture.textarea.inputValue()).toBe("");
        await fixture.noSend();
      },
    ));

  it("blocks New Session submission during finalization, then reviews and undoes paragraphs", () =>
    suite.withPage(
      { permissions: ["microphone"], viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        const fixture = await open(page, { route: "new", explicit: true });
        const draft = "Keep this draft until review";
        await fixture.textarea.fill(draft);
        const start = button(fixture.shell, "Start session");
        await expect.poll(() => start.isEnabled()).toBe(true);
        await fixture.textarea.selectText();
        await fixture.start();
        const text = "Opening paragraph new paragraph closing paragraph";
        await fixture.emit(text);
        await button(page, "Finish and review").click();
        await fixture.gateway.waitForRequest("talk.session.close");
        await fixture.textarea.press("Enter");
        await fixture.noSend();
        expect(await fixture.textarea.inputValue()).toBe(draft);
        expect(await start.isDisabled()).toBe(true);
        await fixture.emit(text, true);
        await fixture.close();
        const panel = review(page);
        expect(await panel.getByRole("region", { name: "Semantic preview" }).textContent()).toBe(
          text,
        );
        await capture(page, "after-needs-review", fixture.shell, panel.getByRole("checkbox"));
        await panel.getByRole("checkbox").focus();
        await page.keyboard.press("Space");
        await button(panel, "Interpret selected commands").focus();
        await page.keyboard.press("Enter");
        await expect
          .poll(() => panel.getByRole("region", { name: "Semantic preview" }).locator("p").count())
          .toBe(2);
        expect(
          await panel
            .getByRole("combobox", { name: "Preview format" })
            .evaluate((element) => document.activeElement === element),
        ).toBe(true);
        await capture(
          page,
          "after-confirmed-paragraphs",
          fixture.shell,
          panel.getByRole("region", { name: "Semantic preview" }),
        );
        await button(panel, "Use formatted text").click();
        await expect
          .poll(() => fixture.textarea.inputValue())
          .toBe("Opening paragraph\n\nclosing paragraph");
        await fixture.textarea.focus();
        await page.keyboard.press("ControlOrMeta+z");
        await expect.poll(() => fixture.textarea.inputValue()).toBe(draft);
        await fixture.noSend();
      },
    ));

  it.each(["stale", "incomplete", "unknown"] as const)(
    "keeps %s recovery usable without retrying or sending",
    (state) =>
      suite.withPage(
        {
          permissions: ["microphone", "clipboard-read", "clipboard-write"],
          viewport: { width: 1280, height: 1100 },
        },
        async ({ page }) => {
          const fixture = await open(page, {
            route: state === "unknown" ? "new" : "chat",
            explicit: true,
            uncertainReceipt: state === "unknown",
          });
          await fixture.start();
          await fixture.finish(speech, true, state !== "incomplete");
          const panel = review(page);
          if (state === "stale") {
            await fixture.textarea.fill("A newer user draft");
            await expect.poll(() => button(panel, "Keep original").isDisabled()).toBe(true);
            expect(await panel.getByRole("status").textContent()).toContain(
              "insertion target changed",
            );
          } else if (state === "unknown") {
            for (const command of await panel.getByRole("checkbox").all()) {
              await command.check();
            }
            await button(panel, "Interpret selected commands").click();
            await button(panel, "Use formatted text").click();
            await expect
              .poll(() => panel.getByRole("status").textContent())
              .toContain("Insertion could not be confirmed");
            expect(await button(panel, "Keep original").isDisabled()).toBe(true);
            expect(await button(panel, "Reprocess").isDisabled()).toBe(true);
          } else {
            expect(
              await panel.getByRole("textbox", { name: "Plain text preview" }).inputValue(),
            ).toBe(speech);
            // A non-final transcript is recoverable as plain text, not as a formatted proposal.
            expect(await panel.getByRole("checkbox").count()).toBe(0);
          }
          expect(await button(panel, "Use formatted text").isDisabled()).toBe(true);
          await capture(page, `after-${state}`, fixture.shell, panel.getByRole("status"));
          await button(panel, "Copy plain text").click();
          await expect
            .poll(() => panel.getByRole("status").textContent())
            .toContain("Plain text copied.");
          await button(panel, "Dismiss").focus();
          await page.keyboard.press("Enter");
          await panel.waitFor({ state: "detached" });
          expect(
            await fixture.textarea.evaluate((element) => document.activeElement === element),
          ).toBe(true);
          await fixture.noSend();
        },
      ),
  );

  it.each(["narrow-large-text", "rtl-zoom-200"] as const)(
    "keeps review controls reachable in %s",
    (presentation) =>
      suite.withPage(
        {
          permissions: ["microphone"],
          viewport:
            presentation === "narrow-large-text"
              ? { width: 320, height: 1000 }
              : { width: 640, height: 500 },
          deviceScaleFactor: presentation === "rtl-zoom-200" ? 2 : 1,
          forcedColors: presentation === "narrow-large-text" ? "active" : "none",
        },
        async ({ page }) => {
          const fixture = await open(page, {
            route: "new",
            explicit: true,
            largeText: true,
            rtl: presentation === "rtl-zoom-200",
          });
          await fixture.start();
          await fixture.finish(speech);
          if (presentation === "rtl-zoom-200") {
            // 1280×1000 physical pixels at 200%-equivalent viewport/DPR geometry.
            // This is browser emulation, not an AT or browser-chrome zoom session.
            expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
            expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
          }
          const panel = review(page);
          const controls = [
            button(panel, "Keep original"),
            button(panel, "Copy plain text"),
            button(panel, "Dismiss"),
          ] as const;
          for (const control of controls) {
            await control.focus();
            expect(
              await control.evaluate((element) => {
                const box = element.getBoundingClientRect();
                return (
                  document.activeElement === element &&
                  box.left >= 0 &&
                  box.right <= innerWidth &&
                  box.top >= 0 &&
                  box.bottom <= innerHeight
                );
              }),
            ).toBe(true);
          }
          expect(
            await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          ).toBe(true);
          // Finish can leave the mouse over a newly revealed control. Its tooltip
          // gets the first Escape, so move off the composer before testing review Escape.
          await page.mouse.move((page.viewportSize()?.width ?? 320) / 2, 2);
          await capture(page, `after-${presentation}-controls`, fixture.shell, controls[2]);
          await controls[2].press("Escape");
          await panel.waitFor({ state: "detached" });
          await fixture.noSend();
        },
      ),
  );
});
