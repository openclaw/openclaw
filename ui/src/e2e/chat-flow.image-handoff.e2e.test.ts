import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { ChatHost } from "../pages/chat/chat-send-contract.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { waitForCommittedState } from "./settle.test-support.ts";

const suite = createChatFlowE2eSuite();
const orders = ["receipt-first", "event-first"] as const;

suite.define(() => {
  it.each(orders)("moves accepted image above composer (%s)", async (order) => {
    const proofDir = captureUiProofEnabled ? suite.artifactDir : undefined;
    const imageBytes = await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(proofDir ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1280 } } } : {}),
      },
      async ({ page }) => {
        const sessionKey = "agent:main:main";
        const sessionId = "image-handoff-session";
        const source = "media://inbound/stable-preview.png";
        const prompt = "Keep this image visible while the prompt is accepted.";
        let releaseMetadata!: () => void;
        let releaseImage!: () => void;
        const metadataGate = new Promise<void>((resolve) => {
          releaseMetadata = resolve;
        });
        const imageGate = new Promise<void>((resolve) => {
          releaseImage = resolve;
        });
        let metadataRequested = false;
        let imageRequested = false;
        await page.route("**/__openclaw__/assistant-media?**", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          expect(url.searchParams.get("source")).toBe(source);
          if (url.searchParams.get("meta") === "1") {
            metadataRequested = true;
            expect(request.headers().authorization).toBe("Bearer e2e-device-token");
            await metadataGate;
            await route.fulfill({
              json: {
                available: true,
                mediaTicket: "stable-image-ticket",
                mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
              },
            });
          } else {
            imageRequested = true;
            expect(url.searchParams.get("mediaTicket")).toBe("stable-image-ticket");
            expect(request.headers().authorization).toBeUndefined();
            await imageGate;
            await route.fulfill({ contentType: "image/png", body: imageBytes });
          }
        });
        const initialHistory = {
          messages: [],
          sessionId,
          sessionInfo: { key: sessionKey, kind: "direct", hasActiveRun: false, status: "done" },
        };
        const gateway = await installMockGateway(page, {
          historyMessages: [],
          methodResponses: { "chat.startup": initialHistory, "chat.history": initialHistory },
        });
        const proofSurface = page.locator(".shell");
        const capture = async (stage: string, content: Locator) => {
          if (proofDir) {
            await writeFile(
              path.join(proofDir, `${stage}.png`),
              await takeControlUiViewportScreenshot(page, proofSurface, [content]),
            );
          }
        };

        try {
          await page.goto(`${suite.server.baseUrl}chat`);
          await gateway.waitForRequest("chat.startup");
          await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
          await page.locator(".agent-chat__file-input").setInputFiles({
            name: "stable-preview.png",
            mimeType: "image/png",
            buffer: imageBytes,
          });
          await page.getByRole("img", { name: "stable-preview.png" }).waitFor();
          await gateway.deferNext("chat.history", { limit: 1000 });
          await gateway.deferNext("chat.send");
          await page.getByRole("button", { name: "Send message" }).click();
          const request = await gateway.waitForRequest("chat.send");
          expect(request.params).toMatchObject({
            message: prompt,
            attachments: [{ fileName: "stable-preview.png", mimeType: "image/png" }],
          });
          const runId = requireString(
            requireRecord(request.params).idempotencyKey,
            "image send identity",
          );
          const userImage = page.locator(".chat-group.user img.chat-message-image");
          await expect
            .poll(() =>
              userImage.evaluate((image) =>
                image instanceof HTMLImageElement && image.complete ? image.naturalWidth : 0,
              ),
            )
            .toBe(180);
          expect(await userImage.getAttribute("src")).toMatch(/^blob:/u);
          await capture("01-submitted", userImage);
          const acceptedAt = Date.now();
          const pendingInput = {
            id: "accepted-image-input",
            runId,
            acceptedAt,
            state: "queued",
            message: {
              role: "user",
              content: prompt,
              timestamp: acceptedAt,
              __openclaw: {
                id: "pending:accepted-image-input",
                mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
                media: [{ path: source, contentType: "image/png", fileName: "stable-preview.png" }],
              },
            },
          };
          const sessionInfo = {
            key: sessionKey,
            kind: "direct",
            activeRunIds: [runId],
            hasActiveRun: true,
            status: "running",
          };
          const custodyHistory = {
            messages: [],
            sessionId,
            sessionInfo,
            pendingInputs: { items: [pendingInput], total: 1 },
          };
          await gateway.setMethodResponse("chat.history", custodyHistory);
          const histories = (await gateway.getRequests("chat.history")).length;
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey,
            sessionId,
            reason: "send",
            hasActiveRun: true,
            session: sessionInfo,
          });
          await gateway.waitForRequest("chat.history", { after: histories });
          const pendingRow = page.locator(".chat-queue__item", { hasText: prompt });
          await pendingRow.waitFor();
          expect(await pendingRow.locator("button").count()).toBe(0);
          expect(await page.locator(".chat-group.user", { hasText: prompt }).count()).toBe(0);
          expect(await userImage.count()).toBe(0);
          expect(metadataRequested).toBe(false);
          await capture("02-custody", pendingRow);
          await gateway.resolveDeferred("chat.send", { runId, status: "started" });
          await waitForCommittedState(
            page,
            ({ runId: expectedRunId }) => {
              const state = document.querySelector<HTMLElement & { state: ChatHost }>(
                "openclaw-chat-pane",
              )?.state;
              return state !== undefined && state.chatRunId === expectedRunId && !state.chatSending;
            },
            { runId },
          );
          // The owning run's lifecycle update wakes its custody reconciliation.
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey,
            sessionId,
            agentId: "main",
            runId,
            reason: "agent.run.started",
            hasActiveRun: true,
            session: sessionInfo,
          });
          await gateway.waitForRequest("chat.history", { match: { limit: 1000 } });

          const canonical = {
            ...pendingInput.message,
            __openclaw: {
              ...pendingInput.message["__openclaw"],
              id: pendingInput.id,
              seq: 1,
              idempotencyKey: `${runId}:user`,
            },
          };
          const canonicalHistory = {
            ...custodyHistory,
            messages: [canonical],
            pendingInputs: { items: [], total: 0 },
          };
          await gateway.setMethodResponse("chat.history", canonicalHistory);
          if (order === "receipt-first") {
            const followups = (await gateway.getRequests("chat.history", { limit: 80 })).length;
            await gateway.resolveDeferred("chat.history", canonicalHistory);
            await gateway.waitForRequest("chat.history", {
              match: { limit: 80 },
              after: followups,
            });
          }
          await gateway.emitGatewayEvent("session.message", {
            sessionKey,
            sessionId,
            hasActiveRun: true,
            messageId: pendingInput.id,
            messageSeq: 1,
            message: canonical,
          });
          const canonicalBubble = page.locator(
            '.chat-bubble[data-entry-id="accepted-image-input"]',
          );
          await canonicalBubble.waitFor();
          await expect.poll(() => pendingRow.count()).toBe(0);
          if (order === "event-first") {
            await gateway.resolveDeferred("chat.history", canonicalHistory);
          }
          await expect.poll(() => metadataRequested).toBe(true);
          await capture("03-canonical-metadata-loading", canonicalBubble);
          releaseMetadata();
          await expect.poll(() => imageRequested).toBe(true);
          await capture("04-canonical-image-loading", userImage);
          releaseImage();
          await expect.poll(() => userImage.getAttribute("src")).toContain("stable-image-ticket");
          await expect
            .poll(() =>
              userImage.evaluate((image) =>
                image instanceof HTMLImageElement && image.complete ? image.naturalWidth : 0,
              ),
            )
            .toBe(180);
          expect(await page.locator(".chat-group.user", { hasText: prompt }).count()).toBe(1);
          await capture("05-canonical-image-ready", userImage);
        } finally {
          releaseMetadata();
          releaseImage();
          if ((await proofSurface.count()) > 0) {
            await capture("06-final", proofSurface);
          }
        }
      },
    );
  });
});
