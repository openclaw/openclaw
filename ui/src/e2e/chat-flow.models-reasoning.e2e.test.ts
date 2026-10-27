import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { ChatPaneElement } from "../pages/chat/chat-pane-elements.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { sessionRow } from "./chat-flow-fixtures.test-support.ts";
import {
  chatSessionListResponse,
  newChatPage,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

const sessionA = "agent:main:session-a";
const bedrockModel = "bedrock/claude-opus-4.5";
const generatedModels = (count: number, idPrefix = "model", namePrefix = "Model") =>
  Array.from({ length: count }, (_, index) => ({
    id: `${idPrefix}-${index + 1}`,
    name: `${namePrefix} ${index + 1}`,
    provider: "openai",
  }));

const basicModels = [
  { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
  { id: "claude-opus-4.5", name: "Claude Opus 4.5", provider: "bedrock" },
];
async function openChat(
  options: Parameters<typeof installMockGateway>[1],
  sessionKey?: string,
  contextOptions?: Parameters<typeof newChatPage>[1],
) {
  const page = await newChatPage(suite, contextOptions);
  const gateway = await installMockGateway(page, options);
  await page.goto(
    sessionKey
      ? controlUiSessionUrl(suite.server.baseUrl, sessionKey)
      : `${suite.server.baseUrl}chat`,
  );
  return { page, gateway, main: page.getByRole("main") };
}

const visible = { state: "visible", timeout: 10_000 } as const;
const control = (root: Page | Locator, name: string) => root.locator(`[data-chat-${name}="true"]`);
const option = (root: Page | Locator, model: string) =>
  root.locator(`[data-chat-model-option="${model}"]`);
const attribute = (locator: Locator, name: string) => expect.poll(() => locator.getAttribute(name));

const positionControls = (controls: Locator) =>
  controls.evaluate((element) => {
    Object.assign((element as HTMLElement).style, {
      position: "fixed",
      right: "80px",
      top: "640px",
    });
  });

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

suite.define(() => {
  it("patches a selectable Claude CLI context window", async () => {
    const sessionKey = sessionA;
    const contextWindows = [
      { id: "200k", label: "200K", contextWindow: 200_000 },
      { id: "1m", label: "1M", contextWindow: 1_000_000 },
    ];
    const session = sessionRow(sessionKey, "Session A", 2, {
      sessionId: "session-a-context-window",
      model: "claude-fable-5",
      modelProvider: "claude-cli",
      contextWindow: "1m",
      contextWindowDefault: "1m",
      contextWindows,
    });
    const { page, gateway } = await openChat(
      {
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
      },
      sessionKey,
    );

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
    const { page, gateway } = await openChat({
      models: generatedModels(12),
    });

    await gateway.waitForRequest("sessions.messages.subscribe");

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
      await positionControls(controls);
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
    const { page, gateway } = await openChat({
      sessionKey: "agent:main:main",
    });

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
    const models = [
      { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
      ...generatedModels(32, "scroll-model", "Scroll Model"),
    ];
    const { page, main } = await openChat({
      models,
      sessionKey: "agent:main:main",
    });

    await positionControls(main.locator(".chat-composer-model-control"));
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
    const { main } = await openChat(
      {
        models: [
          {
            contextWindow: 1_000_000,
            id: "long-model",
            name: "Long model",
            provider: "openai",
          },
        ],
        sessionKey: "agent:main:main",
      },
      undefined,
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 844, width: 390 },
      },
    );

    await main.locator(".agent-chat__composer-combobox textarea").click();
    await control(main, "model-select").click();
    const menu = main.locator(".chat-controls__model-menu");
    await expect.poll(() => menu.isVisible()).toBe(true);
    await revealChatModelOption(main, "openai/long-model");
    for (const [part, text] of [
      ["name", "A deliberately very long model name that must ellipsize inside the provider grid"],
      ["meta", "deliberately-long-context-metadata-that-must-never-create-horizontal-scroll"],
    ] as const) {
      await menu
        .locator(`.chat-controls__model-option-${part}`)
        .first()
        .evaluate((node, value) => {
          node.textContent = value;
        }, text);
    }

    const overflow = await menu.evaluate((root) => {
      const leafStyles = [
        ".chat-controls__model-option-name",
        ".chat-controls__model-option-meta",
      ].map((selector) => {
        const element = root.querySelector<HTMLElement>(selector)!;
        const style = getComputedStyle(element);
        return [style.overflowX, style.textOverflow];
      });
      return { excessWidth: root.scrollWidth - root.clientWidth, leafStyles };
    });
    expect(overflow.excessWidth).toBeLessThanOrEqual(1);
    expect(overflow.leafStyles).toEqual([
      ["hidden", "ellipsis"],
      ["hidden", "ellipsis"],
    ]);
  });

  it("keeps a session model override selected after switching away and back", async () => {
    const sessions = chatSessionListResponse();
    Object.assign(sessions.defaults, {
      thinkingDefault: "medium",
      thinkingLevels: ["off", "medium", "high"].map((id) => ({ id, label: id })),
    });
    Object.assign(sessions.sessions[1]!, { model: "gpt-5.5", modelProvider: "openai" });
    const { page, gateway, main } = await openChat(
      {
        methodResponses: {
          "sessions.list": sessions,
        },
        models: basicModels,
        sessionKey: sessionA,
      },
      sessionA,
    );

    const activePane = main.locator('openclaw-chat-pane[aria-hidden="false"]');
    const expectInheritedReasoning = async () => {
      const effort = control(activePane, "thinking-select");
      const slider = control(activePane, "thinking-slider");
      await effort.click();
      await attribute(slider, "data-chat-thinking-values").toBe("off,medium,high");
      await attribute(effort, "data-chat-thinking-value").toBe("");
      await expect.poll(() => slider.inputValue()).toBe("1");
      await page.keyboard.press("Escape");
    };
    const modelSelect = control(activePane, "model-select");

    await modelSelect.waitFor(visible);
    const defaultOption = control(activePane, "model-default");
    await modelSelect.click();
    await attribute(defaultOption, "aria-selected").toBe("true");
    expect(await defaultOption.getAttribute("data-chat-model-option")).toBe("openai/gpt-5.5");
    await modelSelect.click();

    await expectInheritedReasoning();
    await modelSelect.click();
    await revealChatModelOption(activePane, bedrockModel, { timeout: 10_000 });
    await option(activePane, bedrockModel).click();
    const patchRequest = await gateway.waitForRequest("sessions.patch");
    expect(requireRecord(patchRequest.params)).toEqual({
      expectedSessionId: "session:agent:main:session-a",
      key: sessionA,
      model: bedrockModel,
    });
    expect(await modelSelect.getAttribute("data-chat-select-value")).toBe(bedrockModel);

    await switchSession(page, activePane, "agent:main:session-b", "Session B");
    await modelSelect.waitFor(visible);
    await modelSelect.click();
    await attribute(defaultOption, "aria-selected").toBe("true");
    await modelSelect.click();

    await expectInheritedReasoning();
    await switchSession(page, activePane, sessionA, "Session A");

    await modelSelect.waitFor(visible);
    expect(await modelSelect.getAttribute("data-chat-select-value")).toBe(bedrockModel);
  });

  it("shows a pending send while a Full Access permission update is still pending", async () => {
    const { page, gateway, main } = await openChat(
      {
        deferredMethods: ["sessions.patch"],
        methodResponses: {
          "sessions.list": chatSessionListResponse([
            sessionRow(sessionA, "Session A", 2, {
              permissionMode: "workspace",
              sessionId: "session-a-send-barrier",
            }),
          ]),
        },
        models: basicModels,
        sessionKey: sessionA,
      },
      sessionA,
    );

    await main.locator('[data-chat-permission-select="true"]').click();
    await main.locator('[data-chat-permission-option="full"]').click();
    const patchRequest = await gateway.waitForRequest("sessions.patch");
    expect(requireRecord(patchRequest.params)).toMatchObject({
      key: sessionA,
      expectedSessionId: "session-a-send-barrier",
      permissionMode: "full",
    });

    const prompt = "send while the Full Access permission save is pending";
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
    expect(params).toMatchObject({ message: prompt, sessionKey: sessionA });
  });
});
