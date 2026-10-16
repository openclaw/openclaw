import { expect, it } from "vitest";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
  newChatPage,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("opens the chat picker from a partial snapshot while catalog revalidation is pending", async () => {
    const page = await newChatPage(suite);
    const sessionKey = "agent:main:main";
    const prepared = {
      id: "prepared",
      name: "Prepared model",
      provider: "fixture",
      available: true,
    };
    const added = { ...prepared, id: "added", name: "Added model" };
    const gateway = await installMockGateway(page, {
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
    const picker = page.locator(
      'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
    );
    await picker.locator("[data-chat-model-select]").click();
    const preparedRow = picker.locator('[data-chat-model-option="fixture/prepared"]');
    await revealChatModelOption(preparedRow);
    await expect.poll(() => preparedRow.isVisible()).toBe(true);
    expect(await preparedRow.isEnabled()).toBe(true);

    await gateway.resolveDeferred("models.list", { models: [prepared, added] });
    await expect
      .poll(() => picker.locator('[data-chat-model-option="fixture/added"]').isVisible())
      .toBe(true);
    expect(await picker.getAttribute("open")).not.toBeNull();
  });

  it("preserves the Gateway-resolved target without exposing it in the picker", async () => {
    const page = await newChatPage(suite, {
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const session = {
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 1,
      sessionId: "model-target-proof",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
    };
    const gateway = await installMockGateway(page, {
      sessionKey: session.key,
      models: [
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
      ],
      methodResponses: {
        "sessions.list": {
          ts: 1,
          path: "",
          count: 1,
          sessions: [session],
          defaults: {
            contextTokens: null,
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            modelSelectionTarget: "global",
          },
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    let picker = page.locator(
      'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
    );
    await picker.locator('[data-chat-model-select="true"]').tap();
    await picker.getByRole("option", { name: "GPT-5.6 Terra", exact: true }).waitFor();
    await expect.poll(() => picker.locator("[data-chat-model-selection-target]").count()).toBe(0);

    await picker.getByRole("option", { name: "GPT-5.6 Terra", exact: true }).tap();
    const request = await gateway.waitForRequest("sessions.patch");
    expect(request.params).toMatchObject({
      key: "agent:main:main",
      model: "openai/gpt-5.6-terra",
    });
    await expect
      .poll(() =>
        picker.locator('[data-chat-model-select="true"]').getAttribute("data-chat-select-value"),
      )
      .toBe("openai/gpt-5.6-terra");

    await gateway.setSessionsListResponse({
      ts: 2,
      path: "",
      count: 1,
      sessions: [
        {
          ...session,
          model: "gpt-5.6-terra",
          modelOverrideSource: "user",
          updatedAt: 2,
        },
      ],
      defaults: {
        contextTokens: null,
        model: "gpt-5.6-terra",
        modelProvider: "openai",
        modelSelectionTarget: "global",
      },
    });

    await page.reload();
    picker = page.locator('openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker');
    await picker.locator('[data-chat-model-select="true"]').tap();
    await picker.locator('[data-chat-model-default="true"]').waitFor();
    await expect.poll(() => picker.locator("[data-chat-model-selection-target]").count()).toBe(0);
    await expect
      .poll(() =>
        picker.locator('[data-chat-model-select="true"]').getAttribute("data-chat-select-value"),
      )
      .toBe("openai/gpt-5.6-terra");

    await page.setViewportSize({ height: 900, width: 400 });
    const defaultRow = picker.locator('[data-chat-model-default="true"]');
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
          if (!heading) {
            return Number.POSITIVE_INFINITY;
          }
          return heading.getBoundingClientRect().right - button.getBoundingClientRect().right;
        }),
      )
      .toBeLessThanOrEqual(11);
    await expect
      .poll(() =>
        configureModels.locator("svg").evaluate((icon) => icon.getBoundingClientRect().width),
      )
      .toBeLessThanOrEqual(12);
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
    const session = {
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 1,
      sessionId: "model-pin-proof",
      model: "gpt-5.5",
      modelProvider: "openai",
      modelOverrideSource: "user",
    };
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:main",
      sessionInfo: session,
      models: [{ id: "gpt-5.5", name: "Proof Model", provider: "openai" }],
      methodResponses: {
        "sessions.list": {
          ts: 1,
          path: "",
          count: 1,
          sessions: [session],
          defaults: { model: "gpt-5.5", modelProvider: "openai", contextTokens: null },
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const picker = page.locator(
      'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
    );
    await picker.locator('[data-chat-model-select="true"]').click();
    await revealChatModelOption(picker.locator('[data-chat-model-default="true"]'));

    await picker.getByRole("option", { name: "Proof Model", exact: true }).click();
    const request = await gateway.waitForRequest("sessions.patch");
    expect(request.params).toMatchObject({ key: "agent:main:main", model: null });
    await expect
      .poll(() =>
        picker.locator('[data-chat-model-select="true"]').getAttribute("data-chat-select-value"),
      )
      .toBe("");
    await picker.locator('[data-chat-model-select="true"]').click();
  });

  it("keeps picker opens cached and the warm list interactive during a catalog publication", async () => {
    const page = await newChatPage(suite);
    const gateway = await installMockGateway(page, {
      models: [
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
        { id: "fable-5", name: "Claude Fable 5", provider: "anthropic" },
      ],
      sessionKey: "agent:main:main",
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
    const picker = pane.locator(".chat-controls__model-picker");
    await picker.locator("[data-chat-model-option]").first().waitFor({ state: "attached" });

    await gateway.deferNext("models.list", { view: "configured" });
    await picker.locator('[data-chat-model-select="true"]').click();
    await revealChatModelOption(picker.locator('[data-chat-model-option="openai/gpt-5.6-luna"]'));
    await revealChatModelOption(picker.locator('[data-chat-model-option="anthropic/fable-5"]'));
    await picker.getByRole("option", { name: "GPT-5.6 Luna", exact: true }).waitFor();
    expect(await gateway.getRequests("models.list")).toHaveLength(1);

    await gateway.emitGatewayEvent("chat.metadata.changed", {});
    const request = await gateway.waitForRequest("models.list", { after: 1 });
    expect(requireRecord(request.params)).toMatchObject({
      sessionKey: "agent:main:main",
      view: "configured",
    });
    expect(request.params).not.toHaveProperty("refresh");

    // The warm list stays rendered and selectable with no refresh/loading interstitial.
    await expect
      .poll(() => picker.locator("[data-chat-model-option]:visible").count())
      .toBeGreaterThanOrEqual(3);

    expect(await picker.locator("[data-chat-model-catalog-state]").count()).toBe(0);
    expect(
      await picker.locator('[data-chat-model-option="openai/gpt-5.6-luna"]').isDisabled(),
    ).toBe(false);

    // The direct scoped response owns model readiness; commands remain independent.
    await gateway.resolveDeferred("models.list", {
      models: [
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
      ],
    });
    await picker
      .locator('[data-chat-model-option="openai/gpt-5.6-terra"]')
      .waitFor({ state: "visible" });
    expect(await picker.locator("[data-chat-model-catalog-state]").count()).toBe(0);
  });

  it("reconciles the current model search when an open catalog replaces its results", async () => {
    const page = await newChatPage(suite);

    const gateway = await installMockGateway(page, {
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
      ],
      sessionKey: "agent:main:main",
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const picker = page.locator(
      'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
    );
    const previous = picker.locator('[data-chat-model-option="anthropic/claude-haiku-4-5"]');
    await previous.waitFor({ state: "attached" });
    const discoveryCount = (await gateway.getRequests("models.list")).length;
    await gateway.deferNext("models.list", { view: "configured" });
    await picker.locator('[data-chat-model-select="true"]').click();
    const search = picker.locator("[data-chat-model-search]");
    await search.fill("anthropic");
    await expect.poll(() => picker.locator("[data-chat-model-option]:visible").count()).toBe(1);
    expect(await previous.isVisible()).toBe(true);
    expect(await gateway.getRequests("models.list")).toHaveLength(discoveryCount);
    await gateway.emitGatewayEvent("chat.metadata.changed", {});
    await gateway.waitForRequest("models.list", { after: discoveryCount });

    const refreshedModels = [
      { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 mini", provider: "openai" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
    ];
    await gateway.resolveDeferred("models.list", { models: refreshedModels });

    const replacement = picker.locator('[data-chat-model-option="anthropic/claude-sonnet-4-6"]');
    await replacement.waitFor({ state: "attached" });
    await previous.waitFor({ state: "detached" });

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
    const patch = await gateway.waitForRequest("sessions.patch", { after: patchCount });
    expect(patch.params).toMatchObject({
      key: "agent:main:main",
      model: "anthropic/claude-sonnet-4-6",
    });
    await expect.poll(() => picker.getAttribute("open")).toBe(null);
  });
});
