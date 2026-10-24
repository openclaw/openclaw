import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat send pending handoff",
});

type FrameSample = {
  present: boolean;
  rowKeys: string[];
  imageCount: number;
  loadedImageCount: number;
  enteringBubbleCount: number;
};

type SamplerWindow = Window & {
  openclawSendFrameSamples?: FrameSample[];
  openclawSendFrameSamplerStop?: () => void;
};

const PROBE_TEXT = "Flicker probe message 4242";
const IMAGE_PROBE_TEXT = "Image flicker probe message 4242";
const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
const ONE_PIXEL_PNG_DATA_URL = `data:image/png;base64,${ONE_PIXEL_PNG_B64}`;
const USER_ECHO_ENTRY_ID = "pending-handoff-user-echo";

async function startFrameSampler(page: Page, probeText = PROBE_TEXT): Promise<void> {
  await page.evaluate((text) => {
    const win = window as SamplerWindow;
    const frames: FrameSample[] = [];
    win.openclawSendFrameSamples = frames;
    let running = true;
    win.openclawSendFrameSamplerStop = () => {
      running = false;
    };
    const sample = () => {
      if (!running) {
        return;
      }
      const rows = [...document.querySelectorAll<HTMLElement>("[data-virtual-row-key]")].filter(
        (row) => (row.textContent ?? "").includes(text),
      );
      const images = rows.flatMap((row) => [
        ...row.querySelectorAll<HTMLImageElement>(".chat-message-image"),
      ]);
      frames.push({
        present: rows.length > 0,
        rowKeys: rows.map((row) => row.dataset.virtualRowKey ?? ""),
        imageCount: images.length,
        loadedImageCount: images.filter(
          (image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
        ).length,
        enteringBubbleCount: rows.reduce(
          (count, row) => count + row.querySelectorAll(".chat-bubble--enter").length,
          0,
        ),
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, probeText);
}

function readFrames(page: Page) {
  return page.evaluate(() => (window as SamplerWindow).openclawSendFrameSamples ?? []);
}

async function stopFrameSampler(page: Page): Promise<FrameSample[]> {
  return page.evaluate(() => {
    const win = window as SamplerWindow;
    win.openclawSendFrameSamplerStop?.();
    return win.openclawSendFrameSamples ?? [];
  });
}

function analyzeFrameContinuity(
  frames: FrameSample[],
  isHealthy: (frame: FrameSample) => boolean = (frame) => frame.present,
): string[] {
  const firstHealthy = frames.findIndex(isHealthy);
  expect(firstHealthy).toBeGreaterThanOrEqual(0);
  const continuityFrames = frames.slice(firstHealthy);
  expect(continuityFrames.filter((frame) => !isHealthy(frame))).toEqual([]);
  return continuityFrames.flatMap((frame) => frame.rowKeys);
}

function historyMessage<T extends { seq: number }>(
  role: "user" | "assistant",
  text: string,
  metadata: T,
  timestamp = Date.now(),
) {
  return { role, content: [{ type: "text", text }], timestamp, __openclaw: metadata };
}

const BASE_HISTORY = [historyMessage("assistant", "Ready.", { seq: 1 }, Date.now() - 5_000)];

async function emitSessionMessage(
  gateway: MockGatewayControls,
  message: Record<string, unknown>,
  messageId: string,
  messageSeq: number,
  activeRunIds: string[] = [],
  extra: Record<string, unknown> = {},
) {
  const hasActiveRun = activeRunIds.length > 0;
  await gateway.emitGatewayEvent("session.message", {
    sessionKey: "main",
    message,
    messageId,
    messageSeq,
    activeRunIds,
    hasActiveRun,
    session: {
      key: "main",
      kind: "direct",
      status: hasActiveRun ? "running" : "done",
      hasActiveRun,
      activeRunIds,
      updatedAt: Date.now(),
    },
    ...extra,
  });
}

type ChatSendParams = {
  attachments?: Array<{ content?: string; mimeType?: string }>;
  idempotencyKey?: string;
};

async function openChatAndSubmitProbe(
  page: Page,
  gateway: MockGatewayControls,
  opts: { attachImage: boolean; probeText: string },
): Promise<{ runId: string; sendParams: ChatSendParams }> {
  const probeText = opts.probeText;
  await page.goto(`${suite.server?.baseUrl ?? ""}chat`);
  await page
    .locator(".chat-thread")
    .getByText("Ready.", { exact: true })
    .waitFor({ timeout: 10_000 });
  await gateway.waitForRequest("sessions.list");
  if (opts.attachImage) {
    await page.locator(".agent-chat__file-input").setInputFiles({
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
    });
    await page.locator(".chat-attachment-thumb").waitFor({ state: "visible" });
  }
  await gateway.deferNext("chat.send");
  await startFrameSampler(page, probeText);
  await page.locator(".agent-chat__input textarea").fill(probeText);
  await page.locator(".agent-chat__input textarea").press("Enter");
  const send = await gateway.waitForRequest("chat.send");
  const sendParams = send.params as ChatSendParams;
  const runId = sendParams.idempotencyKey ?? "";
  expect(runId).toBeTruthy();
  await page
    .locator("[data-virtual-row-key]")
    .getByText(probeText, { exact: true })
    .waitFor({ timeout: 10_000 });
  return { runId, sendParams };
}

async function finishRunAndSettle(
  page: Page,
  gateway: MockGatewayControls,
  runId: string,
  userEcho: Record<string, unknown>,
): Promise<FrameSample[]> {
  const finalMessage = historyMessage("assistant", "Run complete.", { seq: 3 }, Date.now() + 1);
  await gateway.setHistoryMessages([...BASE_HISTORY, userEcho, finalMessage]);
  // Count either terminal trigger's authoritative history read.
  const historyRequestsBeforeTerminal = (await gateway.getRequests("chat.history")).length;
  await gateway.emitChatFinal({ runId, text: "Run complete." });
  await page
    .locator(".chat-bubble")
    .getByText("Run complete.", { exact: true })
    .waitFor({ timeout: 10_000 });
  await emitSessionMessage(gateway, finalMessage, "pending-handoff-final-1", 3, [], {
    clientRunId: runId,
  });
  // Only loaded history can supply the authoritative data-entry-id.
  await expect
    .poll(async () => (await gateway.getRequests("chat.history")).length, { timeout: 10_000 })
    .toBeGreaterThan(historyRequestsBeforeTerminal);
  await expect
    .poll(() => page.locator(`.chat-bubble[data-entry-id="${USER_ECHO_ENTRY_ID}"]`).count(), {
      timeout: 10_000,
    })
    .toBe(1);
  // Let a few more frames elapse so trailing samples cover the settled state.
  await page.waitForTimeout(500);
  return stopFrameSampler(page);
}

function userMessage(runId: string, text = PROBE_TEXT) {
  return historyMessage("user", text, { id: USER_ECHO_ENTRY_ID, idempotencyKey: runId, seq: 2 });
}

function captureProof(page: Page) {
  return async (filename: string) => {
    if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()) {
      await page.screenshot({ path: path.join(suite.artifactDir, filename) });
    }
  };
}

function isHealthyImageFrame(frame: FrameSample): boolean {
  return frame.rowKeys.length === 1 && frame.imageCount === 1 && frame.loadedImageCount === 1;
}

suite.define(() => {
  it("retires only the local user when older history arrives beside a pending assistant fallback", async () => {
    const proofDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()
      ? suite.artifactDir
      : undefined;
    const sessionId = "pending-assistant-visual-session";
    const prompt = "land PR";
    const fallback = "The PR has landed. Its final response is awaiting history.";
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const capture = captureProof(page);
        const ready = historyMessage(
          "assistant",
          "The PR is ready to land.",
          { id: "ready-to-land", seq: 119 },
          Date.now() - 20_000,
        );
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-5.5",
          presenceUsers: [],
          sessions: [{ key: "main", sessionId, label: "Pending assistant recovery" }],
          historyMessages: [ready],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("The PR is ready to land.", { exact: true }).waitFor();
        await gateway.deferNext("chat.send");
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).fill(prompt);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const send = await gateway.waitForRequest("chat.send");
        const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
        expect(runId).toBeTruthy();
        // The sequence-bearing ACK retires the outbox without its transcript
        // payload. Older history must retire the remaining local display copy.
        await gateway.resolveDeferred("chat.send", { runId, status: "started", messageSeq: 120 });
        const canonicalUser = historyMessage(
          "user",
          prompt,
          { id: "canonical-land-request", seq: 120, idempotencyKey: `${runId}:user` },
          Date.now() - 10_000,
        );
        const tail = historyMessage(
          "assistant",
          "All checks passed. Finishing the landing.",
          { id: "landing-checks", seq: 200 },
          Date.now() - 1000,
        );
        const session = {
          key: "main",
          sessionId,
          hasActiveRun: false,
          activeRunIds: [],
          status: "done",
        };
        const historyPage = {
          sessionId,
          sessionInfo: session,
          totalMessages: 200,
          thinkingLevel: null,
        };
        await gateway.setMethodResponse("chat.history", {
          cases: [
            {
              match: { offset: 80 },
              response: {
                ...historyPage,
                messages: [ready, canonicalUser],
                hasMore: false,
              },
            },
            {
              match: {},
              response: {
                ...historyPage,
                messages: [tail],
                hasMore: true,
                nextOffset: 80,
                inputReceipts: [],
              },
            },
          ],
        });
        await gateway.deferNext("chat.history", { offset: 80 });
        await gateway.emitGatewayEvent("chat", {
          sessionKey: "main",
          runId,
          state: "delta",
          message: { role: "assistant", content: [{ type: "text", text: fallback }] },
        });
        await page.locator(".chat-bubble").getByText(fallback, { exact: true }).waitFor();
        // The terminal protocol permits omission of the final message; the UI
        // materializes its already-received assistant stream in that case.
        await gateway.emitGatewayEvent("chat", { sessionKey: "main", runId, state: "final" });
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        await page
          .getByText("All checks passed. Finishing the landing.", { exact: true })
          .waitFor();
        const pendingTurns = await pane.locator(".chat-bubble").allTextContents();
        expect(pendingTurns.filter((text) => text.includes(prompt))).toHaveLength(1);
        expect(pendingTurns.filter((text) => text.includes(fallback))).toHaveLength(1);
        expect(pendingTurns.findIndex((text) => text.includes(fallback))).toBe(
          pendingTurns.findIndex((text) => text.includes(prompt)) + 1,
        );
        await waitForChatScrollIdle(page);
        await capture("pending-assistant-before-history.png");

        const thread = pane.locator(".chat-thread");
        await thread.hover();
        await page.mouse.wheel(0, -1_000_000);
        await gateway.waitForRequest("chat.history", { match: { offset: 80 } });
        await gateway.resolveDeferred("chat.history");
        await waitForChatScrollIdle(page);
        if (
          (await pane.locator('.chat-bubble[data-entry-id="canonical-land-request"]').count()) === 0
        ) {
          await page.mouse.wheel(0, -1_000_000);
        }
        await pane.locator('.chat-bubble[data-entry-id="canonical-land-request"]').waitFor();
        await waitForChatScrollIdle(page);
        const bubbles = pane.locator(".chat-bubble");
        const userCount = await bubbles.getByText(prompt, { exact: true }).count();
        const fallbackCount = await bubbles.getByText(fallback, { exact: true }).count();
        await capture("pending-assistant-after-history.png");
        if (proofDir) {
          const proof = {
            userCount,
            fallbackCount,
            sends: (await gateway.getRequests("chat.send")).length,
          };
          await writeFile(
            path.join(proofDir, "pending-assistant-proof.json"),
            JSON.stringify(proof, null, 2) + "\n",
          );
        }
        expect(userCount).toBe(1);
        expect(fallbackCount).toBe(1);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      },
    );
  });

  it.each(["queued image", "early session echo"] as const)(
    "keeps one submitted turn through the %s handoff",
    async (handoff) => {
      const image = handoff === "queued image";
      await suite.withPage({ viewport: { height: 800, width: 1200 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, { historyMessages: BASE_HISTORY });
        const { runId, sendParams } = await openChatAndSubmitProbe(page, gateway, {
          attachImage: image,
          probeText: image ? IMAGE_PROBE_TEXT : PROBE_TEXT,
        });
        const echo = userMessage(runId);
        if (image) {
          expect(sendParams.attachments?.[0]).toMatchObject({
            content: ONE_PIXEL_PNG_B64,
            mimeType: "image/png",
          });
          await expect
            .poll(async () => (await readFrames(page)).some(isHealthyImageFrame))
            .toBe(true);
          expect((await readFrames(page)).some((frame) => frame.enteringBubbleCount === 1)).toBe(
            true,
          );
        } else {
          // The persisted user echo arrives before the send acknowledgement.
          await gateway.setHistoryMessages([...BASE_HISTORY, echo]);
          const historyCount = (await gateway.getRequests("chat.history")).length;
          await emitSessionMessage(gateway, echo, "pending-handoff-echo-1", 2, [runId], {
            clientRunId: runId,
          });
          await expect
            .poll(async () => (await gateway.getRequests("chat.history")).length, {
              timeout: 10_000,
            })
            .toBeGreaterThan(historyCount);
          await page.waitForTimeout(300);
        }
        await gateway.resolveDeferred("chat.send");
        const userEcho = image
          ? {
              ...echo,
              timestamp: Date.now(),
              content: [
                { text: IMAGE_PROBE_TEXT, type: "text" },
                {
                  type: "image",
                  url: ONE_PIXEL_PNG_DATA_URL,
                  source: { type: "url", url: ONE_PIXEL_PNG_DATA_URL },
                },
              ],
              __openclaw: { ...echo["__openclaw"], runId: "queued-execution" },
            }
          : echo;
        const frames = await finishRunAndSettle(page, gateway, runId, userEcho);
        expect(
          new Set(analyzeFrameContinuity(frames, image ? isHealthyImageFrame : undefined)).size,
        ).toBe(1);
        if (image) {
          const row = page.locator("[data-virtual-row-key]").filter({ hasText: IMAGE_PROBE_TEXT });
          expect(await row.getByText("Attached image", { exact: false }).count()).toBe(0);
        } else {
          // The completed entry-animation class may remain on the stable node.
          expect(await page.locator(".chat-bubble--enter").count()).toBeLessThanOrEqual(1);
        }
      });
    },
  );
});
