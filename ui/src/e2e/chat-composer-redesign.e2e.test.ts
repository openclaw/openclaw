// Control UI E2E tests cover the redesigned chat composer.
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let server: ControlUiE2eServer;

describeControlUiE2e("Control UI chat composer redesign", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("keeps model and settings in the header and switches the primary action with input state", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
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
        "models.authStatus": {
          ts: Date.now(),
          providers: [
            {
              provider: "openai",
              displayName: "Codex",
              status: "ok",
              profiles: [{ profileId: "codex", type: "oauth", status: "ok" }],
              usage: { windows: [{ label: "Week", usedPercent: 72 }] },
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
            thinkingLevels: [
              { id: "off", label: "off" },
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "high", label: "high" },
            ],
          },
          path: "",
          sessions: [
            {
              contextTokens: 200_000,
              displayName: "Main",
              hasActiveRun: false,
              key: "main",
              kind: "direct",
              label: "Main",
              model: "gpt-5.5",
              modelProvider: "openai",
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

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.metadata");
      expect(await gateway.getRequests("models.list")).toHaveLength(0);

      const composer = page.locator(".agent-chat__input");
      const composerShell = page.locator(".agent-chat__composer-shell");
      const chatMain = page.locator(".chat-workbench__main");
      const model = composer.locator('[data-chat-model-select="true"]');
      const usage = composer.locator('[data-chat-provider-usage="true"]');
      const contextUsage = composer.locator(".context-ring");
      const textarea = composer.locator("textarea");
      const attach = composer.getByRole("button", { name: "Attach file" });
      const camera = composerShell.getByRole("button", { name: "Take photo" });
      const settings = composer.getByRole("button", { name: "Settings", exact: true });
      const voice = page.getByRole("button", { name: "Start voice input" });

      await expect.poll(() => model.isVisible()).toBe(true);
      await expect.poll(() => usage.isVisible()).toBe(true);
      await expect.poll(() => contextUsage.isVisible()).toBe(true);
      await expect.poll(() => settings.isVisible()).toBe(true);
      await expect.poll(() => attach.isVisible()).toBe(true);
      await expect.poll(() => camera.isVisible()).toBe(false);
      await expect.poll(() => voice.isVisible()).toBe(true);
      await expect
        .poll(() => model.locator(".chat-controls__inline-select-label").textContent())
        .toBe("GPT-5.5");
      await expect
        .poll(() => model.locator(".chat-controls__effort-chip").textContent())
        .toBe("High");
      await expect
        .poll(async () => (await usage.textContent())?.replace(/\s+/g, " ").trim())
        .toBe("Usage Remaining 28%");
      await expect
        .poll(() => contextUsage.locator(".context-ring__detail").textContent())
        .toBe("46k / 200k");
      await expect
        .poll(() =>
          contextUsage.evaluate((node) => node.closest(".agent-chat__composer-meta") != null),
        )
        .toBe(true);

      await model.click();
      const thinkingButtons = composer.locator(
        '[data-chat-thinking-options="true"] [data-chat-thinking-option]',
      );
      const speedButtons = composer.locator("[data-chat-speed-option]");
      await expect
        .poll(async () => (await thinkingButtons.allTextContents()).map((label) => label.trim()))
        .toEqual(["Off", "Low", "Medium", "High"]);
      await expect
        .poll(async () => (await speedButtons.allTextContents()).map((label) => label.trim()))
        .toEqual(["Standard", "Fast"]);
      await expect
        .poll(() => thinkingButtons.filter({ hasText: "High" }).getAttribute("aria-pressed"))
        .toBe("true");
      await composer.locator('[data-chat-thinking-option="low"]').click();
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.patch")).some(
            (request) =>
              typeof request.params === "object" &&
              request.params !== null &&
              "thinkingLevel" in request.params &&
              request.params.thinkingLevel === "low",
          ),
        )
        .toBe(true);
      await expect.poll(() => model.getAttribute("data-chat-thinking-value")).toBe("low");
      await expect
        .poll(() =>
          composer.locator('[data-chat-thinking-option="low"]').getAttribute("aria-pressed"),
        )
        .toBe("true");
      await composer.locator('[data-chat-speed-option="on"]').click();
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.patch")).some(
            (request) =>
              typeof request.params === "object" &&
              request.params !== null &&
              "fastMode" in request.params &&
              request.params.fastMode === true,
          ),
        )
        .toBe(true);
      await model.click();
      await expect
        .poll(() => composer.locator('[data-chat-speed-option="on"]').getAttribute("aria-pressed"))
        .toBe("true");
      await expect
        .poll(() => composer.locator('[data-chat-thinking-slider="true"]').count())
        .toBe(0);
      const providerButtons = composer.locator("[data-chat-model-provider]");
      await expect
        .poll(async () => (await providerButtons.allTextContents()).map((label) => label.trim()))
        .toEqual(["OpenAI", "Anthropic"]);
      await expect
        .poll(() => composer.locator('[data-chat-model-provider-group="openai"]').textContent())
        .toContain("GPT-5.4 Pro");
      await providerButtons.filter({ hasText: "Anthropic" }).click();
      const anthropicModels = composer.locator('[data-chat-model-provider-group="anthropic"]');
      await expect.poll(() => anthropicModels.isVisible()).toBe(true);
      await expect.poll(() => anthropicModels.textContent()).toContain("Claude Sonnet 4.6");
      await model.click();

      const [
        chatMainBox,
        composerShellBox,
        composerBox,
        modelBox,
        textareaBox,
        attachBox,
        voiceBox,
      ] = await Promise.all([
        chatMain.boundingBox(),
        composerShell.boundingBox(),
        composer.boundingBox(),
        model.boundingBox(),
        textarea.boundingBox(),
        attach.boundingBox(),
        voice.boundingBox(),
      ]);
      expect(chatMainBox).not.toBeNull();
      expect(composerShellBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(modelBox).not.toBeNull();
      expect(textareaBox).not.toBeNull();
      expect(attachBox).not.toBeNull();
      expect(voiceBox).not.toBeNull();
      if (
        !chatMainBox ||
        !composerShellBox ||
        !composerBox ||
        !modelBox ||
        !textareaBox ||
        !attachBox ||
        !voiceBox
      ) {
        throw new Error("expected composer controls to have layout boxes");
      }
      expect(composerShellBox.width / chatMainBox.width).toBeGreaterThanOrEqual(0.49);
      expect(composerShellBox.width / chatMainBox.width).toBeLessThanOrEqual(0.51);
      expect(
        Math.abs(
          composerShellBox.x + composerShellBox.width / 2 - (chatMainBox.x + chatMainBox.width / 2),
        ),
      ).toBeLessThanOrEqual(1);
      expect(composerBox.height).toBeLessThanOrEqual(112);
      expect(modelBox.y).toBeLessThan(textareaBox.y);
      expect(attachBox.x + attachBox.width).toBeLessThanOrEqual(
        composerBox.x + composerBox.width + 1,
      );
      expect(voiceBox.x).toBeGreaterThan(composerBox.x + composerBox.width);

      await settings.click();
      const settingsDialog = page.getByRole("dialog", { name: "Settings" });
      await expect.poll(() => settingsDialog.isVisible()).toBe(true);
      await expect
        .poll(() => settingsDialog.locator(".chat-settings-popover__label").allTextContents())
        .toEqual(["Chat", "Voice"]);
      await expect
        .poll(() => settingsDialog.locator('[aria-label="Voice options"]').isVisible())
        .toBe(true);
      const voiceSelect = settingsDialog.locator('[data-talk-select="voice"] select');
      await voiceSelect.selectOption("cedar");
      await expect
        .poll(() => voiceSelect.evaluate((node) => (node as HTMLSelectElement).value))
        .toBe("cedar");
      await settings.click();
      await expect.poll(() => settingsDialog.isVisible()).toBe(false);

      await textarea.fill("Send this message");
      await expect
        .poll(() => page.getByRole("button", { name: "Send message" }).isVisible())
        .toBe(true);
      await expect
        .poll(() => page.getByRole("button", { name: "Start voice input" }).count())
        .toBe(0);

      await page.getByRole("button", { name: "Send message" }).click();
      const sendRequest = await gateway.waitForRequest("chat.send");
      const progress = composer.locator(".agent-chat__composer-progress");
      await expect.poll(() => progress.isVisible()).toBe(true);
      await expect
        .poll(() =>
          progress.evaluate(
            (node) =>
              node.closest(".agent-chat__composer-meta") != null &&
              node.previousElementSibling?.classList.contains("context-usage") === true,
          ),
        )
        .toBe(true);
      const [activeContextBox, activeProgressBox] = await Promise.all([
        contextUsage.boundingBox(),
        progress.boundingBox(),
      ]);
      expect(activeContextBox).not.toBeNull();
      expect(activeProgressBox).not.toBeNull();
      if (!activeContextBox || !activeProgressBox) {
        throw new Error("expected context and progress indicators to have layout boxes");
      }
      expect(activeProgressBox.x).toBeGreaterThanOrEqual(
        activeContextBox.x + activeContextBox.width - 1,
      );
      expect(
        Math.abs(
          activeProgressBox.y +
            activeProgressBox.height / 2 -
            (activeContextBox.y + activeContextBox.height / 2),
        ),
      ).toBeLessThanOrEqual(2);
      const runId =
        typeof sendRequest.params === "object" &&
        sendRequest.params !== null &&
        "idempotencyKey" in sendRequest.params
          ? String(sendRequest.params.idempotencyKey)
          : "";
      const stop = page.getByRole("button", { name: "Stop generating" });
      await expect.poll(() => stop.isVisible()).toBe(true);
      await stop.click();
      const abortRequest = await gateway.waitForRequest("chat.abort");
      expect(abortRequest.params).toMatchObject({
        runId,
        sessionKey: "main",
      });
      await expect.poll(() => stop.count()).toBe(0);

      await textarea.fill("");
      await expect
        .poll(() => page.getByRole("button", { name: "Start voice input" }).isVisible())
        .toBe(true);
      await expect.poll(() => page.getByRole("button", { name: "Send message" }).count()).toBe(0);

      await page.setViewportSize({ width: 393, height: 852 });
      await expect.poll(() => camera.isVisible()).toBe(true);
      const [mobileCameraBox, mobileVoiceBox] = await Promise.all([
        camera.boundingBox(),
        voice.boundingBox(),
      ]);
      expect(mobileCameraBox).not.toBeNull();
      expect(mobileVoiceBox).not.toBeNull();
      if (!mobileCameraBox || !mobileVoiceBox) {
        throw new Error("expected mobile camera and voice controls to have layout boxes");
      }
      expect(Math.abs(mobileCameraBox.x - mobileVoiceBox.x)).toBeLessThanOrEqual(1);
      expect(mobileCameraBox.y + mobileCameraBox.height).toBeLessThanOrEqual(mobileVoiceBox.y - 4);
      await settings.click();
      await expect.poll(() => settingsDialog.isVisible()).toBe(true);
      await settings.click();
      await expect.poll(() => settingsDialog.isVisible()).toBe(false);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it("refreshes the configured usable catalog after advertised chat metadata", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
        {
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          provider: "codex",
          available: false,
        },
      ],
      methodResponses: {
        "chat.startup": {
          agentsList: {
            agents: [{ id: "main", name: "OpenClaw" }],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          messages: [],
          sessionId: "control-ui-e2e-session",
          thinkingLevel: null,
        },
        "chat.metadata": {
          commands: [],
          models: [
            { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
            {
              id: "gpt-5.3-codex-spark",
              name: "GPT-5.3 Codex Spark",
              provider: "codex",
              available: false,
            },
          ],
        },
        "sessions.list": {
          count: 1,
          defaults: {
            contextTokens: 200_000,
            model: "gpt-5.3-codex-spark",
            modelProvider: "openai",
          },
          path: "",
          sessions: [
            {
              contextTokens: 200_000,
              displayName: "Main",
              hasActiveRun: false,
              key: "main",
              kind: "direct",
              label: "Main",
              model: "gpt-5.5",
              modelProvider: "openai",
              status: "done",
              totalTokens: 0,
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.metadata");
      expect(await gateway.getRequests("models.list")).toHaveLength(0);

      const composer = page.locator(".agent-chat__input");
      const providers = composer.locator("[data-chat-model-provider]");
      await expect
        .poll(async () => (await providers.allTextContents()).map((label) => label.trim()))
        .toEqual(["OpenAI"]);
      await expect
        .poll(() => composer.locator('[data-chat-model-provider-group="openai"]').textContent())
        .toContain("GPT-5.5");
      await expect
        .poll(() => composer.locator('[data-chat-model-provider-group="codex"]').count())
        .toBe(0);
      await expect.poll(() => composer.locator('[data-chat-model-option=""]').count()).toBe(0);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it("keeps startup models when the metadata refresh fails", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.metadata"],
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true }],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await gateway.waitForRequest("chat.metadata");
      await gateway.rejectDeferred("chat.metadata", {
        code: "UNAVAILABLE",
        message: "metadata unavailable",
      });

      const composer = page.locator(".agent-chat__input");
      await expect
        .poll(() => composer.locator('[data-chat-model-provider-group="openai"]').textContent())
        .toContain("GPT-5.5");
      expect(await gateway.getRequests("models.list")).toHaveLength(0);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it("does not substitute default-agent models when scoped metadata fails", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.metadata"],
      models: [{ id: "gpt-default", name: "GPT Default", provider: "openai", available: true }],
      methodResponses: {
        "chat.startup": {
          agentsList: {
            agents: [{ id: "work", name: "Work" }],
            defaultId: "main",
            mainKey: "agent:work:main",
            scope: "agent",
          },
          messages: [],
          sessionId: "control-ui-e2e-session",
          thinkingLevel: null,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat?session=agent%3Awork%3Amain`);
      await gateway.waitForRequest("chat.metadata");
      await gateway.rejectDeferred("chat.metadata", {
        code: "UNAVAILABLE",
        message: "metadata unavailable",
      });

      const composer = page.locator(".agent-chat__input");
      await expect
        .poll(async () =>
          (await composer.locator("[data-chat-model-option]").allTextContents()).join(" "),
        )
        .not.toContain("GPT Default");
      expect(await gateway.getRequests("models.list")).toHaveLength(0);
    } finally {
      await context.close();
      await browser.close();
    }
  });

  it("does not request unscoped models when chat metadata is unavailable", async () => {
    const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      models: [{ id: "gpt-default", name: "GPT Default", provider: "openai", available: true }],
      methodResponses: {
        connect: {
          auth: {
            deviceToken: "e2e-device-token",
            role: "operator",
            scopes: [
              "operator.admin",
              "operator.read",
              "operator.write",
              "operator.approvals",
              "operator.pairing",
            ],
          },
          features: { events: [], methods: ["chat.startup"] },
          protocol: 4,
          server: { connId: "control-ui-e2e", version: "e2e" },
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "main",
              mainKey: "main",
              mainSessionKey: "agent:work:main",
              scope: "agent",
            },
          },
          type: "hello-ok",
        },
        "chat.startup": {
          agentsList: {
            agents: [{ id: "work", name: "Work" }],
            defaultId: "main",
            mainKey: "agent:work:main",
            scope: "agent",
          },
          messages: [],
          sessionId: "control-ui-e2e-session",
          thinkingLevel: null,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat?session=agent%3Awork%3Amain`);
      await expect.poll(async () => (await gateway.getRequests("chat.startup")).length).toBe(1);

      const composer = page.locator(".agent-chat__input");
      await expect
        .poll(async () =>
          (await composer.locator("[data-chat-model-option]").allTextContents()).join(" "),
        )
        .not.toContain("GPT Default");
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(0);
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
