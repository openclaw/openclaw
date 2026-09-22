// Control UI E2E tests cover the pending-send bubble handoff to authoritative history.
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
  t: number;
  present: boolean;
  rowKeys: string[];
  imageCount: number;
  loadedImageCount: number;
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

async function startFrameSampler(currentPage: Page, probeText = PROBE_TEXT): Promise<void> {
  await currentPage.evaluate((text) => {
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
        t: performance.now(),
        present: rows.length > 0,
        rowKeys: rows.map((row) => row.dataset.virtualRowKey ?? ""),
        imageCount: images.length,
        loadedImageCount: images.filter(
          (image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
        ).length,
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, probeText);
}

async function stopFrameSampler(currentPage: Page): Promise<FrameSample[]> {
  return currentPage.evaluate(() => {
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
  expect(
    continuityFrames
      .filter((frame) => !isHealthy(frame))
      .map((frame) => ({
        imageCount: frame.imageCount,
        loadedImageCount: frame.loadedImageCount,
        present: frame.present,
        rowKeys: frame.rowKeys,
        t: frame.t,
      })),
  ).toEqual([]);
  const keyTimeline: string[] = [];
  for (const frame of continuityFrames) {
    for (const key of frame.rowKeys) {
      if (keyTimeline[keyTimeline.length - 1] !== key) {
        keyTimeline.push(key);
      }
    }
  }
  return keyTimeline;
}

const BASE_HISTORY = [
  {
    content: [{ text: "Ready.", type: "text" }],
    role: "assistant",
    timestamp: Date.now() - 5_000,
    __openclaw: { seq: 1 },
  },
];

type ChatSendParams = {
  attachments?: Array<{ content?: string; mimeType?: string }>;
  idempotencyKey?: string;
};

async function openChatAndSubmitProbe(
  currentPage: Page,
  gateway: MockGatewayControls,
  opts: { attachImage?: boolean; deferSend?: boolean; probeText?: string } = {},
): Promise<{ runId: string; sendParams: ChatSendParams }> {
  const probeText = opts.probeText ?? PROBE_TEXT;
  await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
  await currentPage.getByText("Ready.").waitFor({ timeout: 10_000 });
  await gateway.waitForRequest("sessions.list");
  if (opts.attachImage) {
    await currentPage.locator(".agent-chat__file-input").setInputFiles({
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
    });
    await currentPage.locator(".chat-attachment-thumb").waitFor({ state: "visible" });
  }
  if (opts.deferSend) {
    await gateway.deferNext("chat.send");
  }
  await startFrameSampler(currentPage, probeText);
  await currentPage.locator(".agent-chat__input textarea").fill(probeText);
  await currentPage.locator(".agent-chat__input textarea").press("Enter");
  const send = await gateway.waitForRequest("chat.send");
  const sendParams = send.params as ChatSendParams;
  const runId = sendParams.idempotencyKey ?? "";
  expect(runId).toBeTruthy();
  await currentPage
    .locator("[data-virtual-row-key]")
    .getByText(probeText, { exact: true })
    .waitFor({ timeout: 10_000 });
  return { runId, sendParams };
}

async function finishRunAndSettle(
  currentPage: Page,
  gateway: MockGatewayControls,
  runId: string,
  userEcho: Record<string, unknown>,
): Promise<FrameSample[]> {
  await gateway.setHistoryMessages([
    ...BASE_HISTORY,
    userEcho,
    {
      content: [{ text: "Run complete.", type: "text" }],
      role: "assistant",
      timestamp: Date.now() + 1,
      __openclaw: { seq: 3 },
    },
  ]);
  // The terminal reconciliation must re-read history; baseline before the
  // final so either trigger (final event or terminal session row) counts.
  const historyRequestsBeforeTerminal = (await gateway.getRequests("chat.history")).length;
  const finalMessage = {
    content: [{ text: "Run complete.", type: "text" }],
    role: "assistant",
    timestamp: Date.now() + 1,
    __openclaw: { seq: 3 },
  };
  await gateway.emitChatFinal({ runId, text: "Run complete." });
  await currentPage
    .locator(".chat-bubble")
    .getByText("Run complete.", { exact: true })
    .waitFor({ timeout: 10_000 });
  // The Gateway persists the assistant turn and publishes it with a terminal
  // session row; this is what triggers the authoritative history reload.
  await gateway.emitGatewayEvent("session.message", {
    activeRunIds: [],
    clientRunId: runId,
    hasActiveRun: false,
    message: finalMessage,
    messageId: "pending-handoff-final-1",
    messageSeq: 3,
    session: {
      activeRunIds: [],
      hasActiveRun: false,
      key: "main",
      kind: "direct",
      status: "done",
      updatedAt: Date.now(),
    },
    sessionKey: "main",
  });
  // The handoff must complete: history is re-read and the probe bubble becomes
  // the authoritative copy (its data-entry-id comes only from loaded history,
  // never from the pending queue projection).
  await expect
    .poll(async () => (await gateway.getRequests("chat.history")).length, { timeout: 10_000 })
    .toBeGreaterThan(historyRequestsBeforeTerminal);
  await expect
    .poll(
      () => currentPage.locator(`.chat-bubble[data-entry-id="${USER_ECHO_ENTRY_ID}"]`).count(),
      {
        timeout: 10_000,
      },
    )
    .toBe(1);
  // Let a few more frames elapse so trailing samples cover the settled state.
  await currentPage.waitForTimeout(500);
  return stopFrameSampler(currentPage);
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
        const captureProof = async (filename: string) => {
          if (proofDir) {
            await page.screenshot({ path: path.join(proofDir, filename) });
          }
        };
        const ready = {
          role: "assistant",
          content: [{ type: "text", text: "The PR is ready to land." }],
          timestamp: Date.now() - 20_000,
          __openclaw: { id: "ready-to-land", seq: 119 },
        };
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-5.5",
          presenceUsers: [],
          sessions: [{ key: "main", sessionId, label: "Pending assistant recovery" }],
          historyMessages: [ready],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("The PR is ready to land.", { exact: true }).waitFor();
        await gateway.deferNext("chat.send");
        await page.getByRole("combobox", { name: "Chat composer", exact: true }).fill(prompt);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const send = await gateway.waitForRequest("chat.send");
        const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
        expect(runId).toBeTruthy();
        // The sequence-bearing ACK retires the outbox without its transcript
        // payload. Older history must retire the remaining local display copy.
        await gateway.resolveDeferred("chat.send", { runId, status: "started", messageSeq: 120 });
        const canonicalUser = {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now() - 10_000,
          __openclaw: { id: "canonical-land-request", seq: 120, idempotencyKey: `${runId}:user` },
        };
        const tail = {
          role: "assistant",
          content: [{ type: "text", text: "All checks passed. Finishing the landing." }],
          timestamp: Date.now() - 1000,
          __openclaw: { id: "landing-checks", seq: 200 },
        };
        const session = {
          key: "main",
          sessionId,
          hasActiveRun: false,
          activeRunIds: [],
          status: "done",
        };
        const latestPage = {
          sessionId,
          sessionInfo: session,
          messages: [tail],
          hasMore: true,
          nextOffset: 80,
          totalMessages: 200,
          thinkingLevel: null,
          inputReceipts: [],
        };
        await gateway.setMethodResponse("chat.history", {
          cases: [
            {
              match: { offset: 80 },
              response: {
                sessionId,
                sessionInfo: session,
                messages: [ready, canonicalUser],
                hasMore: false,
                totalMessages: 200,
                thinkingLevel: null,
              },
            },
            { match: {}, response: latestPage },
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
        const readQualification = () =>
          pane.evaluate((element) => {
            const state = (
              element as HTMLElement & { state: { chatMessages: Array<Record<string, unknown>> } }
            ).state;
            return state.chatMessages.map((message) => ({
              role: message.role,
              content: message.content,
              metadata: message["__openclaw"],
              fallback: message.openclawStreamFallback,
            }));
          });
        await expect.poll(readQualification).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "user",
              metadata: { idempotencyKey: `${runId}:user` },
            }),
            expect.objectContaining({ role: "assistant", fallback: expect.any(Object) }),
          ]),
        );
        await page
          .getByText("All checks passed. Finishing the landing.", { exact: true })
          .waitFor();
        const before = await readQualification();
        const pendingUser = before.find((message) => message.role === "user");
        const pendingAssistant = before.find(
          (message) => message.role === "assistant" && message.fallback,
        );
        expect(pendingUser?.metadata).toEqual({ idempotencyKey: `${runId}:user` });
        expect(pendingAssistant?.metadata).toBeUndefined();
        expect(before.indexOf(pendingAssistant!)).toBe(before.indexOf(pendingUser!) + 1);
        await waitForChatScrollIdle(page);
        await captureProof("pending-assistant-before-history.png");

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
        const after = await readQualification();
        const userCount = await pane
          .locator(".chat-bubble")
          .getByText(prompt, { exact: true })
          .count();
        const fallbackCount = await pane
          .locator(".chat-bubble")
          .getByText(fallback, { exact: true })
          .count();
        await captureProof("pending-assistant-after-history.png");
        if (proofDir) {
          await writeFile(
            path.join(proofDir, "pending-assistant-proof.json"),
            JSON.stringify(
              {
                before,
                after,
                userCount,
                fallbackCount,
                sends: (await gateway.getRequests("chat.send")).length,
              },
              null,
              2,
            ) + "\n",
          );
        }
        expect(userCount).toBe(1);
        expect(fallbackCount).toBe(1);
        expect(after.filter((message) => message.role === "user")).toHaveLength(1);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      },
    );
  });

  it("does not recreate a consumed prompt outside the visible history page after reconnect", async () => {
    const proofDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()
      ? suite.artifactDir
      : undefined;
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page: currentPage }) => {
        const captureProof = async (filename: string) => {
          if (proofDir) {
            await currentPage.screenshot({ path: path.join(proofDir, filename) });
          }
        };
        const sessionId = "consumed-prompt-session";
        const prompt = "land PR";
        const finalText = "Landed the PR. All focused checks passed.";
        const executionRunId = "recovered-execution";
        const gateway = await installMockGateway(currentPage, {
          agentModel: "openai/gpt-5.5",
          historyMessages: BASE_HISTORY,
          sessions: [{ key: "main", sessionId, label: "Synthetic PR landing" }],
        });
        const { runId } = await openChatAndSubmitProbe(currentPage, gateway, {
          deferSend: true,
          probeText: prompt,
        });
        await stopFrameSampler(currentPage);
        await gateway.setOnline(false);
        await currentPage
          .locator('.chat-send-status[data-send-state="waiting-reconnect"]')
          .getByText("Waiting for reconnect", { exact: true })
          .waitFor();

        const timestamp = Date.now() - 60_000;
        const userEcho = {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp,
          __openclaw: {
            id: USER_ECHO_ENTRY_ID,
            idempotencyKey: `${runId}:user`,
            runId: executionRunId,
            seq: 489,
          },
        };
        const checks = Array.from({ length: 57 }, (_, index) => {
          const seq = 490 + index * 2;
          const toolCallId = `synthetic-check-${index}`;
          return [
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: toolCallId,
                  name: "exec",
                  arguments: { command: "pnpm check" },
                },
              ],
              timestamp: timestamp + seq,
              __openclaw: { id: `entry-${seq}`, seq, runId: executionRunId },
            },
            {
              role: "toolResult",
              toolCallId,
              toolName: "exec",
              content: [{ type: "text", text: "Focused check passed." }],
              timestamp: timestamp + seq + 1,
              __openclaw: { id: `entry-${seq + 1}`, seq: seq + 1, runId: executionRunId },
            },
          ];
        }).flat();
        const finalMessage = {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          timestamp: timestamp + 605,
          __openclaw: { id: "consumed-prompt-final", seq: 605, runId: executionRunId },
        };
        const history = [...BASE_HISTORY, userEcho, ...checks, finalMessage];
        const recent = history.slice(-80);
        const older = history.slice(0, -80);
        const sessionInfo = {
          key: "main",
          sessionId,
          status: "done",
          activeRunIds: [],
          hasActiveRun: false,
          lastRunId: executionRunId,
        };
        const response = {
          sessionId,
          sessionInfo,
          thinkingLevel: null,
          totalMessages: 605,
        };
        const latestPage = { ...response, messages: recent, hasMore: true, nextOffset: 80 };
        await gateway.setMethodResponse("chat.startup", latestPage);
        await gateway.setMethodResponse("chat.history", {
          cases: [
            {
              match: { inputRunIds: [runId], limit: 1000 },
              response: {
                ...response,
                messages: history,
                hasMore: false,
                inputReceipts: [
                  { runId, state: "consumed", consumedByEventId: USER_ECHO_ENTRY_ID },
                ],
              },
            },
            { match: { offset: 80 }, response: { ...response, messages: older, hasMore: false } },
            { match: {}, response: latestPage },
          ],
        });
        // Collapsed tool turns fit the viewport, so the UI can request older
        // history immediately. Hold that response until after receipt recovery.
        await gateway.deferNext("chat.history", { offset: 80 });
        await gateway.setOnline(true);
        await gateway.waitForRequest("chat.history", {
          match: { inputRunIds: [runId], limit: 1000 },
        });
        await currentPage.getByText(finalText, { exact: true }).waitFor();
        await expect.poll(() => currentPage.locator(".chat-send-status").count()).toBe(0);
        await gateway.emitGatewayEvent("session.message", {
          sessionKey: "main",
          sessionId,
          clientRunId: executionRunId,
          message: finalMessage,
          messageId: "consumed-prompt-final",
          messageSeq: 605,
          activeRunIds: [],
          hasActiveRun: false,
          session: sessionInfo,
        });
        await waitForChatScrollIdle(currentPage);
        // Retain the failed UI too: a phantom source appears below the completed
        // answer even though its only durable copy belongs to an older page.
        await captureProof("consumed-prompt-latest-page.png");
        const userBubbles = currentPage.locator(".chat-bubble").getByText(prompt, { exact: true });
        const latestPromptCount = await userBubbles.count();

        await gateway.waitForRequest("chat.history", { match: { offset: 80 } });
        await gateway.resolveDeferred("chat.history");
        await waitForChatScrollIdle(currentPage);
        const thread = currentPage.locator(".chat-pane-cache__pane--active .chat-thread");
        await thread.hover();
        await currentPage.mouse.wheel(0, -1_000_000);
        await gateway.waitForRequest("chat.history", { match: { offset: 80 } });
        await currentPage.locator(`.chat-bubble[data-entry-id="${USER_ECHO_ENTRY_ID}"]`).waitFor();
        await waitForChatScrollIdle(currentPage);
        await captureProof("consumed-prompt-loaded-history.png");
        expect(latestPromptCount).toBe(0);
        expect(await userBubbles.count()).toBe(1);
        expect(await currentPage.locator(".chat-send-status").count()).toBe(0);
        expect(await currentPage.getByRole("button", { name: "Stop", exact: true }).count()).toBe(
          0,
        );
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      },
    );
  });

  it("does not replay a retired user bubble after a later history page omits it", async () => {
    const proofDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim()
      ? suite.artifactDir
      : undefined;
    await suite.withPage(
      {
        viewport: { height: 800, width: 1200 },
        ...(proofDir ? { recordVideo: { dir: proofDir } } : {}),
      },
      async ({ page: currentPage }) => {
        const captureProof = (filename: string) =>
          proofDir ? currentPage.screenshot({ path: path.join(proofDir, filename) }) : undefined;
        const gateway = await installMockGateway(currentPage, { historyMessages: BASE_HISTORY });
        const { runId } = await openChatAndSubmitProbe(currentPage, gateway);
        await captureProof("01-submitted.png");
        await finishRunAndSettle(currentPage, gateway, runId, {
          role: "user",
          content: [{ type: "text", text: PROBE_TEXT }],
          timestamp: Date.now(),
          __openclaw: { id: USER_ECHO_ENTRY_ID, idempotencyKey: runId, seq: 2 },
        });
        await captureProof("02-canonical.png");

        const laterMessage = {
          role: "assistant",
          content: [{ type: "text", text: "Later history window." }],
          timestamp: Date.now() + 2,
          __openclaw: { id: "later-window", seq: 4 },
        };
        await gateway.setHistoryMessages([laterMessage]);
        const historyRequestsBefore = (await gateway.getRequests("chat.history")).length;
        await gateway.emitGatewayEvent("session.message", {
          sessionKey: "main",
          message: laterMessage,
          messageId: "later-window",
          messageSeq: 4,
          activeRunIds: [],
          hasActiveRun: false,
          session: {
            key: "main",
            kind: "direct",
            status: "done",
            hasActiveRun: false,
            activeRunIds: [],
            updatedAt: Date.now(),
          },
        });
        await expect
          .poll(async () => (await gateway.getRequests("chat.history")).length)
          .toBeGreaterThan(historyRequestsBefore);
        await currentPage.getByText("Later history window.", { exact: true }).waitFor();
        const probe = currentPage.locator(".chat-bubble").getByText(PROBE_TEXT, { exact: true });
        await expect.poll(() => probe.count()).toBe(0);
        await captureProof("03-later-page.png");

        await startFrameSampler(currentPage);
        await gateway.emitChatFinal({ runId, text: "Run complete." });
        // Observe the replay over rendered frames, including asynchronous outbox
        // retirement and trailing history reconciliation, not just the first tick.
        await currentPage.waitForTimeout(500);
        const frames = await stopFrameSampler(currentPage);
        await captureProof("04-terminal-replay.png");
        expect(frames.length).toBeGreaterThan(0);
        expect(frames.filter((frame) => frame.present)).toEqual([]);
        expect(await probe.count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      },
    );
  });

  it("keeps a submitted image visible when queued execution changes its run ID", async () => {
    await suite.withPage(
      { viewport: { height: 800, width: 1200 } },
      async ({ page: currentPage }) => {
        const gateway = await installMockGateway(currentPage, { historyMessages: BASE_HISTORY });
        const { runId, sendParams } = await openChatAndSubmitProbe(currentPage, gateway, {
          attachImage: true,
          deferSend: true,
          probeText: IMAGE_PROBE_TEXT,
        });

        expect(sendParams.attachments?.[0]).toMatchObject({
          content: ONE_PIXEL_PNG_B64,
          mimeType: "image/png",
        });
        // A locally submitted turn plays the composer entry animation exactly once.
        expect(await currentPage.locator(".chat-bubble--enter").count()).toBe(1);
        await expect
          .poll(() =>
            currentPage.evaluate(() =>
              ((window as SamplerWindow).openclawSendFrameSamples ?? []).some(
                (frame) =>
                  frame.rowKeys.length === 1 &&
                  frame.imageCount === 1 &&
                  frame.loadedImageCount === 1,
              ),
            ),
          )
          .toBe(true);
        await gateway.resolveDeferred("chat.send");

        const frames = await finishRunAndSettle(currentPage, gateway, runId, {
          content: [
            { text: IMAGE_PROBE_TEXT, type: "text" },
            {
              type: "image",
              url: ONE_PIXEL_PNG_DATA_URL,
              source: { type: "url", url: ONE_PIXEL_PNG_DATA_URL },
            },
          ],
          role: "user",
          timestamp: Date.now(),
          __openclaw: {
            id: USER_ECHO_ENTRY_ID,
            idempotencyKey: runId,
            runId: "queued-execution",
            seq: 2,
          },
        });

        const keyTimeline = analyzeFrameContinuity(frames, isHealthyImageFrame);
        // The bubble keeps one identity through the pending -> history handoff, so
        // the DOM node is never remounted (no animation replay, no layout jump).
        expect(new Set(keyTimeline).size).toBe(1);
        const submittedRow = currentPage
          .locator("[data-virtual-row-key]")
          .filter({ hasText: IMAGE_PROBE_TEXT });
        expect(await submittedRow.getByText("Attached image", { exact: false }).count()).toBe(0);
      },
    );
  });

  it("keeps the submitted user turn visible when the session echo lands before the send ack", async () => {
    await suite.withPage(
      { viewport: { height: 800, width: 1200 } },
      async ({ page: currentPage }) => {
        const gateway = await installMockGateway(currentPage, { historyMessages: BASE_HISTORY });
        const { runId } = await openChatAndSubmitProbe(currentPage, gateway, { deferSend: true });

        // The Gateway persists and broadcasts the user turn before the ack resolves.
        const userEcho = {
          content: [{ text: PROBE_TEXT, type: "text" }],
          role: "user",
          timestamp: Date.now(),
          __openclaw: { id: USER_ECHO_ENTRY_ID, idempotencyKey: runId, seq: 2 },
        };
        await gateway.setHistoryMessages([...BASE_HISTORY, userEcho]);
        const historyRequestsBefore = (await gateway.getRequests("chat.history")).length;
        await gateway.emitGatewayEvent("session.message", {
          activeRunIds: [runId],
          clientRunId: runId,
          hasActiveRun: true,
          message: userEcho,
          messageId: "pending-handoff-echo-1",
          messageSeq: 2,
          session: {
            activeRunIds: [runId],
            hasActiveRun: true,
            key: "main",
            kind: "direct",
            status: "running",
            updatedAt: Date.now(),
          },
          sessionKey: "main",
        });
        await expect
          .poll(async () => (await gateway.getRequests("chat.history")).length, {
            timeout: 10_000,
          })
          .toBeGreaterThan(historyRequestsBefore);
        await currentPage.waitForTimeout(300);
        await gateway.resolveDeferred("chat.send");

        const frames = await finishRunAndSettle(currentPage, gateway, runId, userEcho);
        const keyTimeline = analyzeFrameContinuity(frames);
        expect(new Set(keyTimeline).size).toBe(1);
        // The single stable key above proves the node never remounted, so the
        // entry animation cannot have replayed; at most the one submitted turn
        // still carries the (inert, completed) animation class.
        expect(await currentPage.locator(".chat-bubble--enter").count()).toBeLessThanOrEqual(1);
      },
    );
  });
});
