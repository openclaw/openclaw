import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
  bottom,
  layoutBox,
  right,
  exactButton,
  polledFocus,
  polledAttribute,
  polledCount,
  polledText,
  polledVisible,
} from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat composer redesign",
});
type Model = NonNullable<ControlUiMockGatewayScenario["models"]>[number];
const modelFixture = (extra: Partial<Model> = {}): Model => ({
  id: "gpt-5.5",
  name: "GPT-5.5",
  provider: "openai",
  ...extra,
});

suite.define(() => {
  it.each([
    {
      reason: "auth-failed",
      blocked: true,
      message: "Authentication failed. Review the provider credential or sign-in, then retry.",
    },
    { reason: "cooldown", blocked: false, message: null },
  ] as const)(
    "keeps $reason model availability honest in the composer and picker",
    async ({ reason, blocked, message }) => {
      await suite.withPage(
        {
          viewport: { width: 1280, height: 900 },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            models: [modelFixture({ available: false, unavailableReason: reason })],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await gateway.waitForRequest("sessions.messages.subscribe");
          const textarea = page.locator(".agent-chat__composer-combobox textarea");
          const sendButton = exactButton(page, "Send message");
          await expect.poll(() => textarea.isDisabled()).toBe(false);
          await textarea.fill("Send while availability recovers");
          await expect.poll(() => sendButton.isDisabled()).toBe(blocked);
          expect(await textarea.inputValue()).toBe("Send while availability recovers");
          const setupBanner = page.locator(".agent-chat__disabled-banner");
          await polledCount(page.locator(".agent-chat__composer-status-band")).toBe(0);
          if (message) {
            await polledText(setupBanner).toContain(message);
            const setupAction = setupBanner.getByRole("button", { name: "Connect an AI provider" });
            await polledVisible(setupAction).toBe(true);
            expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          } else {
            await sendButton.click();
            const send = await gateway.waitForRequest("chat.send");
            expect(send.params).toMatchObject({ message: "Send while availability recovers" });
            const runId =
              isRecord(send.params) && "idempotencyKey" in send.params
                ? String(send.params.idempotencyKey)
                : "";
            await gateway.emitChatFinal({ runId, text: "The run succeeded." });
            await polledCount(page.getByText("The run succeeded.")).toBeGreaterThan(0);
          }
          await page.locator('[data-chat-model-select="true"]').click();
          const option = page.locator('[data-chat-model-option="openai/gpt-5.5"]');
          await revealChatModelOption(page, "openai/gpt-5.5");
          await polledVisible(option).toBe(true);
          if (blocked) {
            await polledAttribute(option, "data-chat-model-setup").toBe("true");
            await option.click();
            await page.waitForURL("**/settings/model-providers?connect=1");
          } else {
            expect(await option.isDisabled()).toBe(true);
            expect(await page.locator(".chat-controls__model-menu").textContent()).not.toContain(
              "Authentication failed",
            );
            expect(await option.textContent()).not.toContain("Sign-in needed");
          }
        },
      );
    },
  );

  it("does not repeat an auth failure below the composer when the run error is visible", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const message =
        "Your refresh token has already been used to generate a new access token. Please try signing in again.";
      const gateway = await installMockGateway(page, {
        sessions: [
          {
            key: "agent:main:main",
            sessionId: "auth-failed-session",
            status: "running",
            hasActiveRun: true,
            activeRunIds: ["auth-failed-run"],
          },
        ],
        inFlightRun: { runId: "auth-failed-run", text: "" },
        models: [modelFixture({ available: false, unavailableReason: "auth-failed" })],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await exactButton(page, "Stop generating").waitFor();
      await gateway.emitGatewayEvent("chat", {
        errorDetail: {
          provider: "openai",
          failoverReason: "refresh_token_reused",
          providerRuntimeFailureKind: "auth_refresh",
          providerErrorType: "invalid_request_error",
          httpStatus: 401,
        },
        errorMessage: `⚠️ ${message}`,
        runId: "auth-failed-run",
        sessionKey: "main",
        state: "error",
      });
      await polledText(page.locator(".chat-error")).toContain(message);
      await polledCount(page.locator(".agent-chat__composer-status-band")).toBe(0);
      const textarea = page.locator(".agent-chat__input textarea");
      await expect.poll(() => textarea.isDisabled()).toBe(false);
      await textarea.fill("Try the message again.");
      await expect.poll(() => exactButton(page, "Send message").isDisabled()).toBe(true);
      expect(await textarea.inputValue()).toBe("Try the message again.");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("keeps the loading model picker beside the microphone", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        subscriptionInitialHistory: false,
        deferredMethods: ["chat.startup", "models.list"],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__input");
      const model = composer.locator('[data-chat-model-select="true"]');
      const voice = page.getByRole("button", { name: "Start voice input" });
      await polledAttribute(model, "aria-busy").toBe("true");
      await polledVisible(voice).toBe(true);

      const measureGap = async () => {
        const [modelBox, voiceBox] = await Promise.all([model.boundingBox(), voice.boundingBox()]);
        return modelBox && voiceBox ? voiceBox.x - right(modelBox) : null;
      };
      await expect.poll(measureGap).toBeGreaterThanOrEqual(0);
      await expect.poll(measureGap).toBeLessThanOrEqual(16);
    });
  });

  it("keeps mobile picker panels above an attachment-expanded composer", async () => {
    await suite.withPage({ viewport: { width: 393, height: 852 } }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("sessions.messages.subscribe");

      const composer = page.locator(".agent-chat__input");
      await composer.waitFor({ state: "visible" });
      await composer.locator(".agent-chat__file-input").setInputFiles({
        name: "mobile-composer-proof.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("mobile composer attachment"),
      });
      await composer.locator(".chat-attachments-preview").waitFor({ state: "visible" });
      await composer.locator("textarea").click();
      for (const [kind, trigger] of [
        ["model", '[data-chat-model-select="true"]'],
        ["effort", '[data-chat-thinking-select="true"]'],
      ] as const) {
        const menu = `.chat-controls__${kind}-menu`;
        const popup = composer.locator(`.chat-controls__${kind}-picker > [data-anchored-overlay]`);
        const visibleTrigger = composer.locator(trigger);
        await polledVisible(visibleTrigger).toBe(true);
        await visibleTrigger.click();
        // The popup scales while opening; measure its settled viewport bounds.
        await waitForControlUiProofSurface(popup, [page.locator(menu)]);
        const [composerBox, footerBox, menuBox, triggerBox] = await Promise.all([
          layoutBox(composer),
          layoutBox(composer.locator(".agent-chat__composer-footer")),
          layoutBox(page.locator(menu)),
          layoutBox(visibleTrigger),
        ]);
        // Fixed pickers use the shared 16px mobile gutter.
        expect(menuBox.x).toBeCloseTo(16, 0);
        expect(right(menuBox)).toBeCloseTo(393 - 16, 0);
        expect(menuBox.width).toBeCloseTo(393 - 2 * 16, 0);
        expect(menuBox.y).toBeGreaterThanOrEqual(0);
        expect(bottom(menuBox)).toBeLessThanOrEqual(composerBox.y + 1);
        expect(bottom(triggerBox)).toBeLessThanOrEqual(853);
        expect(bottom(footerBox)).toBeLessThanOrEqual(853);
        await page.keyboard.press("Escape");
      }
      const effort = composer.locator('[data-chat-thinking-select="true"]');
      await effort.press("Enter");
      await polledVisible(composer.locator(".chat-controls__effort-menu")).toBe(true);
      await effort.press("Tab");
      const focusedEffortControl = composer.locator(
        "[data-chat-thinking-slider]:not([disabled]), [data-chat-speed-option]:not([disabled])",
      );
      await polledFocus(focusedEffortControl.first()).toBe(true);
      await page.keyboard.press("Escape");
      await polledFocus(effort).toBe(true);
    });
  });

  it("keeps the microphone picker aligned during hover, hold and keyboard focus", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
      const gateway = await installMockGateway(page);
      await page.goto(suite.server.baseUrl + "chat");
      await gateway.waitForRequest("sessions.messages.subscribe");
      const textarea = page.locator(".agent-chat__input textarea");
      const voice = page.getByRole("button", { name: "Start voice input" });
      const microphonePicker = page.getByRole("button", { name: "Microphone input" });
      const microphonePickerShell = page.locator(".chat-talk-input-picker");
      const shellWidth = () =>
        microphonePickerShell.evaluate((node) => node.getBoundingClientRect().width);
      await polledVisible(voice).toBe(true);
      const pickerWidth = () =>
        microphonePicker.evaluate((node) => node.getBoundingClientRect().width);
      await expect.poll(pickerWidth).toBe(0);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      // Probe the actual hover transition inside its delay, independent of
      // browser round trips that can outlast the dwell time on a loaded host.
      const hoverDelay = await microphonePickerShell.evaluateHandle((node) => ({
        proof: new Promise<{ delay: number; width: number }>((resolve, reject) => {
          const onTransition = (event: Event) => {
            if (
              !(event instanceof TransitionEvent) ||
              event.target !== node ||
              event.propertyName !== "width"
            ) {
              return;
            }
            node.removeEventListener("transitionrun", onTransition);
            const transition = node
              .getAnimations()
              .find(
                (animation) =>
                  animation instanceof CSSTransition && animation.transitionProperty === "width",
              );
            if (!transition?.effect) {
              reject(new Error("Missing microphone width transition"));
              return;
            }
            transition.pause();
            const delay = transition.effect.getTiming().delay ?? 0;
            transition.currentTime = delay / 2;
            const width = node.getBoundingClientRect().width;
            transition.play();
            resolve({ delay, width });
          };
          node.addEventListener("transitionrun", onTransition);
        }),
      }));
      await voice.hover();
      const dwell = await hoverDelay.evaluate(({ proof }) => proof);
      await hoverDelay.dispose();
      expect(dwell.delay).toBeGreaterThan(0);
      expect(dwell.width).toBe(0);
      await expect.poll(pickerWidth).toBeGreaterThanOrEqual(27.5);
      const [voiceBeforeHold, pickerBeforeHold] = await Promise.all([
        voice.boundingBox(),
        microphonePicker.boundingBox(),
      ]);
      expect(voiceBeforeHold).not.toBeNull();
      expect(pickerBeforeHold).not.toBeNull();
      expect(
        Math.abs(
          (voiceBeforeHold?.x ?? 0) - ((pickerBeforeHold?.x ?? 0) + (pickerBeforeHold?.width ?? 0)),
        ),
      ).toBeLessThanOrEqual(0.5);
      // Measure the arming layout without letting slow browser round trips
      // cross the 500 ms hold threshold and open the unavailable-device picker.
      await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
      await page.mouse.down();
      await page.clock.runFor(150);
      await expect
        .poll(() =>
          voice.evaluate((node) => node.classList.contains("chat-send-btn--dictation-arming")),
        )
        .toBe(true);
      await polledVisible(microphonePicker).toBe(true);
      await expect.poll(pickerWidth).toBeGreaterThanOrEqual(12);
      const voiceDuringHold = await voice.boundingBox();
      expect(voiceDuringHold).not.toBeNull();
      expect(Math.abs((voiceDuringHold?.x ?? 0) - (voiceBeforeHold?.x ?? 0))).toBeLessThanOrEqual(
        1,
      );
      await page.mouse.up();
      await page.mouse.move(0, 0);
      await page.clock.resume();
      await expect.poll(pickerWidth).toBe(0);
      await voice.hover();
      await voice.press("Tab");
      await polledFocus(microphonePicker).toBe(true);
      await expect.poll(pickerWidth).toBeGreaterThanOrEqual(27.5);
      await textarea.click();
      await expect.poll(pickerWidth).toBe(0);
      await gateway.setOnline(false);
      await expect.poll(() => voice.isDisabled()).toBe(true);
      await page.mouse.move(0, 0);
      await polledCount(page.locator(".tooltip-surface[popover]:popover-open")).toBe(0);
      await expect.poll(shellWidth).toBe(0);

      await voice.hover();
      // Assert the settled hover reveal, including its delayed CSS transitions.
      await microphonePickerShell.evaluate((node) => {
        for (const animation of node.getAnimations({ subtree: true })) {
          animation.finish();
        }
      });
      await expect.poll(shellWidth).toBe(0);
      await polledVisible(microphonePicker).toBe(false);
    });
  });
});
