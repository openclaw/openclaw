import { writeFile } from "node:fs/promises";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { ChatPaneElement } from "../pages/chat/route-draft-focus-handoff.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { revealChatModelOption, selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
  chatSessionListResponse,
  newChatPage,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
  waitForRequests,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

const visible = { state: "visible", timeout: 10_000 } as const;
const control = (root: Page | Locator, name: string) => root.locator(`[data-chat-${name}="true"]`);
const option = (root: Page | Locator, model: string) =>
  root.locator(`[data-chat-model-option="${model}"]`);
const attribute = (locator: Locator, name: string) => expect.poll(() => locator.getAttribute(name));

async function switchSession(page: Page, pane: Locator, key: string, label: string) {
  await page
    .locator(`.sidebar-recent-session[data-session-key="${key}"] a.sidebar-recent-session__link`)
    .click();
  await page
    .locator(".sidebar-recent-session--active")
    .getByText(label)
    .waitFor({ timeout: 10_000 });
  await expect.poll(() => pane.evaluate((node) => (node as ChatPaneElement).sessionKey)).toBe(key);
}
async function expectMenuPlacement(
  menu: Locator,
  trigger: Locator,
  above: boolean,
  height: number,
) {
  await expect
    .poll(async () => {
      const [box, anchor] = await Promise.all([menu.boundingBox(), trigger.boundingBox()]);
      return {
        placed:
          box !== null &&
          anchor !== null &&
          (above ? box.y + box.height <= anchor.y - 5 : box.y >= anchor.y + anchor.height + 5),
        withinViewport: box !== null && box.y >= 8 && box.y + box.height <= height - 8,
      };
    })
    .toEqual({ placed: true, withinViewport: true });
}

async function createReasoningProofPage(scope: string) {
  const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
  const artifactDir = parent ? createControlUiE2eArtifactDir(scope, parent) : undefined;
  const viewport = { height: 900, width: 1280 };
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(artifactDir ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
  });
  const page = await context.newPage();
  const capture = async (fileName: string, surface: Locator, content: Locator) => {
    if (artifactDir) {
      await writeFile(
        `${artifactDir}/${fileName}.png`,
        await takeControlUiViewportScreenshot(page, surface, [content]),
      );
    }
  };
  return { page, capture };
}

suite.define(() => {
  it("patches a selectable Claude CLI context window", async () => {
    const page = await newChatPage(suite);
    const sessionKey = "agent:main:session-a";
    const contextWindows = [
      { id: "200k", label: "200K", contextWindow: 200_000 },
      { id: "1m", label: "1M", contextWindow: 1_000_000 },
    ];
    const session = {
      key: sessionKey,
      sessionId: "session-a-context-window",
      kind: "direct",
      label: "Session A",
      model: "claude-fable-5",
      modelProvider: "claude-cli",
      contextWindow: "1m",
      contextWindowDefault: "1m",
      contextWindows,
      updatedAt: 2,
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([session]),
      },
      models: [
        {
          id: "claude-fable-5",
          name: "Claude Fable 5",
          provider: "claude-cli",
          contextWindow: 1_000_000,
          contextWindowDefault: "1m",
          contextWindows,
        },
      ],
      sessionKey,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
    const picker = pane.locator(".chat-controls__model-picker");
    await control(picker, "model-select").click();
    const toggle = picker.locator("[data-chat-context-window-toggle]");
    await attribute(toggle, "aria-checked").toBe("true");
    await gateway.deferNext("sessions.patch");
    const patchCount = (await gateway.getRequests("sessions.patch")).length;
    await toggle.click();
    const patch = await gateway.waitForRequest("sessions.patch", { after: patchCount });
    expect(requireRecord(patch.params)).toMatchObject({
      key: sessionKey,
      contextWindow: "200k",
    });
    // Patch acknowledgements and history must see the same committed context window.
    await gateway.setSessionsListResponse(
      chatSessionListResponse([{ ...session, contextWindow: "200k" }]),
    );
    await gateway.resolveDeferred("sessions.patch");
    await attribute(toggle, "aria-checked").toBe("false");
    await expect
      .poll(async () =>
        (await picker.locator("[data-chat-model-context-badge]").textContent())?.trim(),
      )
      .toBe("200K");
    await attribute(picker, "open").not.toBeNull();
  });

  it("keeps picker menus in the viewport while preferring the space above", async () => {
    const page = await newChatPage(suite);
    const gateway = await installMockGateway(page, {
      models: Array.from({ length: 12 }, (_, index) => ({
        id: `model-${index + 1}`,
        name: `Model ${index + 1}`,
        provider: "openai",
      })),
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("chat.startup");

    const controls = page.locator(".chat-composer-model-control");
    for (const picker of [
      {
        menu: ".chat-controls__model-menu",
        trigger: '[data-chat-model-select="true"]',
      },
      {
        menu: ".chat-controls__effort-menu",
        trigger: '[data-chat-thinking-select="true"]',
      },
    ]) {
      await page.setViewportSize({ height: 900, width: 1280 });
      await controls.evaluate((element) => {
        Object.assign((element as HTMLElement).style, {
          position: "fixed",
          right: "80px",
          top: "640px",
        });
      });
      const trigger = controls.locator(picker.trigger);
      const menu = controls.locator(picker.menu);
      await trigger.click();
      await expectMenuPlacement(menu, trigger, true, 900);

      await page.setViewportSize({ height: 320, width: 1280 });
      await controls.evaluate((element) => {
        (element as HTMLElement).style.top = "24px";
      });
      await expectMenuPlacement(menu, trigger, false, 320);
      await trigger.click();
      await expect.poll(() => menu.isVisible()).toBe(false);
    }
  });

  it("routes runtime-aware model commands through the server directive path", async () => {
    const page = await newChatPage(suite);
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:main",
    });

    await page.goto(`${suite.server.baseUrl}chat`);

    const command = "/model openai/gpt-5.6-luna --runtime codex continue with the selected model";
    await page.locator(".agent-chat__composer-combobox textarea").fill(command);
    await page.getByRole("button", { name: "Send message" }).click();

    const sendRequest = await gateway.waitForRequest("chat.send");
    expect(requireRecord(sendRequest.params)).toMatchObject({
      message: command,
      sessionKey: "agent:main:main",
    });
    expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
  });

  it("keeps high-velocity model scrolling inside the picker", async () => {
    const page = await newChatPage(suite);
    const models = [
      { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      ...Array.from({ length: 32 }, (_value, index) => ({
        id: `scroll-model-${index + 1}`,
        name: `Scroll Model ${index + 1}`,
        provider: "openai",
      })),
    ];
    await installMockGateway(page, {
      models,
      sessionKey: "agent:main:main",
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const main = page.getByRole("main");
    await main.locator(".chat-composer-model-control").evaluate((element) => {
      Object.assign((element as HTMLElement).style, {
        position: "fixed",
        right: "80px",
        top: "640px",
      });
    });
    await page.evaluate(() => {
      document.documentElement.style.overflowY = "auto";
      document.body.style.height = "1800px";
      window.scrollTo(0, 300);
    });
    expect(await page.evaluate(() => window.scrollY)).toBe(300);

    await control(main, "model-select").click();
    const modelScroller = main.locator(".chat-controls__model-options");
    await expect.poll(() => modelScroller.isVisible()).toBe(true);
    await modelScroller.evaluate((element) => {
      element.scrollTop = 0;
    });
    // The wheel owns this scroll assertion; Playwright must not scroll ancestors first.
    await modelScroller.hover({ scroll: "none" });
    expect(await page.evaluate(() => window.scrollY)).toBe(300);
    await page.mouse.wheel(0, -5_000);
    await page.waitForTimeout(100);

    expect(await page.evaluate(() => window.scrollY)).toBe(300);
  });

  it("keeps long model names and metadata inside the picker grid", async () => {
    const page = await newChatPage(suite, {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 844, width: 390 },
    });
    await installMockGateway(page, {
      models: [
        {
          contextWindow: 1_000_000,
          id: "long-model",
          name: "Long model",
          provider: "openai",
        },
      ],
      sessionKey: "agent:main:main",
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    const main = page.getByRole("main");
    await control(main, "model-select").click();
    const menu = main.locator(".chat-controls__model-menu");
    await expect.poll(() => menu.isVisible()).toBe(true);
    await menu
      .locator(".chat-controls__model-option-name")
      .first()
      .evaluate((node) => {
        node.textContent =
          "A deliberately very long model name that must ellipsize inside the provider grid";
      });
    await menu
      .locator(".chat-controls__model-option-meta")
      .first()
      .evaluate((node) => {
        node.textContent =
          "deliberately-long-context-metadata-that-must-never-create-horizontal-scroll";
      });

    const overflow = await menu.evaluate((root) => {
      const selectors = [
        ".chat-controls__model-option-copy",
        ".chat-controls__model-option",
        ".chat-controls__provider-model-group",
        ".chat-controls__model-options",
      ];
      const containers = selectors.map((selector) => {
        const element = root.querySelector<HTMLElement>(selector);
        return {
          clientWidth: element?.clientWidth ?? -1,
          overflow: Math.max(0, (element?.scrollWidth ?? 0) - (element?.clientWidth ?? 0)),
          scrollWidth: element?.scrollWidth ?? -1,
          selector,
        };
      });
      const rootElement = root as HTMLElement;
      containers.push({
        clientWidth: rootElement.clientWidth,
        overflow: Math.max(0, rootElement.scrollWidth - rootElement.clientWidth),
        scrollWidth: rootElement.scrollWidth,
        selector: ".chat-controls__model-menu",
      });
      const leafStyles = [
        ".chat-controls__model-option-name",
        ".chat-controls__model-option-meta",
      ].map((selector) => {
        const element = root.querySelector<HTMLElement>(selector)!;
        const style = getComputedStyle(element);
        return { overflowX: style.overflowX, selector, textOverflow: style.textOverflow };
      });
      return { containers, leafStyles };
    });
    expect(
      overflow.containers.filter((entry) => entry.overflow > 1),
      JSON.stringify(overflow),
    ).toEqual([]);
    expect(overflow.leafStyles).toEqual([
      {
        overflowX: "hidden",
        selector: ".chat-controls__model-option-name",
        textOverflow: "ellipsis",
      },
      {
        overflowX: "hidden",
        selector: ".chat-controls__model-option-meta",
        textOverflow: "ellipsis",
      },
    ]);

    const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactDirParent
      ? createControlUiE2eArtifactDir("chat-flow.models-reasoning", artifactDirParent)
      : undefined;
    if (artifactDir) {
      await menu.screenshot({
        animations: "disabled",
        path: `${artifactDir}/model-picker-long-content.png`,
      });
    }
  });

  it("keeps a session model override selected after switching away and back", async () => {
    const page = await newChatPage(suite);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse(),
      },
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-opus-4.5", name: "Claude Opus 4.5", provider: "bedrock" },
      ],
      sessionKey: "agent:main:session-a",
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));

    const main = page.getByRole("main");
    const activePane = main.locator('openclaw-chat-pane[aria-hidden="false"]');
    const modelSelect = control(activePane, "model-select");
    const selectModel = async (value: string) => {
      await control(activePane, "model-select").click();
      const model = option(activePane, value);
      await revealChatModelOption(model, { timeout: 10_000 });
      await model.click();
    };

    await modelSelect.waitFor(visible);
    const defaultOption = control(activePane, "model-default");
    await attribute(defaultOption, "aria-selected").toBe("true");
    expect(await defaultOption.getAttribute("data-chat-model-option")).toBe("openai/gpt-5.5");

    await selectModel("bedrock/claude-opus-4.5");
    const patchRequest = await gateway.waitForRequest("sessions.patch");
    expect(requireRecord(patchRequest.params)).toEqual({
      expectedSessionId: "session:agent:main:session-a",
      key: "agent:main:session-a",
      model: "bedrock/claude-opus-4.5",
    });
    expect(await modelSelect.getAttribute("data-chat-select-value")).toBe(
      "bedrock/claude-opus-4.5",
    );

    await switchSession(page, activePane, "agent:main:session-b", "Session B");
    await modelSelect.waitFor(visible);
    await attribute(defaultOption, "aria-selected").toBe("true");

    await switchSession(page, activePane, "agent:main:session-a", "Session A");

    await modelSelect.waitFor(visible);
    expect(await modelSelect.getAttribute("data-chat-select-value")).toBe(
      "bedrock/claude-opus-4.5",
    );
  });

  it("restores the selected agent model after clearing a session override", async () => {
    const page = await newChatPage(suite);
    const agentsList = {
      agents: [
        {
          id: "ops",
          model: { primary: "anthropic/claude-opus-4-5" },
          name: "Operations",
        },
      ],
      defaultId: "ops",
      mainKey: "main",
      scope: "agent",
    };
    const sessionsList = chatSessionListResponse([
      { key: "agent:ops:session-a", kind: "direct", label: "Operations", updatedAt: Date.now() },
    ]);
    const models = [
      { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
    ];
    const gateway = await installMockGateway(page, {
      assistantAgentId: "ops",
      defaultAgentId: "ops",
      methodResponses: {
        "agents.list": agentsList,
        "chat.startup": {
          agentsList,
          messages: [],
          metadata: { models },
          sessionId: "session:agent:ops:session-a",
          thinkingLevel: null,
        },
        "sessions.list": sessionsList,
      },
      models,
      sessionKey: "agent:ops:session-a",
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:ops:session-a"));
    const main = page.getByRole("main");
    const modelSelect = control(main, "model-select").first();
    await modelSelect.waitFor(visible);
    expect(await modelSelect.textContent()).toContain("Claude Opus 4.5");
    await expect
      .poll(() => control(main, "model-default").first().getAttribute("aria-selected"))
      .toBe("true");

    await modelSelect.click();
    await selectChatModelOption(option(main, "openai/gpt-5.5"));
    const firstPatch = await gateway.waitForRequest("sessions.patch");
    expect(requireRecord(firstPatch.params)).toEqual({
      expectedSessionId: "session:agent:ops:session-a",
      key: "agent:ops:session-a",
      model: "openai/gpt-5.5",
    });
    expect(await modelSelect.textContent()).toContain("GPT-5.5");

    // Model selection closes immediately. Reopen and select the real default
    // catalog row to clear the session override.
    await modelSelect.click();
    const defaultModel = main.locator(
      '[data-chat-model-option="anthropic/claude-opus-4-5"][data-chat-model-default="true"]',
    );
    await revealChatModelOption(defaultModel, { timeout: 10_000 });
    expect(await defaultModel.textContent()).toContain("Default");
    expect(await option(main, "").count()).toBe(0);
    await defaultModel.click();
    const patches = await waitForRequests(gateway, "sessions.patch", 2);
    expect(requireRecord(patches[1]?.params)).toMatchObject({
      expectedSessionId: "session:agent:ops:session-a",
      key: "agent:ops:session-a",
      model: null,
      agentRuntime: null,
    });
    expect(await modelSelect.textContent()).toContain("Claude Opus 4.5");
    await attribute(defaultModel, "aria-selected").toBe("true");
  });

  it("shows one canonical default model with matching inherited reasoning", async () => {
    const { page, capture } = await createReasoningProofPage("chat-flow.models-reasoning");
    const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(
      (id) => ({ id, label: id }),
    );
    const agentsList = {
      agents: [
        {
          id: "main",
          model: { primary: "openai/gpt-5.6-sol" },
          name: "Main",
          thinkingDefault: "medium",
          thinkingLevels,
          thinkingOptions: thinkingLevels.map((level) => level.label),
        },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
    };
    const sessionsList = {
      count: 2,
      defaults: {
        contextTokens: null,
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        thinkingDefault: "medium",
        thinkingLevels,
        thinkingOptions: thinkingLevels.map((level) => level.label),
      },
      path: "",
      sessions: [
        {
          key: "agent:main:session-default",
          sessionId: "control-ui-profile-default-proof",
          kind: "direct",
          label: "Default Sol",
          updatedAt: 2,
        },
        {
          key: "agent:main:session-explicit",
          kind: "direct",
          label: "Explicit Sol",
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          updatedAt: 1,
        },
      ],
      ts: Date.now(),
    };
    const models = [
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", reasoning: true },
    ];
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": agentsList,
        "chat.startup": {
          agentsList,
          messages: [],
          metadata: { models },
          sessionId: "control-ui-profile-default-proof",
          thinkingLevel: null,
        },
        "sessions.list": sessionsList,
      },
      models,
      sessionKey: "agent:main:session-default",
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-default"));
    const main = page.getByRole("main");
    const activePane = main.locator('openclaw-chat-pane[aria-hidden="false"]');
    const modelSelect = control(activePane, "model-select");
    const modelPopup = activePane.locator(".chat-controls__model-picker > [data-anchored-overlay]");
    const modelOption = option(activePane, "openai/gpt-5.6-sol");
    const effortSelect = control(activePane, "thinking-select");
    const thinkingSlider = control(activePane, "thinking-slider");
    const expectedThinkingValues = thinkingLevels.map((level) => level.id).join(",");

    await modelSelect.waitFor(visible);
    expect(await modelSelect.textContent()).toContain("GPT-5.6 Sol");
    expect(await modelSelect.textContent()).not.toContain("@openai:");
    await modelSelect.click();
    await expect.poll(() => modelOption.count()).toBe(1);
    expect(
      (await main.locator("[data-chat-model-option]").allTextContents()).join(" "),
    ).not.toContain("@openai:");
    await effortSelect.click();
    await attribute(thinkingSlider, "data-chat-thinking-values").toBe(expectedThinkingValues);
    const defaultThinkingValue = await effortSelect.getAttribute("data-chat-thinking-value");
    await modelSelect.click();
    await revealChatModelOption(modelOption);
    await capture("default-sol", modelPopup, modelOption);

    await page.keyboard.press("Escape");
    await switchSession(page, activePane, "agent:main:session-explicit", "Explicit Sol");
    await modelSelect.click();
    await expect.poll(() => modelOption.count()).toBe(1);
    await effortSelect.click();
    await attribute(thinkingSlider, "data-chat-thinking-values").toBe(expectedThinkingValues);
    expect(await effortSelect.getAttribute("data-chat-thinking-value")).toBe(defaultThinkingValue);
    await modelSelect.click();
    await revealChatModelOption(modelOption);
    await capture("explicit-sol", modelPopup, modelOption);

    expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
  });

  it.each([
    {
      label: "model override",
      trigger: '[data-chat-model-select="true"]',
      option: '[data-chat-model-option="bedrock/claude-opus-4.5"]',
      patch: { model: "bedrock/claude-opus-4.5" },
    },
    {
      label: "Full Access permission",
      trigger: '[data-chat-permission-select="true"]',
      option: '[data-chat-permission-option="full"]',
      patch: { permissionMode: "full" },
    },
  ])("shows a pending send while a $label update is still pending", async (setting) => {
    const page = await newChatPage(suite);
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.patch"],
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            key: "agent:main:session-a",
            kind: "direct",
            label: "Session A",
            permissionMode: "workspace",
            sessionId: "session-a-send-barrier",
            updatedAt: 2,
          },
        ]),
      },
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-opus-4.5", name: "Claude Opus 4.5", provider: "bedrock" },
      ],
      sessionKey: "agent:main:session-a",
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));

    const main = page.getByRole("main");
    await main.locator(setting.trigger).click();
    if (setting.label === "model override") {
      await revealChatModelOption(main.locator(setting.option));
    }
    await main.locator(setting.option).click();
    const patchRequest = await gateway.waitForRequest("sessions.patch");
    expect(requireRecord(patchRequest.params)).toMatchObject({
      key: "agent:main:session-a",
      expectedSessionId: "session-a-send-barrier",
      ...setting.patch,
    });

    const prompt = `send while the ${setting.label} save is pending`;
    await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();

    await page.locator(".chat-queue").getByText("Applying chat settings").waitFor({
      timeout: 10_000,
    });
    await page.locator(".chat-queue").getByText(prompt).waitFor({ timeout: 10_000 });
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);

    await gateway.resolveDeferred("sessions.patch", {});
    const sendRequest = await gateway.waitForRequest("chat.send");
    const params = requireRecord(sendRequest.params);
    expect(params.message).toBe(prompt);
    expect(params.sessionKey).toBe("agent:main:session-a");
  });

  it("previews reasoning and provider choices before committing them", async () => {
    const page = await newChatPage(suite);
    const sessionKey = "agent:main:session-a";
    const session = {
      key: sessionKey,
      sessionId: `session:${sessionKey}`,
      kind: "direct",
      label: "Session A",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      thinkingDefault: "high",
      thinkingLevel: "high",
      thinkingLevels: ["off", "low", "medium", "high", "ultra"].map((id) => ({ id, label: id })),
      updatedAt: 2,
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([session]),
      },
      models: [
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
        { id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic" },
      ],
      sessionKey,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));

    const main = page.getByRole("main");
    const modelPicker = control(main, "model-select").first();
    const effortPicker = control(main, "thinking-select").first();
    await effortPicker.click();
    const thinkingSlider = control(main, "thinking-slider");
    const visibleReasoning = main.locator(
      "[data-chat-thinking-preview-committed]:not([hidden]), " +
        "[data-chat-thinking-preview-index]:not([hidden])",
    );

    for (const value of ["low", "medium", "ultra"]) {
      await thinkingSlider.evaluate((input, nextValue) => {
        const slider = input as HTMLInputElement;
        const values = (slider.dataset.chatThinkingValues ?? "").split(",");
        slider.value = String(values.indexOf(nextValue));
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
      await expect
        .poll(() => visibleReasoning.evaluate((element) => element.textContent?.trim()))
        .toBe(value.charAt(0).toUpperCase() + value.slice(1));
    }
    await expectRequestCountStable(gateway, "sessions.patch", 0);

    await gateway.deferNext("sessions.patch");
    await thinkingSlider.evaluate((input) => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const thinkingPatch = await gateway.waitForRequest("sessions.patch");
    expect(requireRecord(thinkingPatch.params)).toMatchObject({
      key: sessionKey,
      thinkingLevel: "ultra",
    });
    await gateway.setSessionsListResponse(
      chatSessionListResponse([{ ...session, thinkingLevel: "ultra" }]),
    );
    await gateway.resolveDeferred("sessions.patch");
    expect(await gateway.getSessionRow(sessionKey)).toMatchObject({
      sessionId: session.sessionId,
      thinkingLevel: "ultra",
    });
    await attribute(effortPicker, "data-chat-thinking-value").toBe("ultra");
    await expect.poll(() => effortPicker.textContent()).toContain("Ultra");
    await page.keyboard.press("Escape");

    await modelPicker.click();
    const search = control(main, "model-search");
    await expect
      .poll(() => search.evaluate((element) => element === document.activeElement))
      .toBe(true);
    await page.keyboard.type("anthropic");
    const anthropicModel = option(main, "anthropic/claude-fable-5");
    await expect.poll(() => anthropicModel.isVisible()).toBe(true);
    await expect.poll(() => option(main, "openai/gpt-5.6-sol").getAttribute("hidden")).toBe("");
    await expectRequestCountStable(gateway, "sessions.patch", 1);
    await search.press("Enter");
    const patches = await waitForRequests(gateway, "sessions.patch", 2);
    expect(requireRecord(patches[1]?.params)).toMatchObject({
      expectedSessionId: `session:${sessionKey}`,
      key: sessionKey,
      model: "anthropic/claude-fable-5",
    });
    await expect
      .poll(() => main.locator(".chat-controls__model-picker").getAttribute("open"))
      .toBe(null);
  });
});
