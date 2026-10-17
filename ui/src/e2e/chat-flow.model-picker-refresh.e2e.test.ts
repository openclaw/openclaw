import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol/frame-guards";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { revealChatModelOption, selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
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
  it("opens the chat picker from a partial snapshot while catalog revalidation is pending", async () => {
    const page = await newChatPage(suite);
    const sessionKey = "agent:main:main";
    const prepared = { ...modelInfo("prepared", "Prepared model", "fixture"), available: true };
    const added = { ...prepared, id: "added", name: "Added model" };
    const gateway = await installMockGateway(page, {
      connectCapabilities: [GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT],
      sessionKey,
      models: [],
      heldMethods: ["models.list"],
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    await gateway.waitForRequest("models.list");
    await gateway.emitGatewayEvent("models.snapshot", {
      target: { agentId: "main", sessionKey },
      scope: { agentId: "main", sessionKey },
      catalog: { models: [prepared], refreshFailed: true },
    });
    const picker = pickerFor(page);
    await picker.locator("[data-chat-model-select]").click();
    const preparedRow = attr(picker, "model-option", "fixture/prepared");
    await revealChatModelOption(preparedRow);
    await expect.poll(() => preparedRow.isVisible()).toBe(true);
    expect(await preparedRow.isEnabled()).toBe(true);

    await gateway.resolveDeferred("models.list", { models: [prepared, added] });
    await expect.poll(() => attr(picker, "model-option", "fixture/added").isVisible()).toBe(true);
    expect(await picker.getAttribute("open")).not.toBeNull();
  });

  it("preserves the Gateway-resolved target without exposing it in the picker", async () => {
    const page = await newChatPage(suite, {
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const session = sessionInfo("model-target-proof", "gpt-5.6-sol");
    const gateway = await installMockGateway(page, {
      sessionKey: session.key,
      models: [
        modelInfo("gpt-5.6-sol", "GPT-5.6 Sol"),
        modelInfo("gpt-5.6-terra", "GPT-5.6 Terra"),
      ],
      methodResponses: {
        "sessions.list": roster(session, defaultsFor(session.model)),
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const picker = pickerFor(page);
    await attr(picker, "model-select").tap();
    await picker.getByRole("option", { name: "GPT-5.6 Terra", exact: true }).waitFor();
    await expect.poll(() => picker.locator("[data-chat-model-selection-target]").count()).toBe(0);

    await picker.getByRole("option", { name: "GPT-5.6 Terra", exact: true }).tap();
    await expectPatch(gateway, { key: session.key, model: "openai/gpt-5.6-terra" });
    await expect.poll(() => selectedModel(picker)).toBe("openai/gpt-5.6-terra");

    await gateway.setSessionsListResponse(
      roster(
        {
          ...session,
          model: "gpt-5.6-terra",
          modelOverrideSource: "user",
          updatedAt: 2,
        },
        defaultsFor("gpt-5.6-terra"),
        2,
      ),
    );

    await page.reload();
    await attr(picker, "model-select").tap();
    await attr(picker, "model-default").waitFor();
    await expect.poll(() => picker.locator("[data-chat-model-selection-target]").count()).toBe(0);
    await expect.poll(() => selectedModel(picker)).toBe("openai/gpt-5.6-terra");

    await page.setViewportSize({ height: 900, width: 400 });
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

  it("clears a persisted pin matching the default through the default model row", async () => {
    const page = await newChatPage(suite);
    const session = { ...sessionInfo("model-pin-proof", "gpt-5.5"), modelOverrideSource: "user" };
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:main",
      sessionInfo: session,
      models: [modelInfo("gpt-5.5", "Proof Model")],
      methodResponses: {
        "sessions.list": roster(session, {
          model: "gpt-5.5",
          modelProvider: "openai",
          contextTokens: null,
        }),
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const picker = pickerFor(page);
    await attr(picker, "model-select").click();
    await revealChatModelOption(attr(picker, "model-default"));

    await picker.getByRole("option", { name: "Proof Model", exact: true }).click();
    await expectPatch(gateway, { key: session.key, model: null });
    await expect.poll(() => selectedModel(picker)).toBe("");
    await attr(picker, "model-select").click();
  });

  it("reconciles the current model search when an open catalog replaces its results", async () => {
    const page = await newChatPage(suite);

    const gateway = await installMockGateway(page, {
      models: [
        modelInfo("gpt-5.5", "GPT-5.5"),
        modelInfo("claude-haiku-4-5", "Claude Haiku 4.5", "anthropic"),
      ],
      sessionKey: "agent:main:main",
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const picker = pickerFor(page);
    const previous = attr(picker, "model-option", "anthropic/claude-haiku-4-5");
    await attr(picker, "model-select").click();
    await previous.waitFor({ state: "attached" });
    const discoveryCount = (await gateway.getRequests("models.list")).length;
    await gateway.deferNext("models.list", { view: "configured" });
    const search = picker.locator("[data-chat-model-search]");
    await search.fill("anthropic");
    await expect.poll(() => picker.locator("[data-chat-model-option]:visible").count()).toBe(1);
    expect(await previous.isVisible()).toBe(true);
    expect(await gateway.getRequests("models.list")).toHaveLength(discoveryCount);
    await gateway.emitGatewayEvent("chat.metadata.changed", {});
    const publication = await gateway.waitForRequest("models.list", { after: discoveryCount });
    expect(publication.params).toMatchObject({ sessionKey: "agent:main:main", view: "configured" });
    expect(publication.params).not.toHaveProperty("refresh");
    expect(await picker.locator("[data-chat-model-catalog-state]").count()).toBe(0);
    expect(await previous.isDisabled()).toBe(false);

    const refreshedModels = [
      modelInfo("gpt-5.5", "GPT-5.5"),
      modelInfo("gpt-5.4-mini", "GPT-5.4 mini"),
      modelInfo("claude-sonnet-4-6", "Claude Sonnet 4.6", "anthropic"),
    ];
    await gateway.resolveDeferred("models.list", { models: refreshedModels });

    const replacement = attr(picker, "model-option", "anthropic/claude-sonnet-4-6");
    await replacement.waitFor({ state: "attached" });
    await previous.waitFor({ state: "detached" });
    expect(await picker.locator("[data-chat-model-catalog-state]").count()).toBe(0);

    expect(await search.inputValue()).toBe("anthropic");
    await expect
      .poll(() =>
        picker
          .locator("[data-chat-model-option]:visible")
          .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-chat-model-option"))),
      )
      .toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(await picker.locator("[data-chat-model-search-empty]").isVisible()).toBe(false);
    await expect
      .poll(() =>
        search.evaluate((input) => {
          const activeId = input.getAttribute("aria-activedescendant");
          return activeId
            ? document.getElementById(activeId)?.getAttribute("data-chat-model-option")
            : null;
        }),
      )
      .toBe("anthropic/claude-sonnet-4-6");
    const patchCount = (await gateway.getRequests("sessions.patch")).length;
    await search.press("Enter");
    await expectPatch(
      gateway,
      { key: "agent:main:main", model: "anthropic/claude-sonnet-4-6" },
      patchCount,
    );
    await expect.poll(() => picker.getAttribute("open")).toBe(null);
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
    await selectChatModelOption(attr(main, "model-option", "openai/gpt-5.6-sol"));

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
      await selectChatModelOption(attr(main, "model-option", "example/example-b"));
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
