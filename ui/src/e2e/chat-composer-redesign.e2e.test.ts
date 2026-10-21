import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import {
  openChatConversationOptions,
  selectChatLayoutAction,
} from "../test-helpers/chat-layout-menu.ts";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatModelPicker, revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
  bottom,
  centerX,
  centerY,
  layoutBox,
  right,
  twoFrames,
  exactButton,
  polledAncestor,
  polledFocus,
  polledAttribute,
  polledCount,
  polledStyle,
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
const pickerPopup = (kind: "model" | "effort") =>
  `.chat-controls__${kind}-picker > [data-anchored-overlay]`;

suite.define(() => {
  it.each([
    {
      reason: "missing-auth",
      blocked: true,
      message: "No provider credential is configured for this model. Set it up in Model Setup.",
    },
    {
      reason: "auth-failed",
      blocked: true,
      message: "Authentication failed. Review the provider credential or sign-in, then retry.",
    },
    { reason: "cooldown", blocked: false, message: null },
    { reason: undefined, blocked: false, message: null },
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
          await gateway.waitForRequest("chat.startup");
          const textarea = page.locator(".agent-chat__composer-combobox textarea");
          const sendButton = exactButton(page, "Send message");
          await expect.poll(() => textarea.isDisabled()).toBe(false);
          await textarea.fill("Send while availability recovers");
          await expect.poll(() => sendButton.isDisabled()).toBe(blocked);
          expect(await textarea.inputValue()).toBe("Send while availability recovers");
          const statusBand = page.locator(".agent-chat__composer-status-band");
          const setupBanner = page.locator(".agent-chat__disabled-banner");
          await polledCount(statusBand).toBe(0);
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
          await revealChatModelOption(option);
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
        inFlightRun: { runId: "auth-failed-run", text: "" },
        models: [modelFixture({ available: false, unavailableReason: "auth-failed" })],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
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
      await gateway.waitForRequest("chat.startup");

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
        const popup = pickerPopup(kind);
        const visibleTrigger = composer.locator(trigger);
        await polledVisible(visibleTrigger).toBe(true);
        await visibleTrigger.click();
        // The popup scales while opening; measure its settled viewport bounds.
        await waitForControlUiProofSurface(composer.locator(popup), [page.locator(menu)]);
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

  it("keeps the model in the bottom bar, session settings in the header, and holds send beside the microphone in every input state", async () => {
    const pageOptions = {
      viewport: { width: 1920, height: 1080 },
    };
    await suite.withPage(pageOptions, async ({ page }) => {
      await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
      const gateway = await installMockGateway(page, {
        assistantName: "Rosita",
        deferredMethods: ["chat.send"],
        models: [
          modelFixture(),
          {
            id: "gpt-5.4-pro",
            name: "GPT-5.4 Pro",
            provider: "openai",
            available: true,
          },
          {
            id: "gpt-5.3-codex-spark",
            name: "GPT-5.3 Codex Spark",
            provider: "codex",
            available: false,
          },
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            provider: "anthropic",
          },
        ],
        methodResponses: {
          "config.get": {
            config: { ui: { prefs: { chatFollowUpMode: "steer" } } },
            hash: "composer-redesign-config",
            issues: [],
            raw: JSON.stringify({ ui: { prefs: { chatFollowUpMode: "steer" } } }),
            valid: true,
          },
          "models.authStatus": {
            ts: Date.now(),
            providers: [
              {
                provider: "openai",
                displayName: "Codex",
                status: "ok",
                profiles: [{ profileId: "codex", type: "oauth", status: "ok" }],
                usage: { providerId: "openai", windows: [{ label: "Week", usedPercent: 72 }] },
              },
            ],
          },
          "sessions.list": {
            count: 1,
            defaults: {
              contextTokens: 200_000,
              model: "gpt-5.5",
              modelProvider: "openai",
              thinkingDefault: "high",
              thinkingLevels: ["off", "low", "medium", "high"].map((id) => ({ id, label: id })),
            },
            path: "",
            sessions: [
              {
                contextTokens: 200_000,
                displayName: "Main",
                hasActiveRun: false,
                key: "agent:main:main",
                kind: "direct",
                label: "Main",
                model: "gpt-5.5",
                modelProvider: "openai",
                permissionMode: "workspace",
                status: "done",
                totalTokens: 46_000,
                totalTokensFresh: true,
                updatedAt: Date.now(),
              },
            ],
            ts: Date.now(),
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");

      const composer = page.locator(".agent-chat__input");
      const composerShell = page.locator(".agent-chat__composer-shell");
      const chatContent = page.locator("main.content--chat");
      const chatMain = page.locator(".chat-main__conversation");
      const model = composer.locator('[data-chat-model-select="true"]');
      const effort = composer.locator('[data-chat-thinking-select="true"]');
      const usage = composer.locator('[data-chat-provider-usage="true"]');
      const contextUsage = composer.locator(".context-ring");
      const permission = composer.locator('[data-chat-permission-select="true"]');
      const permissionIcon = permission.locator(".chat-controls__permission-icon svg");
      const textarea = composer.locator("textarea");
      const attach = composer.locator(
        'button.agent-chat__input-btn--attach[aria-label="Add attachment"]',
      );
      const camera = composerShell.locator(".agent-chat__camera-btn");
      const takePhoto = composerShell.getByRole("menuitem", { name: "Take photo" });
      const settings = page.locator(".chat-header-session-menu__trigger");
      const panels = page
        .locator(".sidebar-region__panels-toggle")
        .getByRole("button", { name: "Panels", exact: true });
      const voice = page.getByRole("button", { name: "Start voice input" });
      const send = page.getByRole("button", { name: "Send message" });
      const mobileDictation = page.getByRole("button", { name: "Dictation" });
      const microphonePicker = page.getByRole("button", { name: "Microphone input" });
      const microphonePickerShell = page.locator(".chat-talk-input-picker");
      const shellWidth = () =>
        microphonePickerShell.evaluate((node) => node.getBoundingClientRect().width);
      const permissionIconCenterError = async () => {
        const [triggerBox, iconBox] = await Promise.all([
          permission.boundingBox(),
          permissionIcon.boundingBox(),
        ]);
        if (!triggerBox || !iconBox) {
          return Number.POSITIVE_INFINITY;
        }
        const x = centerX(iconBox) - centerX(triggerBox);
        const y = centerY(iconBox) - centerY(triggerBox);
        return Math.max(Math.abs(x), Math.abs(y));
      };

      await polledVisible(model).toBe(true);
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);
      await gateway.waitForRequest("models.list");
      await polledVisible(contextUsage).toBe(true);
      await polledVisible(usage).toBe(false);
      await polledVisible(settings).toBe(true);
      await polledVisible(panels).toBe(true);
      await polledVisible(attach).toBe(true);
      await polledVisible(camera).toBe(false);
      await polledVisible(voice).toBe(true);
      const emptySend = page.getByRole("button", { name: "Write a message to send." });
      await polledVisible(emptySend).toBe(true);
      await expect.poll(() => emptySend.isDisabled()).toBe(true);
      await expect
        .poll(() => page.getByRole("button", { name: "Start video talk" }).count())
        .toBe(0);
      await polledAncestor(attach, ".agent-chat__composer-lead").toBe(true);
      await polledAncestor(voice, ".agent-chat__composer-trail").toBe(true);
      const pickerWidth = () =>
        microphonePicker.evaluate((node) => node.getBoundingClientRect().width);
      await expect.poll(pickerWidth).toBe(0);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await voice.hover();
      await polledStyle(microphonePickerShell, "transitionDelay").toBe("0.75s");
      await polledStyle(microphonePicker, "transitionDelay").toBe("0.75s, 0.75s, 0.82s, 0s, 0s");
      await twoFrames(page);
      expect(await pickerWidth()).toBe(0);
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
      await polledStyle(microphonePickerShell, "transitionDelay").toBe("0s, 0s");
      await expect.poll(pickerWidth).toBeGreaterThanOrEqual(27.5);
      await textarea.click();
      await expect.poll(pickerWidth).toBe(0);
      await polledAncestor(model, ".agent-chat__composer-footer").toBe(true);
      await polledAncestor(settings, ".chat-pane__header").toBe(true);
      await polledCount(composer.locator(".agent-chat__composer-header")).toBe(0);
      await expect
        .poll(async () =>
          (await model.locator(".chat-controls__inline-select-label").textContent())?.trim(),
        )
        .toBe("GPT-5.5");
      await expect
        .poll(async () =>
          (await effort.locator(".chat-controls__inline-select-label").textContent())?.trim(),
        )
        .toBe("High");
      await polledCount(contextUsage.locator(".context-ring__detail")).toBe(0);
      await polledAttribute(contextUsage, "aria-label").toBe(
        "Session context usage: 46k of 200k (23%)",
      );
      await polledAncestor(contextUsage, ".agent-chat__composer-meta").toBe(true);
      await contextUsage.click();
      await polledVisible(usage).toBe(true);
      await expect
        .poll(async () =>
          (await composer.locator(".context-usage__limit").first().textContent())
            ?.replace(/\s+/g, " ")
            .trim(),
        )
        .toBe("Weekly 72%");
      await contextUsage.click();

      await effort.click();
      const thinkingSlider = composer.locator('[data-chat-thinking-slider="true"]');
      const fastOption = composer.locator('[data-chat-speed-option="on"]');
      await polledVisible(thinkingSlider).toBe(true);
      await polledAttribute(thinkingSlider, "data-chat-thinking-values").toBe(
        "off,low,medium,high",
      );
      await expect.poll(() => thinkingSlider.inputValue()).toBe("3");
      await polledAttribute(fastOption, "aria-checked").toBe("false");
      // Reasoning and speed commit immediately while the Effort picker stays open.
      await thinkingSlider.press("Home");
      await thinkingSlider.press("ArrowRight");
      await expect
        .poll(() => gateway.getRequests("sessions.patch"))
        .toContainEqual(
          expect.objectContaining({ params: expect.objectContaining({ thinkingLevel: "low" }) }),
        );
      await polledAttribute(effort, "data-chat-thinking-value").toBe("low");
      await expect.poll(() => thinkingSlider.inputValue()).toBe("1");
      await fastOption.click();
      await expect
        .poll(() => gateway.getRequests("sessions.patch"))
        .toContainEqual(
          expect.objectContaining({ params: expect.objectContaining({ fastMode: true }) }),
        );
      await polledAttribute(fastOption, "aria-checked").toBe("true");
      await page.keyboard.press("Escape");
      await polledVisible(composer.locator(".chat-controls__effort-menu")).toBe(false);
      await effort.click();
      await polledAttribute(fastOption, "aria-checked").toBe("true");
      await polledCount(composer.locator('[data-chat-thinking-slider="true"]')).toBe(1);
      await page.keyboard.press("Escape");
      await model.click();
      const providerHeadings = composer.locator(
        "[data-chat-model-provider] .chat-controls__provider-label",
      );
      await expect
        .poll(async () => (await providerHeadings.allTextContents()).map((label) => label.trim()))
        .toEqual(["OpenAI", "Anthropic"]);
      await polledText(composer.locator('[data-chat-model-provider-group="openai"]')).toContain(
        "GPT-5.4 Pro",
      );
      const anthropicModels = composer.locator('[data-chat-model-provider-group="anthropic"]');
      await polledVisible(anthropicModels).toBe(true);
      await polledText(anthropicModels).toContain("Claude Sonnet 4.6");
      await model.click();

      const [
        chatContentBox,
        chatMainBox,
        composerShellBox,
        composerBox,
        modelBox,
        textareaBox,
        attachBox,
        voiceBox,
      ] = await Promise.all([
        layoutBox(chatContent),
        layoutBox(chatMain),
        layoutBox(composerShell),
        layoutBox(composer),
        layoutBox(model),
        layoutBox(textarea),
        layoutBox(attach),
        layoutBox(voice),
      ]);

      expect(Math.abs(chatMainBox.x - chatContentBox.x)).toBeLessThanOrEqual(1);
      expect(composerShellBox.width).toBeGreaterThanOrEqual(767);
      expect(composerShellBox.width).toBeLessThanOrEqual(769);
      expect(Math.abs(centerX(composerShellBox) - centerX(chatMainBox))).toBeLessThanOrEqual(1);
      expect(composerBox.height).toBeLessThanOrEqual(120);
      expect(modelBox.y).toBeGreaterThanOrEqual(textareaBox.y);
      expect(right(attachBox)).toBeLessThanOrEqual(right(composerBox) + 1);
      expect(voiceBox.x).toBeGreaterThanOrEqual(right(attachBox) - 1);
      expect(right(voiceBox)).toBeLessThanOrEqual(right(composerBox) + 1);
      await expect
        .poll(() =>
          voice.evaluate((node) => {
            const bounds = node.getBoundingClientRect();
            return (
              bounds.width === bounds.height &&
              Number.parseFloat(getComputedStyle(node).borderRadius) >= bounds.width / 2
            );
          }),
        )
        .toBe(true);

      await page.setViewportSize({ width: 1280, height: 900 });
      // Details keeps its DOM when it releases its reserved column.
      await page.locator(".chat-details--docked").waitFor({ state: "hidden" });
      await waitForLayoutSettled(
        page,
        ".chat-pane-cache__pane--active :is(.chat-main__conversation, .agent-chat__composer-shell)",
      );
      const [compactChatMainBox, compactComposerShellBox] = await Promise.all([
        layoutBox(chatMain),
        layoutBox(composerShell),
      ]);

      expect(compactComposerShellBox.width).toBeGreaterThanOrEqual(767);
      expect(compactComposerShellBox.width).toBeLessThanOrEqual(769);
      expect(
        Math.abs(centerX(compactComposerShellBox) - centerX(compactChatMainBox)),
      ).toBeLessThanOrEqual(1);

      await settings.click();
      const viewDropdown = page.locator(".chat-header-session-menu");
      const viewMenu = viewDropdown.getByRole("menuitem", { name: "View", exact: true });
      await polledVisible(viewMenu).toBe(true);
      await viewMenu.hover();
      await expect
        .poll(() =>
          viewDropdown
            .getByRole("menu", { name: "View", exact: true })
            .getByRole("menuitemcheckbox")
            .locator(".session-menu__text")
            .allTextContents(),
        )
        .toEqual(["Reasoning", "Tool calls", "Keep commentary"]);
      expect(
        await viewDropdown.getByRole("menuitemcheckbox", { name: "Speech bubbles" }).count(),
      ).toBe(0);
      const reasoning = viewDropdown.getByRole("menuitemcheckbox", { name: "Reasoning" });
      await polledVisible(reasoning).toBe(true);
      await polledAttribute(reasoning, "aria-checked").toBe("true");
      await reasoning.click();
      await polledAttribute(reasoning, "aria-checked").toBe("false");
      await reasoning.click();
      await polledAttribute(reasoning, "aria-checked").toBe("true");
      await settings.click();
      await polledAttribute(settings, "aria-expanded").toBe("false");

      await textarea.fill("Send this message");
      await polledVisible(send).toBe(true);
      await polledVisible(voice).toBe(true);
      const brandFill = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = getComputedStyle(document.documentElement)
          .getPropertyValue("--primary")
          .trim();
        document.body.append(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        return resolved;
      });
      await polledStyle(send, "backgroundColor").toBe(brandFill);

      await send.click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const runId =
        isRecord(sendRequest.params) && "idempotencyKey" in sendRequest.params
          ? String(sendRequest.params.idempotencyKey)
          : "";
      // Pre-first-token: the thread explains the active turn without a duplicate composer row.
      const spark = page.locator(".chat-reading-indicator");
      await polledVisible(spark).toBe(true);
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      await polledVisible(spark).toBe(true);
      const announcement = composer.locator(".agent-chat__run-status-announcement");
      await polledText(announcement).toContain("Rosita is");
      expect(await composerShell.locator(".agent-chat__composer-run-status").count()).toBe(0);
      await gateway.emitGatewayEvent("chat", {
        deltaText: "Working on it.",
        message: {
          content: [{ text: "Working on it.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "agent:main:main",
        state: "delta",
      });
      // Answer publication ends visual activity while queue and Stop stay owned.
      await polledVisible(page.getByText("Working on it.").first()).toBe(true);
      await polledCount(spark).toBe(0);
      await polledText(announcement).toBe("");
      await polledVisible(panels).toBe(true);
      await polledVisible(model).toBe(true);
      await textarea.fill("Steer this queued follow-up");
      const followUp = page.getByRole("button", {
        name: /^(Queue message|Steer into the active run)$/,
      });
      await polledVisible(followUp).toBe(true);
      await polledCount(page.locator(".chat-send-btn--stop")).toBe(0);
      await page.setViewportSize({ width: 393, height: 852 });
      await textarea.click();

      await textarea.fill("");
      const stop = page.getByRole("button", { name: "Stop generating" });
      await polledVisible(stop).toBe(true);
      await polledStyle(stop, "backgroundColor").not.toBe(brandFill);
      const mobileModelSettings = composer.locator('[data-chat-model-select="true"]');
      await polledVisible(mobileModelSettings).toBe(true);
      const [activeMobileSettingsBox, activeMobileStopBox] = await Promise.all([
        mobileModelSettings.boundingBox(),
        stop.boundingBox(),
      ]);
      expect(activeMobileSettingsBox?.width).toBeGreaterThanOrEqual(44);
      expect(activeMobileSettingsBox?.height).toBeGreaterThanOrEqual(44);
      expect(activeMobileStopBox?.width).toBeCloseTo(32, 2);
      expect(activeMobileStopBox?.height).toBeCloseTo(32, 2);
      expect(await composerShell.locator(".agent-chat__composer-run-status").count()).toBe(0);
      await textarea.press("Escape");
      const abortRequest = await gateway.waitForRequest("chat.abort");
      expect(abortRequest.params).toMatchObject({
        runId,
        sessionKey: "agent:main:main",
      });
      await polledCount(stop).toBe(0);

      await textarea.fill("");
      await polledVisible(mobileDictation).toBe(true);
      const mobileTalk = page.getByRole("button", { name: "Tap to talk" });
      await polledVisible(mobileTalk).toBe(true);
      await expect
        .poll(async () => {
          const [voiceRect, sendRect] = await Promise.all([
            mobileDictation.boundingBox(),
            mobileTalk.boundingBox(),
          ]);
          return voiceRect && sendRect ? sendRect.x - right(voiceRect) : null;
        })
        .toBeGreaterThanOrEqual(-1);

      await polledCount(camera).toBe(0);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);
      await expect.poll(shellWidth).toBe(0);
      // Resize re-layout is async; wait for the header controls to adopt the
      // mobile width before sampling one-shot bounding boxes below.
      await expect
        .poll(async () => {
          const settled = await settings.boundingBox();
          return settled ? right(settled) : Number.POSITIVE_INFINITY;
        })
        .toBeLessThanOrEqual(393);
      await polledVisible(mobileModelSettings).toBe(true);
      await polledVisible(effort).toBe(true);
      await permission.click();
      await polledVisible(composer.locator(".chat-controls__permission-option").first()).toBe(true);
      await page.keyboard.press("Escape");
      const [
        mobileAttachBox,
        mobileModelSettingsBox,
        mobileSettingsBox,
        mobileContextBox,
        mobileVoiceBox,
      ] = await Promise.all([
        layoutBox(attach),
        layoutBox(mobileModelSettings),
        layoutBox(settings),
        layoutBox(contextUsage),
        layoutBox(mobileDictation),
      ]);

      expect(mobileModelSettingsBox.width).toBeGreaterThanOrEqual(44);
      expect(mobileModelSettingsBox.height).toBeGreaterThanOrEqual(44);
      await expect.poll(permissionIconCenterError).toBeLessThanOrEqual(1);
      expect(
        Math.abs(centerY(mobileContextBox) - centerY(mobileModelSettingsBox)),
      ).toBeLessThanOrEqual(1);
      expect(right(mobileContextBox)).toBeLessThanOrEqual(mobileModelSettingsBox.x);
      expect(mobileSettingsBox.x).toBeGreaterThanOrEqual(0);
      expect(right(mobileSettingsBox)).toBeLessThanOrEqual(393);
      expect(right(mobileAttachBox)).toBeLessThanOrEqual(mobileVoiceBox.x + 1);
      await page.setViewportSize({ width: 560, height: 852 });
      await expect.poll(permissionIconCenterError).toBeLessThanOrEqual(1);
      await page.setViewportSize({ width: 393, height: 852 });
      await expect
        .poll(async () => {
          const [polledAttachBox, polledVoiceBox] = await Promise.all([
            attach.boundingBox(),
            mobileDictation.boundingBox(),
          ]);
          if (!polledAttachBox || !polledVoiceBox) {
            return Number.POSITIVE_INFINITY;
          }
          return Math.abs(centerY(polledAttachBox) - centerY(polledVoiceBox));
        })
        .toBeLessThanOrEqual(2);
      await attach.click();
      await polledVisible(takePhoto).toBe(true);
      await expect
        .poll(() => composerShell.getByRole("menuitem", { name: "Photo", exact: true }).isVisible())
        .toBe(true);
      await expect
        .poll(() => composerShell.getByRole("menuitem", { name: "File", exact: true }).isVisible())
        .toBe(true);
      await page.keyboard.press("Escape");
      await textarea.fill("Keep camera access in the attachment menu");
      await polledCount(camera).toBe(0);
      await polledVisible(send).toBe(true);
      await textarea.fill("");
      await polledCount(camera).toBe(0);
      await openChatModelPicker(composer);
      await revealChatModelOption(composer.locator('[data-chat-model-option="openai/gpt-5.5"]'));
      const mobilePickerBox = await layoutBox(composer.locator(".chat-controls__model-menu"));
      expect(mobilePickerBox.x).toBeGreaterThanOrEqual(0);
      expect(right(mobilePickerBox)).toBeLessThanOrEqual(393);
      expect(
        await composer
          .locator(".chat-controls__model-menu")
          .getByText(/Effort|Speed/)
          .count(),
      ).toBe(0);
      await page.keyboard.press("Escape");
      await effort.click();
      await polledVisible(composer.locator(".chat-controls__effort-menu")).toBe(true);
      await page.keyboard.press("Escape");
      const mobileOptions = await openChatConversationOptions(page);
      await polledVisible(
        mobileOptions.getByRole("button", { name: "Reasoning", exact: true }),
      ).toBe(true);
      await selectChatLayoutAction(page, "Side panel");
      await polledVisible(mobileOptions).toBe(false);

      await page.setViewportSize({ width: 1280, height: 900 });
      await gateway.setOnline(false);
      await expect.poll(() => voice.isDisabled()).toBe(true);
      await polledStyle(microphonePicker, "backgroundColor").toBe("rgba(0, 0, 0, 0)");
      await polledStyle(microphonePicker, "borderLeftWidth").toBe("0px");
      await page.mouse.move(0, 0);
      await polledCount(page.locator(".tooltip-surface[popover]:popover-open")).toBe(0);
      await expect.poll(shellWidth).toBe(0);
      await polledStyle(voice, "opacity").toBe("0.4");

      await voice.hover();
      await expect.poll(shellWidth).toBe(0);
      await polledVisible(microphonePicker).toBe(false);
    });
  });
});
