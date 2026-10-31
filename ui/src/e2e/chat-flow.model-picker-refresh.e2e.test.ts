import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { sanitizeChatHistoryMessages } from "../../../src/gateway/chat-display-projection.sanitize.ts";
import { selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
  newChatPage,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  thinkingLevels,
  chatSessionListResponse,
  expectRequestCountStable,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const attr = (root: Page | Locator, name: string, value = "true") =>
  root.locator(`[data-chat-${name}="${value}"]`);
const pickerFor = (page: Page) =>
  page.locator('openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker');
const selectedModel = (picker: ReturnType<typeof pickerFor>) =>
  attr(picker, "model-select").getAttribute("data-chat-select-value");
const modelInfo = (id: string, name: string, provider = "openai") => ({ id, name, provider });
const sessionInfo = (sessionId: string, model: string) => ({
  key: "agent:main:main",
  kind: "direct",
  updatedAt: 1,
  sessionId,
  model,
  modelProvider: "openai",
});
const defaultsFor = (model: string) => ({
  contextTokens: null,
  model,
  modelProvider: "openai",
  modelSelectionTarget: "global",
});
const bubble = (page: Page, text: string | RegExp) =>
  page.locator(".chat-bubble").getByText(text, { exact: true }).waitFor();
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
async function expectPatch(gateway: Gateway, params: Record<string, unknown>, after?: number) {
  const request = await gateway.waitForRequest("sessions.patch", { after });
  expect(requireRecord(request.params)).toMatchObject(params);
}

function roster<Row extends object, Defaults extends object>(
  session: Row,
  defaults: Defaults,
  ts = 1,
) {
  return { ts, path: "", count: 1, sessions: [session], defaults };
}

suite.define(() => {
  it("confirms remote model changes and records the submitted selection on reload", async () => {
    const page = await newChatPage(suite, {
      ...createControlUiE2eContextOptions(),
      hasTouch: true,
    });
    const session = sessionInfo("model-target-proof", "demo-a");
    const history = [
      { role: "user", content: "Plan a small herb garden.", timestamp: 1 },
      { role: "assistant", content: "Start with basil, mint, and parsley.", timestamp: 2 },
    ];
    const gateway = await installMockGateway(page, {
      sessionKey: session.key,
      historyMessages: history,
      models: [
        modelInfo("demo-a", "Demo model A"),
        { ...modelInfo("demo-b", "Demo model B"), alias: "Demo-model B" },
        { ...modelInfo("demo-local", "Demo local model"), local: true },
      ],
      methodResponses: {
        "sessions.list": roster(session, defaultsFor(session.model)),
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const picker = pickerFor(page);
    await expect.poll(() => attr(picker, "model-select").textContent()).toContain("Demo model A");
    await attr(picker, "model-select").tap();
    await picker.locator('[data-chat-model-option="openai/demo-b"]').waitFor();
    await expect.poll(() => picker.locator("[data-chat-model-selection-target]").count()).toBe(0);

    await picker.locator('[data-chat-model-option="openai/demo-b"]').tap();
    const dialog = page.getByRole("dialog", { name: "Switch to Demo model B?", exact: true });
    await dialog.waitFor();
    await dialog
      .getByText("This conversation is cached for Demo model A.", { exact: false })
      .waitFor();
    await dialog.getByRole("checkbox", { name: "Don’t ask again", exact: true }).check();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    expect(await selectedModel(picker)).toBe("openai/demo-a");
    await attr(picker, "model-select").tap();
    await picker.locator('[data-chat-model-option="openai/demo-b"]').tap();
    await dialog.getByRole("button", { name: "Switch model", exact: true }).click();
    await expectPatch(gateway, { key: session.key, model: "openai/demo-b" });
    await expect.poll(() => selectedModel(picker)).toBe("openai/demo-b");

    await gateway.setSessionsListResponse(
      roster(
        {
          ...session,
          model: "demo-b",
          modelOverrideSource: "user",
          updatedAt: 2,
        },
        defaultsFor("demo-b"),
        2,
      ),
    );

    expect(
      await page.locator(".chat-divider__title").filter({ hasText: "Model changed" }).count(),
    ).toBe(0);
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await composer.fill("Suggest a watering schedule.");
    const noticeLoading = await page.evaluateHandle(() => {
      const seen = { loading: false };
      const observer = new MutationObserver(() => {
        seen.loading ||= Array.from(document.querySelectorAll('.chat-group[role="status"]')).some(
          (status) => status.textContent?.includes("Loading"),
        );
      });
      observer.observe(document.body, { childList: true, subtree: true });
      return { seen, observer };
    });
    await composer.press("Enter");
    const send = await gateway.waitForRequest("chat.send");
    const sent = {
      role: "user",
      content: "Suggest a watering schedule.",
      timestamp: 3,
      __openclaw: {
        id: "model-input",
        seq: 3,
        modelSelection: {
          provider: "openai",
          model: "demo-b",
          previous: { provider: "openai", model: "demo-a" },
        },
      },
    };
    await gateway.setMethodResponse("chat.history", {
      messages: sanitizeChatHistoryMessages([...history, sent]),
      sessionId: session.sessionId,
    });
    await gateway.emitGatewayEvent("chat", {
      sessionKey: session.key,
      runId: requireRecord(send.params).idempotencyKey,
      state: "final",
    });
    await gateway.emitGatewayEvent("sessions.changed", {
      sessionKey: session.key,
      phase: "message",
      ts: 3,
    });
    const noticeLine = page.locator(".chat-divider__title").filter({
      hasText: "Model changed from Demo model A to Demo model B.",
    });
    await noticeLine.waitFor();
    expect(
      await noticeLoading.evaluate(({ seen, observer }) => {
        observer.disconnect();
        return seen.loading;
      }),
    ).toBe(false);
    await noticeLoading.dispose();
    await page.reload();
    await noticeLine.waitFor();
    await expect.poll(() => selectedModel(picker)).toBe("openai/demo-b");
    await attr(picker, "model-select").tap();
    await picker.getByRole("option", { name: "Demo local model", exact: true }).tap();
    await expectPatch(gateway, { key: session.key, model: "openai/demo-local" });
    expect(await dialog.count()).toBe(0);
    await attr(picker, "model-select").tap();
    await picker.getByRole("option", { name: "Demo model A", exact: true }).tap();
    const optOut = page.getByRole("dialog", { name: "Switch to Demo model A?", exact: true });
    await optOut.getByRole("checkbox", { name: "Don’t ask again", exact: true }).check();
    await optOut.getByRole("button", { name: "Switch model", exact: true }).click();
    await expectPatch(gateway, { key: session.key, model: "openai/demo-a" });
    await gateway.setSessionsListResponse(
      roster({ ...session, model: "demo-a" }, defaultsFor("demo-a")),
    );
    await page.reload();
    await expect.poll(() => selectedModel(picker)).toBe("openai/demo-a");
    await attr(picker, "model-select").tap();
    await picker.locator('[data-chat-model-option="openai/demo-b"]').tap();
    await expectPatch(gateway, { key: session.key, model: "openai/demo-b" });
    expect(await dialog.count()).toBe(0);
    await page.setViewportSize({ height: 900, width: 400 });
    await page.locator(".agent-chat__composer-combobox textarea").tap();
    await attr(picker, "model-select").tap();
    await attr(picker, "model-default").waitFor();
    await expect.poll(() => picker.locator("[data-chat-model-selection-target]").count()).toBe(0);

    const defaultRow = attr(picker, "model-default");
    await expect
      .poll(async () => {
        const bounds = await defaultRow.boundingBox();
        return Boolean(
          bounds && bounds.width > 0 && bounds.x >= 0 && bounds.x + bounds.width <= 401,
        );
      })
      .toBe(true);

    const configureModels = picker
      .getByRole("button", { name: "Configure models", exact: true })
      .first();
    await expect
      .poll(() =>
        configureModels.evaluate((button) => {
          const heading = button.closest<HTMLElement>("[data-chat-model-provider]");
          const gap = heading
            ? heading.getBoundingClientRect().right - button.getBoundingClientRect().right
            : Number.POSITIVE_INFINITY;
          const icons = button.querySelectorAll("svg");
          return {
            aligned: gap <= 11,
            smallIcon: icons.length === 1 && icons[0]!.getBoundingClientRect().width <= 12,
          };
        }),
      )
      .toEqual({ aligned: true, smallIcon: true });
    await configureModels.hover();
    await page.waitForTimeout(800);
    const configureModelsTooltip = page.locator(".tooltip-surface[popover]:popover-open").filter({
      hasText: "Configure models",
    });
    await expect.poll(() => configureModelsTooltip.count()).toBe(0);

    await configureModels.tap();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
    expect(new URL(page.url()).searchParams.get("provider")).toBe("openai");
    expect(new URL(page.url()).searchParams.has("connect")).toBe(false);
    await page.locator('[data-provider-id="openai"]').waitFor({ state: "visible" });
  });

  it("applies provider-specific reasoning after the selected model is saved", async () => {
    const page = await newChatPage(suite);
    const sessionKey = "agent:main:session-a";
    const fableSession = {
      key: sessionKey,
      kind: "direct",
      label: "Session A",
      model: "claude-fable-5",
      modelProvider: "anthropic",
      thinkingDefault: "high",
      thinkingLevel: "high",
      thinkingLevels: thinkingLevels("off", "adaptive", "high", "xhigh", "max"),
      updatedAt: 2,
    };
    const solSession = {
      ...fableSession,
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      thinkingLevels: thinkingLevels("off", "low", "medium", "high", "ultra"),
    };
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.patch"],
      methodResponses: {
        "sessions.list": chatSessionListResponse([fableSession]),
      },
      models: [
        modelInfo("claude-fable-5", "Claude Fable 5", "anthropic"),
        modelInfo("gpt-5.6-sol", "GPT-5.6 Sol"),
      ],
      sessionKey,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));

    const main = page.getByRole("main");
    await attr(main, "model-select").click();
    await selectChatModelOption(main, "openai/gpt-5.6-sol");

    await expectPatch(gateway, { key: sessionKey, model: "openai/gpt-5.6-sol" });
    const thinkingSlider = attr(main, "thinking-slider");
    const effortSelect = attr(main, "thinking-select");
    await effortSelect.evaluate((trigger) => {
      const details = trigger.closest("details")!;
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    await expect
      .poll(async () => ({
        effortDisabled: await effortSelect.getAttribute("data-chat-thinking-disabled"),
        effortAriaDisabled: await effortSelect.getAttribute("aria-disabled"),
        sliderDisabled: await thinkingSlider.isDisabled(),
      }))
      .toEqual({
        effortDisabled: "true",
        effortAriaDisabled: "true",
        sliderDisabled: true,
      });
    await thinkingSlider.evaluate((input) => {
      const slider = input as HTMLInputElement;
      slider.value = slider.max;
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expectRequestCountStable(gateway, "sessions.patch", 1);
    await page.keyboard.press("Escape");

    await gateway.setMethodResponse("sessions.list", chatSessionListResponse([solSession]));
    const sessionsListCount = (await gateway.getRequests("sessions.list")).length;
    await gateway.resolveDeferred("sessions.patch");
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list")).length)
      .toBeGreaterThan(sessionsListCount);
    await effortSelect.click();
    await expect
      .poll(() => thinkingSlider.getAttribute("data-chat-thinking-values"))
      .toContain("ultra");
    await expect.poll(() => thinkingSlider.isEnabled()).toBe(true);

    await thinkingSlider.evaluate((input) => {
      const slider = input as HTMLInputElement;
      const values = (slider.dataset.chatThinkingValues ?? "").split(",");
      slider.value = String(values.indexOf("ultra"));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expectPatch(gateway, { key: sessionKey, thinkingLevel: "ultra" }, 1);
    await expect.poll(() => page.getByText(/not supported for/u).count()).toBe(0);
  });

  it("saves model, reasoning, and speed while the admitted reply continues", async () => {
    await suite.withPage({ viewport: { width: 1200, height: 853 } }, async ({ page }) => {
      const key = "agent:main:live-preferences";
      const levels = [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ];
      const defaults = {
        model: "example-a",
        modelProvider: "example",
        thinkingDefault: "low",
        thinkingLevels: levels,
      };
      const row = {
        ...defaults,
        key,
        sessionId: "live-preferences",
        kind: "direct",
        updatedAt: 1,
        modelOverrideSource: "user",
        thinkingLevel: "low",
      };
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        agentModel: "example/example-a",
        sessions: [row],
        models: ["a", "b"].map((id) => ({
          id: "example-" + id,
          name: "Example " + id.toUpperCase(),
          provider: "example",
          thinkingLevels: levels,
          thinkingDefault: "low",
          supportsFastMode: true,
        })),
        methodResponses: {
          "sessions.list": roster(row, defaults),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await page
        .locator(".agent-chat__composer-combobox textarea")
        .fill("Keep explaining the garden plan.");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const send = await gateway.waitForRequest("chat.send");
      const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
      const emitText = (text: string) =>
        gateway.emitGatewayEvent("chat", {
          sessionKey: key,
          runId,
          state: "delta",
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
      await emitText("The first reply is still running.");
      await bubble(page, "The first reply is still running.");
      const main = page.getByRole("main");
      const model = main.locator("[data-chat-model-select]");
      const effort = main.locator("[data-chat-thinking-select]");
      await gateway.deferNext("sessions.patch");
      await model.click();
      await selectChatModelOption(main, "example/example-b");
      await page
        .getByRole("dialog", { name: "Switch to Example B?", exact: true })
        .getByRole("button", { name: "Switch model", exact: true })
        .click();
      await expectPatch(gateway, { key, model: "example/example-b" });
      await expect.poll(() => model.textContent()).toContain("Example B");
      expect(await effort.getAttribute("aria-disabled")).toBe("true");
      await gateway.resolveDeferred("sessions.patch");
      await expect.poll(() => effort.getAttribute("aria-disabled")).toBe("false");
      // Execution metadata belongs to the existing run, not the preference selector.
      const saved = await gateway.getSessionRow(key);
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: key,
        runId,
        phase: "model",
        agentId: "main",
        session: {
          ...saved,
          hasActiveRun: true,
          activeRunIds: [runId],
          activeModel: "example-a",
          activeModelProvider: "example",
          updatedAt: Date.now(),
        },
      });
      await effort.click();
      const slider = main.locator("[data-chat-thinking-slider]");
      // The mounted slider is enabled before the popup can receive keyboard focus.
      await expect.poll(() => slider.isVisible()).toBe(true);
      await expect.poll(() => slider.isEnabled()).toBe(true);
      const speed = main.locator("[data-chat-speed-option=on]");
      expect(await speed.isEnabled()).toBe(true);
      await speed.click();
      await expectPatch(gateway, { key, fastMode: true }, 1);
      await speed.and(main.locator('[aria-checked="true"]')).waitFor({ state: "visible" });
      await slider.press("End");
      await expectPatch(gateway, { key, thinkingLevel: "high" }, 2);
      await emitText(
        "The first reply is still running. Its next chunk arrived after the settings changed.",
      );
      await bubble(page, /Its next chunk arrived after the settings changed/);
      await expect.poll(() => model.textContent()).toContain("Example B");
      await expect.poll(() => effort.textContent()).toContain("High");
      expect(await gateway.getSessionRow(key)).toMatchObject({
        model: "example/example-b",
        thinkingLevel: "high",
        fastMode: true,
      });
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      const stop = page.getByRole("button", { name: "Stop generating", exact: true });
      expect(await stop.count()).toBe(1);
      await gateway.emitChatFinal({ runId, text: "The first reply finished normally." });
      await bubble(page, "The first reply finished normally.");
      await expect.poll(() => model.textContent()).toContain("Example B");
    });
  });
});
