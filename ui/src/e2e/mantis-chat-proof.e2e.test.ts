// Control UI Mantis proof covers the focused web chat browser path.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Mantis Control UI web chat proof",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to a compatible browser, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

async function recordingContext(artifactDir: string, colorScheme?: "dark") {
  const dir = path.join(artifactDir, "raw-video");
  await mkdir(dir, { recursive: true });
  const size = { height: 900, width: 1280 };
  return suite.newBrowserContext({
    colorScheme,
    locale: "en-US",
    recordVideo: { dir, size },
    serviceWorkers: "block",
    viewport: size,
  });
}

async function saveProof(
  page: Page,
  dir: string,
  masks: Locator[],
  details: Record<string, unknown>,
) {
  await writeFile(
    path.join(dir, "web-ui-chat.png"),
    await takeControlUiViewportScreenshot(page, page.locator(".shell"), masks),
  );
  await saveResult(dir, details);
}

async function saveResult(dir: string, details: Record<string, unknown>) {
  await writeFile(
    path.join(dir, "web-ui-chat-proof.json"),
    `${JSON.stringify({ ...details, status: "pass" }, null, 2)}\n`,
  );
}

async function saveVideo(page: Page, context: BrowserContext, dir: string) {
  const video = page.video();
  await suite.closeBrowserContext(context);
  const videoPath = await video?.path().catch(() => undefined);
  if (videoPath) {
    await copyFile(videoPath, path.join(dir, "web-ui-chat.webm"));
  }
}

suite.define(() => {
  it("sends a chat message and captures visible browser proof", async () => {
    const artifactDir = createControlUiE2eArtifactDir(
      "mantis-chat-proof",
      process.env.OPENCLAW_MANTIS_WEB_UI_CHAT_OUTPUT_DIR?.trim() || undefined,
    );
    const context = await recordingContext(artifactDir);
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
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Mantis web UI proof is ready.").waitFor({ timeout: 10_000 });
      await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
      // The working timer starts at the send click; pause first so the elapsed
      // reading is exactly the virtual duration below, not inflated by real time.
      await pauseVirtualClock(page);
      await page.getByRole("button", { name: "Send message" }).click();

      const sendRequest = await gateway.waitForRequest("chat.send");
      expect(sendRequest.params).toMatchObject({
        deliver: false,
        message: prompt,
        sessionKey: "agent:main:main",
        idempotencyKey: expect.any(String),
      });
      const params = sendRequest.params as { idempotencyKey?: string };

      await page.getByText("saved 875.3k tokens", { exact: true }).waitFor();
      await page.locator(".chat-working-indicator").waitFor();
      const workingLabel = page.locator(".chat-working-indicator__status > span:first-child");
      expect(await workingLabel.textContent()).toBe("Waiting for turn to start…");
      expect(
        await page
          .locator(".chat-working-indicator__status > span:not(.sr-only)")
          .allTextContents(),
      ).toEqual(["Waiting for turn to start…", "·"]);
      await expect.poll(() => gateway.getRequests("connect")).toHaveLength(1);
      // Keep each elapsed-time/heartbeat tick, without rendering every frame
      // between the one-second clock readings or suspending pending RPC replies.
      for (let elapsedMs = 0; elapsedMs < 177_000; elapsedMs += 1_000) {
        await page.clock.fastForward(1_000);
      }
      await expect
        .poll(() => page.locator(".chat-working-indicator__elapsed").textContent())
        .toBe("2m 57s");
      expect(await gateway.getRequests("connect")).toHaveLength(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      await writeFile(
        path.join(artifactDir, "web-ui-chat.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
          page.locator(".chat-working-indicator__elapsed"),
        ]),
      );

      await gateway.emitChatFinal({ runId: params.idempotencyKey ?? "", text: reply });
      await page.locator(".chat-thread-inner").getByText(reply).waitFor({ timeout: 10_000 });
      await saveResult(artifactDir, {
        finishedAt: new Date().toISOString(),
        prompt,
        reply,
        startedAt,
      });
    } finally {
      await saveVideo(page, context, artifactDir);
    }
  });

  it("captures Ask OpenClaw handoff focus, dock closure, and hatch drafts", async () => {
    const outputRoot = process.env.OPENCLAW_MANTIS_WEB_UI_CHAT_OUTPUT_DIR?.trim() || undefined;
    const beforeDir = createControlUiE2eArtifactDir("mantis-chat-proof-handoff-before", outputRoot);
    const afterDir = createControlUiE2eArtifactDir("mantis-chat-proof-handoff-after", outputRoot);
    const hatchDir = createControlUiE2eArtifactDir("mantis-chat-proof-hatch-draft", outputRoot);
    const context = await recordingContext(afterDir, "dark");
    const page = await context.newPage();
    const sessionId = "mantis-custodian-handoff";
    const workSessionKey = "agent:main:work";
    const workSessionUrl = controlUiSessionUrl(suite.server.baseUrl, workSessionKey);
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
      const panelComposer = panel.locator(".agent-chat__composer-combobox textarea");
      await saveProof(page, beforeDir, [panelComposer], { stage: "before-handoff" });

      await gateway.setMethodResponse("openclaw.chat", {
        action: "open-agent",
        reply: "Opening normal agent chat now.",
        sessionId,
      });
      await panelComposer.fill("Continue in agent chat");
      await panel.locator(".chat-send-btn").click();

      const mainComposer = page.locator("main.content .agent-chat__composer-combobox textarea");
      await mainComposer.waitFor();
      await expect.poll(() => new URL(page.url()).pathname).toBe(new URL(workSessionUrl).pathname);
      await expect
        .poll(() => mainComposer.evaluate((node) => document.activeElement === node))
        .toBe(true);
      await expect.poll(() => panel.locator("section.assistant-panel").isHidden()).toBe(true);
      await saveProof(page, afterDir, [mainComposer], {
        composerFocused: true,
        dockClosed: true,
        pathname: new URL(page.url()).pathname,
        stage: "after-handoff",
      });

      await page.locator(".sidebar-footer-bar__home").click();
      await panel.getByRole("button", { name: "Ask OpenClaw", exact: true }).click();
      await panelComposer.waitFor();
      await gateway.setMethodResponse("openclaw.chat", {
        action: "open-agent",
        agentDraft: "hatch",
        reply: "Your new agent is ready.",
        sessionId,
      });
      await panelComposer.fill("Open my new agent");
      await panel.locator(".chat-send-btn").click();

      await expect.poll(() => mainComposer.inputValue()).toBe("Wake up, my friend!");
      await expect.poll(() => panel.locator("section.assistant-panel").isHidden()).toBe(true);
      await saveProof(page, hatchDir, [mainComposer], {
        dockClosed: true,
        draft: await mainComposer.inputValue(),
        stage: "hatch-draft",
      });
    } finally {
      await saveVideo(page, context, afterDir);
    }
  });
});
