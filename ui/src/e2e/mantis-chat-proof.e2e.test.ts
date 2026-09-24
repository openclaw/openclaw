// Control UI Mantis proof covers the focused web chat browser path.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  canRunPlaywrightChromium,
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeMantisWebUiChat =
  chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let server: ControlUiE2eServer;
const contextBrowsers = new WeakMap<BrowserContext, Browser>();

async function newBrowserContext(options: Parameters<Browser["newContext"]>[0]) {
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  try {
    const context = await browser.newContext(options);
    contextBrowsers.set(context, browser);
    return context;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

async function closeBrowserContext(context: BrowserContext): Promise<void> {
  const browser = contextBrowsers.get(context);
  contextBrowsers.delete(context);
  await context.close().catch(() => {});
  await browser?.close().catch(() => {});
}

describeMantisWebUiChat("Mantis Control UI web chat proof", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
  });

  afterAll(async () => {
    await server?.close();
  });

  it("sends a chat message and captures visible browser proof", async () => {
    const artifactDir = createControlUiE2eArtifactDir(
      "mantis-chat-proof",
      process.env.OPENCLAW_MANTIS_WEB_UI_CHAT_OUTPUT_DIR?.trim() || undefined,
    );
    const rawVideoDir = path.join(artifactDir, "raw-video");
    await mkdir(rawVideoDir, { recursive: true });
    const context = await newBrowserContext({
      locale: "en-US",
      recordVideo: { dir: rawVideoDir, size: { height: 900, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.clock.install();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          role: "system",
          timestamp: Date.now() - 1_000,
          __openclaw: {
            kind: "compaction",
            id: "mantis-compaction-entry",
            tokensBefore: 900_000,
            tokensAfter: 24_700,
          },
        },
        {
          content: [{ text: "Mantis web UI proof is ready.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });
    const prompt = "capture a Mantis web UI chat proof";
    const reply = "Mantis web UI chat proof rendered.";
    const startedAt = new Date().toISOString();

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.getByText("Mantis web UI proof is ready.").waitFor({ timeout: 10_000 });
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      // The working timer starts at the send click; pause first so the elapsed
      // reading is exactly the fastForward below, not inflated by real time.
      await pauseVirtualClock(page);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      expect(sendRequest.params).toMatchObject({
        deliver: false,
        message: prompt,
        sessionKey: "agent:main:main",
      });
      const params = sendRequest.params as { idempotencyKey?: string };
      expect(params.idempotencyKey).toEqual(expect.any(String));

      await page.getByText("saved 875.3k tokens", { exact: true }).waitFor();
      await page.locator(".chat-working-indicator").waitFor();
      const workingLabel = page.locator(".chat-working-indicator__status > .sr-only");
      expect(await workingLabel.textContent()).toBe("Working…");
      expect(
        await page.locator(".chat-working-indicator__status > span:not(.sr-only)").count(),
      ).toBe(0);
      await page.clock.fastForward(177_000);
      await expect
        .poll(() => page.locator(".chat-working-indicator__elapsed").textContent())
        .toBe("2m 57s");
      await writeFile(
        path.join(artifactDir, "web-ui-chat.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
          page.locator(".chat-working-indicator__elapsed"),
        ]),
      );

      await gateway.emitChatFinal({ runId: params.idempotencyKey ?? "", text: reply });
      await page.locator(".chat-thread-inner").getByText(reply).waitFor({ timeout: 10_000 });
      await writeFile(
        path.join(artifactDir, "web-ui-chat-proof.json"),
        `${JSON.stringify(
          {
            finishedAt: new Date().toISOString(),
            prompt,
            reply,
            startedAt,
            status: "pass",
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      const video = page.video();
      await closeBrowserContext(context);
      const videoPath = await video?.path().catch(() => undefined);
      if (videoPath) {
        await copyFile(videoPath, path.join(artifactDir, "web-ui-chat.webm"));
      }
    }
  });

  it("captures Ask OpenClaw handoff focus, dock closure, and hatch drafts", async () => {
    const outputRoot = process.env.OPENCLAW_MANTIS_WEB_UI_CHAT_OUTPUT_DIR?.trim() || undefined;
    const beforeDir = createControlUiE2eArtifactDir("mantis-chat-proof-handoff-before", outputRoot);
    const afterDir = createControlUiE2eArtifactDir("mantis-chat-proof-handoff-after", outputRoot);
    const hatchDir = createControlUiE2eArtifactDir("mantis-chat-proof-hatch-draft", outputRoot);
    const rawVideoDir = path.join(afterDir, "raw-video");
    await mkdir(rawVideoDir, { recursive: true });
    const context = await newBrowserContext({
      colorScheme: "dark",
      locale: "en-US",
      recordVideo: { dir: rawVideoDir, size: { height: 900, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionId = "mantis-custodian-handoff";
    const workSessionKey = "agent:main:work";
    const workSessionUrl = controlUiSessionUrl(server.baseUrl, workSessionKey);
    const gateway = await installMockGateway(page, {
      sessionKey: workSessionKey,
      sessions: [{ key: workSessionKey, kind: "direct", label: "Main", updatedAt: Date.now() }],
      featureMethods: [
        "chat.history",
        "chat.metadata",
        "chat.send",
        "chat.startup",
        "openclaw.chat",
        "openclaw.chat.history",
      ],
      methodResponses: {
        "openclaw.chat": {
          action: "none",
          reply: "Ask OpenClaw is ready to hand work back to your agent.",
          sessionId,
        },
        "openclaw.chat.history": { turns: [] },
      },
    });

    try {
      await page.goto(workSessionUrl);
      await page.locator(".sidebar-footer-bar__home").click();
      const panel = page.locator("openclaw-assistant-panel");
      await panel.getByRole("button", { name: "Ask OpenClaw", exact: true }).click();
      await panel.getByText("Ask OpenClaw is ready to hand work back to your agent.").waitFor();
      await writeFile(
        path.join(beforeDir, "web-ui-chat.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
          panel.locator(".agent-chat__composer-combobox textarea"),
        ]),
      );
      await writeFile(
        path.join(beforeDir, "web-ui-chat-proof.json"),
        `${JSON.stringify({ stage: "before-handoff", status: "pass" }, null, 2)}\n`,
      );

      await gateway.setMethodResponse("openclaw.chat", {
        action: "open-agent",
        reply: "Opening normal agent chat now.",
        sessionId,
      });
      await panel.locator(".agent-chat__composer-combobox textarea").fill("Continue in agent chat");
      await panel.locator(".chat-send-btn").click();

      const mainComposer = page.locator("main.content .agent-chat__composer-combobox textarea");
      await mainComposer.waitFor();
      await expect.poll(() => new URL(page.url()).pathname).toBe(new URL(workSessionUrl).pathname);
      await expect
        .poll(() => mainComposer.evaluate((node) => document.activeElement === node))
        .toBe(true);
      await expect.poll(() => panel.locator("section.assistant-panel").isHidden()).toBe(true);
      await writeFile(
        path.join(afterDir, "web-ui-chat.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [mainComposer]),
      );
      await writeFile(
        path.join(afterDir, "web-ui-chat-proof.json"),
        `${JSON.stringify(
          {
            composerFocused: true,
            dockClosed: true,
            pathname: new URL(page.url()).pathname,
            stage: "after-handoff",
            status: "pass",
          },
          null,
          2,
        )}\n`,
      );

      await page.locator(".sidebar-footer-bar__home").click();
      await panel.getByRole("button", { name: "Ask OpenClaw", exact: true }).click();
      await panel.locator(".agent-chat__composer-combobox textarea").waitFor();
      await gateway.setMethodResponse("openclaw.chat", {
        action: "open-agent",
        agentDraft: "hatch",
        reply: "Your new agent is ready.",
        sessionId,
      });
      await panel.locator(".agent-chat__composer-combobox textarea").fill("Open my new agent");
      await panel.locator(".chat-send-btn").click();

      await expect.poll(() => mainComposer.inputValue()).toBe("Wake up, my friend!");
      await expect.poll(() => panel.locator("section.assistant-panel").isHidden()).toBe(true);
      await writeFile(
        path.join(hatchDir, "web-ui-chat.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [mainComposer]),
      );
      await writeFile(
        path.join(hatchDir, "web-ui-chat-proof.json"),
        `${JSON.stringify(
          {
            dockClosed: true,
            draft: await mainComposer.inputValue(),
            stage: "hatch-draft",
            status: "pass",
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      const video = page.video();
      await closeBrowserContext(context);
      const videoPath = await video?.path().catch(() => undefined);
      if (videoPath) {
        await copyFile(videoPath, path.join(afterDir, "web-ui-chat.webm"));
      }
    }
  });
});
