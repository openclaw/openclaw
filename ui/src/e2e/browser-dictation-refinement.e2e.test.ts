import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { rasterizeProofAnnotations } from "../test-helpers/proof-annotations.ts";
import { installTalkBrowserFixtures } from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI dictation refinement" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const initialDraft = "Existing draft.";
const finalText = 'لا تحذف customer_id أو -12 mg. "Keep This." /tmp/الملف';
const contextOptions = {
  viewport: { width: 400, height: 1_000 },
  locale: "en-US",
  colorScheme: "dark",
  reducedMotion: "reduce",
} as const;

// Reach the actual controls in the browser's tab order; do not invoke owner methods.
async function tabTo(page: Page, target: Locator) {
  for (let index = 0; index < 40; index += 1) {
    if (
      (await target.isVisible()) &&
      (await target.evaluate((element) => document.activeElement === element))
    ) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`Control was not keyboard reachable: ${String(target)}`);
}

async function capture(
  page: Page,
  stage: string,
  surface: Locator,
  content: Locator[],
  label?: string,
) {
  if (!captureProof) {
    return;
  }
  const frame = await takeControlUiScreenshotFrame(page, surface, content, {
    elements: [surface, ...content],
    animations: "disabled",
  });
  await writeFile(path.join(suite.artifactDir, `${stage}-clean.png`), frame.png);
  await writeFile(
    path.join(suite.artifactDir, `${stage}-frame.json`),
    JSON.stringify(
      {
        stage,
        fixture:
          "Real Control UI bundle; synthetic Gateway transcripts and browser microphone transport",
        viewport: page.viewportSize(),
        scale: await page.evaluate(() => window.devicePixelRatio),
        reducedMotion: "reduce",
        elements: frame.elements.map(({ bounds, pixelBounds }) => ({ bounds, pixelBounds })),
      },
      null,
      2,
    ),
  );
  if (label) {
    const annotations = {
      viewport: page.viewportSize()!,
      scale: await page.evaluate(() => window.devicePixelRatio),
      annotations: [
        {
          kind: "outline" as const,
          rect: frame.elements.at(-1)!.bounds,
          text: label,
          labelAt: { x: 16, y: 24 },
          color: "#78D9C5",
        },
      ],
    };
    await writeFile(
      path.join(suite.artifactDir, `${stage}-annotations.json`),
      JSON.stringify(annotations, null, 2),
    );
    await writeFile(
      path.join(suite.artifactDir, `${stage}-annotated.png`),
      await rasterizeProofAnnotations(suite.browser, { ...annotations, image: frame.png }),
    );
  }
}

async function openDictation(page: Page) {
  await page.clock.install({ time: new Date("2026-11-26T12:00:00Z") });
  const gateway = await installMockGateway(page, {
    historyMessages: [
      {
        role: "assistant",
        content: "Review the draft before sending.",
        __openclaw: { id: "dictation-review-introduction" },
      },
    ],
    methodResponses: {
      "talk.catalog": {
        transcription: { ready: true, providers: [] },
        realtime: { ready: false, providers: [] },
        speech: { providers: [] },
        modes: [],
        transports: [],
        brains: [],
      },
    },
  });
  await installTalkBrowserFixtures(page);
  await page.goto(`${suite.server.baseUrl}chat`);
  const shell = page.locator(".agent-chat__composer-shell");
  const draft = shell.locator(".agent-chat__composer-combobox textarea");
  const microphone = shell.locator(".chat-mobile-dictation-action");
  const options = shell.getByRole("button", { name: "Dictation text options", exact: true });
  await draft.waitFor();
  await gateway.waitForRequest("sessions.messages.subscribe");
  await page.waitForFunction(() => window.openclawControlUi?.snapshot().routeReady === true);
  // Pause after boot, before any finality deadline. Screenshot readiness uses native layout.
  await pauseVirtualClock(page);
  await draft.fill(initialDraft);
  let captureId = "";
  let captures = 0;
  let sequence = 0;
  const start = async () => {
    const after = await gateway.deferNext("talk.session.create");
    captureId = `dictation-refinement-${++captures}`;
    await gateway.setMethodResponse("talk.session.create", {
      sessionId: captureId,
      transcriptionSessionId: captureId,
      audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
    });
    await tabTo(page, microphone.getByRole("button", { name: "Dictation", exact: true }));
    await page.keyboard.press("Enter");
    await page.clock.runFor(1);
    const request = await gateway.waitForRequest("talk.session.create", { after });
    expect(request.params).toMatchObject({ mode: "transcription", brain: "none" });
    await gateway.resolveDeferred("talk.session.create");
    await page.clock.runFor(1);
    await shell.locator('.agent-chat__dictation-status [data-status="listening"]').waitFor();
  };
  const stop = async (control: Locator) => {
    const after = await gateway.deferNext("talk.session.close");
    await tabTo(page, control);
    await page.keyboard.press("Enter");
    await page.clock.runFor(1);
    await gateway.waitForRequest("talk.session.close", { after });
  };
  const emit = (type: "partial" | "transcript" | "close", text = "") => {
    sequence += 1;
    return gateway.emitGatewayEvent("talk.event", {
      transcriptionSessionId: captureId,
      type,
      text,
      ...(type === "transcript" ? { final: true } : {}),
      ...(type === "close" ? { reason: "completed" } : {}),
      talkEvent: {
        id: `${captureId}:${sequence}`,
        sessionId: captureId,
        seq: sequence,
        turnId: `${captureId}:turn`,
        type:
          type === "partial"
            ? "transcript.delta"
            : type === "transcript"
              ? "transcript.done"
              : "session.closed",
      },
    });
  };
  const complete = async () => {
    await emit("transcript", finalText);
    await emit("close");
    await gateway.resolveDeferred("talk.session.close", { ok: true });
  };
  return { gateway, shell, draft, microphone, options, start, stop, emit, complete };
}

suite.define(() => {
  // Run this same test against the actual base revision for the before frames.
  // Its behavior does not depend on the new option or fabricate its absence.
  it("captures the unrefined baseline through the actual composer", () =>
    suite.withPage(contextOptions, async ({ page }) => {
      const h = await openDictation(page);
      await capture(page, "baseline-idle", h.shell, [h.draft]);
      await h.start();
      await h.emit("partial", "لا تحذف");
      await expect.poll(() => h.draft.inputValue()).toBe(`${initialDraft} لا تحذف`);
      await h.stop(h.microphone.getByRole("button", { name: "Stop and keep text", exact: true }));
      await capture(page, "baseline-finishing", h.shell, [
        h.draft,
        h.shell.locator(".agent-chat__dictation-status"),
      ]);
      await h.complete();
      await expect.poll(() => h.draft.inputValue()).toBe(`${initialDraft} ${finalText}`);
      expect(await h.gateway.getRequests("chat.send")).toHaveLength(0);
      await capture(page, "baseline-final", h.shell, [h.draft]);
    }));

  it("keeps finalized text in review while the synthetic Gateway holds close for five seconds", () =>
    suite.withPage(contextOptions, async ({ page }) => {
      const h = await openDictation(page);
      const review = h.shell.locator(".agent-chat__dictation-refinement");
      const expectFullWidth = async () => {
        const available = await h.shell.locator(".agent-chat__input").evaluate((element) => {
          const style = getComputedStyle(element);
          return (
            element.clientWidth -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.paddingRight)
          );
        });
        expect(available).toBeGreaterThan(0);
        await expect
          .poll(() => review.evaluate((element) => element.getBoundingClientRect().width))
          .toBeGreaterThanOrEqual(available * 0.8);
      };
      await tabTo(page, h.options);
      await page.keyboard.press("Enter");
      await tabTo(
        page,
        review.getByRole("checkbox", { name: "Review dictated text before inserting" }),
      );
      await page.keyboard.press("Space");
      await h.start();
      await h.stop(h.shell.locator("button.chat-send-btn--dictation-commit"));
      await h.emit("transcript", finalText);
      // The real relay composition test proves this five-second drain contract.
      // Here the Gateway events are synthetic; the built UI owns its actual deadline.
      await page.clock.runFor(2_501);
      const status = review.getByRole("status");
      await capture(page, "provider-drain-pending", h.shell, [h.draft, status], "Close pending");
      expect(await status.textContent()).toBe("Finishing text. The microphone is off.");
      expect(await h.draft.inputValue()).toBe(initialDraft);
      await page.clock.runFor(2_499);
      await h.emit("close");
      await h.gateway.resolveDeferred("talk.session.close", { ok: true });
      const preview = review.getByRole("textbox", { name: "Text preview", exact: true });
      await expect.poll(() => preview.inputValue()).toBe(finalText);
      expect(await status.textContent()).toBe("Text is ready to review. Nothing has been sent.");
      expect(await h.draft.inputValue()).toBe(initialDraft);
      expect(await h.gateway.getRequests("chat.send")).toHaveLength(0);
      await expectFullWidth();
      await capture(
        page,
        "provider-drain-ready",
        h.shell,
        [h.draft, preview, status],
        "Ready after close",
      );
      await review.getByRole("button", { name: "Use reviewed text", exact: true }).click();
      await expect.poll(() => h.draft.inputValue()).toBe(`${initialDraft} ${finalText}`);
      await preview.waitFor({ state: "detached" });
      expect(await h.gateway.getRequests("chat.send")).toHaveLength(0);
      const options = h.options;
      const checkbox = review.getByRole("checkbox", {
        name: "Review dictated text before inserting",
      });
      await options.click();
      await expect.poll(() => options.getAttribute("aria-expanded")).toBe("false");
      expect(await checkbox.isVisible()).toBe(false);
      await options.click();
      await expect.poll(() => checkbox.isVisible()).toBe(true);
      expect(await checkbox.isChecked()).toBe(true);

      await h.draft.fill("");
      await page.getByText("Review the draft before sending.", { exact: true }).click();
      expect(await h.draft.inputValue()).toBe("");
      expect(await h.draft.evaluate((element) => element === document.activeElement)).toBe(false);
      expect(await h.shell.getAttribute("data-mobile-composer")).toBe("true");
      await expect.poll(() => h.shell.getAttribute("data-composer-resting")).toBe("true");
      await expectFullWidth();
      await capture(page, "empty-unfocused-options", h.shell, [h.draft, review]);
      expect(await h.gateway.getRequests("chat.send")).toHaveLength(0);
    }));

  it("reviews, accepts, cancels, and recovers incomplete dictation with the keyboard on a narrow screen", () =>
    suite.withPage(contextOptions, async ({ page }) => {
      const h = await openDictation(page);
      const review = h.shell.locator(".agent-chat__dictation-refinement");
      const options = h.options;
      await tabTo(page, options);
      await page.keyboard.press("Enter");
      const checkbox = review.getByRole("checkbox", {
        name: "Review dictated text before inserting",
      });
      await checkbox.waitFor();
      expect(await checkbox.isChecked()).toBe(false);
      await capture(page, "review-opt-in", h.shell, [h.draft, checkbox]);
      await tabTo(page, checkbox);
      await page.keyboard.press("Space");
      await expect.poll(() => checkbox.isChecked()).toBe(true);

      await h.start();
      await h.emit("partial", "لا تحذف");
      const caption = review.getByRole("textbox", { name: "Provisional caption" });
      await expect.poll(() => caption.inputValue()).toBe("لا تحذف");
      expect(await caption.getAttribute("aria-live")).toBe("off");
      expect(await h.draft.inputValue()).toBe(initialDraft);
      await capture(page, "review-recording", h.shell, [h.draft, caption]);
      const finish = h.shell.locator("button.chat-send-btn--dictation-commit");
      expect(await finish.getAttribute("aria-label")).toBe("Finish and review text");
      await h.stop(finish);
      const status = review.getByRole("status");
      await expect.poll(() => status.textContent()).toBe("Finishing text. The microphone is off.");
      expect(await h.draft.isEditable()).toBe(true);
      expect(
        await page.evaluate(() => {
          // SAFETY: installTalkBrowserFixtures owns this external media receipt.
          const media = (
            window as Window & {
              openclawTalkE2eState?: { tracksStopped: number; audioContextsClosed: number };
            }
          ).openclawTalkE2eState;
          return { stopped: media?.tracksStopped, closed: media?.audioContextsClosed };
        }),
      ).toEqual({ stopped: 1, closed: 1 });
      await capture(page, "review-finishing", h.shell, [h.draft, status]);

      await h.complete();
      const preview = review.getByRole("textbox", { name: "Text preview" });
      await expect.poll(() => preview.inputValue()).toBe(finalText);
      expect(await status.textContent()).toBe("Text is ready to review. Nothing has been sent.");
      expect(await h.draft.inputValue()).toBe(initialDraft);
      expect(await h.gateway.getRequests("chat.send")).toHaveLength(0);
      await capture(page, "review-ready", h.shell, [h.draft, status, preview]);
      await tabTo(page, review.locator("summary").filter({ hasText: "Inspect changes" }));
      await page.keyboard.press("Enter");
      const original = review.getByRole("textbox", { name: "Original finalized transcript" });
      for (const text of [preview, original]) {
        expect(await text.inputValue()).toBe(finalText);
        expect(await text.getAttribute("dir")).toBe("auto");
        expect(await text.evaluate((element: HTMLTextAreaElement) => element.readOnly)).toBe(true);
      }
      expect(
        await review.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      const accept = review.getByRole("button", { name: "Use reviewed text", exact: true });
      await capture(page, "review-inspect", h.shell, [status, preview, original, accept]);
      await tabTo(page, accept);
      await page.keyboard.press("Enter");
      await expect.poll(() => h.draft.inputValue()).toBe(`${initialDraft} ${finalText}`);
      await preview.waitFor({ state: "detached" });
      expect(await h.gateway.getRequests("chat.send")).toHaveLength(0);
      await capture(page, "review-accepted", h.shell, [h.draft]);

      await h.start();
      await h.stop(finish);
      await tabTo(
        page,
        review.getByRole("button", { name: "Cancel text refinement", exact: true }),
      );
      await page.keyboard.press("Enter");
      await expect
        .poll(() => status.textContent())
        .toBe("Text refinement cancelled. Your draft is preserved.");
      await h.complete();
      expect(await h.draft.inputValue()).toBe(`${initialDraft} ${finalText}`);
      await capture(page, "review-cancelled", h.shell, [h.draft, status]);

      await h.start();
      await h.emit("partial", "Do not");
      await h.stop(finish);
      await page.clock.runFor(10_001);
      const incomplete = review.getByRole("textbox", {
        name: "Incomplete caption — manual recovery only",
      });
      await expect.poll(() => incomplete.inputValue()).toBe("Do not");
      expect(await status.textContent()).toContain("A complete transcript is unavailable.");
      expect(
        await review.getByRole("button", { name: "Keep raw transcript", exact: true }).count(),
      ).toBe(0);
      expect(await accept.count()).toBe(0);
      expect(await h.draft.inputValue()).toBe(`${initialDraft} ${finalText}`);
      expect(await h.gateway.getRequests("chat.send")).toHaveLength(0);
      await capture(page, "review-incomplete", h.shell, [h.draft, status, incomplete]);
      await h.gateway.resolveDeferred("talk.session.close", { ok: true });
    }));
});
