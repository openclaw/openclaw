import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { ChatHost } from "../pages/chat/chat-send-contract.ts";
import { takeControlUiElementScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  createChatFlowE2eSuite,
  expectDefined,
  installMockGateway,
  newChatPage,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { waitForCommittedState } from "./settle.test-support.ts";

const suite = createChatFlowE2eSuite();
const orders = ["receipt-first", "event-first"] as const;

suite.define(() => {
  it.each(orders)("keeps image previews through the history handoff (%s)", async (order) => {
    const imageBytes = await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
    const page = await newChatPage(suite, {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const sessionKey = "agent:main:main";
    const sessionId = "image-handoff-session";
    const source = "media://inbound/stable-preview.png";
    const prompt = "Keep this image visible while the prompt is accepted.";
    const gates = { metadata: createDeferred(), image: createDeferred() };
    const requested = new Set<keyof typeof gates>();
    await page.route("**/__openclaw__/assistant-media?**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const metadata = url.searchParams.get("meta") === "1";
      requested.add(metadata ? "metadata" : "image");
      expect({
        source: url.searchParams.get("source"),
        auth: request.headers().authorization,
      }).toEqual({ source, auth: metadata ? "Bearer e2e-device-token" : undefined });
      if (!metadata) {
        expect(url.searchParams.get("mediaTicket")).toBe("stable-image-ticket");
      }
      await gates[metadata ? "metadata" : "image"].promise;
      await route.fulfill(
        metadata
          ? {
              json: {
                available: true,
                mediaTicket: "stable-image-ticket",
                mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
              },
            }
          : { contentType: "image/png", body: imageBytes },
      );
    });
    const initialHistory = {
      messages: [],
      sessionId,
      sessionInfo: {
        key: sessionKey,
        sessionId,
        kind: "direct",
        hasActiveRun: false,
        status: "done",
      },
    };
    const gateway = await installMockGateway(page, {
      sessionKey,
      sessions: [initialHistory.sessionInfo],
      historyMessages: [],
      methodResponses: { "chat.startup": initialHistory, "chat.history": initialHistory },
    });

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
      const expectDecodedImage = () =>
        expect
          .poll(() =>
            userImage.evaluate((image) =>
              image instanceof HTMLImageElement && image.complete ? image.naturalWidth : 0,
            ),
          )
          .toBe(180);
      await expectDecodedImage();
      expect(await userImage.getAttribute("src")).toMatch(/^blob:/u);
      const displayed = expectDefined(await userImage.elementHandle(), "submitted image");
      const initialPixels = await takeControlUiElementScreenshot(page, userImage, [userImage]);
      const continuity = await displayed.evaluateHandle((image) => {
        const frames: boolean[] = [];
        const initialBounds = image.getBoundingClientRect();
        let frame = 0;
        const sample = () => {
          const bounds = image.getBoundingClientRect();
          frames.push(
            image.isConnected &&
              bounds.width > 0 &&
              bounds.height > 0 &&
              bounds.width === initialBounds.width &&
              bounds.height === initialBounds.height &&
              document.querySelectorAll(".chat-group.user img.chat-message-image").length === 1 &&
              document.querySelector(".chat-group.user [aria-busy='true']") === null,
          );
          frame = requestAnimationFrame(sample);
        };
        sample();
        return {
          stop: () => {
            cancelAnimationFrame(frame);
            return frames;
          },
        };
      });
      const expectImageStillVisible = async (stage: string) => {
        expect(await displayed.evaluate((image) => image.isConnected)).toBe(true);
        expect(await userImage.count()).toBe(1);
        // Native pending sources may report zero dimensions while the browser
        // still paints the current decoded image. Compare the actual pixels.
        expect(await takeControlUiElementScreenshot(page, userImage, [userImage]), stage).toEqual(
          initialPixels,
        );
        expect(await page.locator(".chat-group.user [aria-busy='true']").count()).toBe(0);
      };
      await expectImageStillVisible("01-submitted");
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
            media: [
              {
                path: source,
                contentType: "image/png",
                fileName: "stable-preview.png",
                width: 180,
                height: 180,
              },
            ],
          },
        },
      };
      const sessionInfo = {
        ...initialHistory.sessionInfo,
        activeRunIds: [runId],
        hasActiveRun: true,
        status: "running",
      };
      const custodyHistory = {
        ...initialHistory,
        sessionInfo,
        pendingInputs: { items: [pendingInput], total: 1 },
      };
      const sessionEvent = { sessionKey, sessionId, hasActiveRun: true, session: sessionInfo };
      await gateway.setMethodResponse("chat.history", custodyHistory);
      const histories = (await gateway.getRequests("chat.history")).length;
      await gateway.emitGatewayEvent("sessions.changed", {
        ...sessionEvent,
        reason: "send",
      });
      await gateway.waitForRequest("chat.history", { after: histories });
      // Custody starts the canonical media read while the send acknowledgment is held.
      await expect.poll(() => requested.has("metadata")).toBe(true);
      await expectImageStillVisible("02-custody");
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
        ...sessionEvent,
        agentId: "main",
        runId,
        reason: "agent.run.started",
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
      await page.locator('.chat-bubble[data-entry-id="accepted-image-input"]').waitFor();
      if (order === "event-first") {
        await gateway.resolveDeferred("chat.history", canonicalHistory);
      }
      await expect.poll(() => requested.has("metadata")).toBe(true);
      await expectImageStillVisible("03-canonical-metadata-loading");
      gates.metadata.resolve();
      await expect.poll(() => requested.has("image")).toBe(true);
      await expectImageStillVisible("04-canonical-image-loading");
      gates.image.resolve();
      await expect.poll(() => userImage.getAttribute("src")).toContain("stable-image-ticket");
      await expectDecodedImage();
      await expectImageStillVisible("05-canonical-image-ready");
      const frames = await continuity.evaluate((sampler) => sampler.stop());
      await continuity.dispose();
      expect(frames.length).toBeGreaterThan(1);
      expect(frames.every(Boolean)).toBe(true);
    } finally {
      gates.metadata.resolve();
      gates.image.resolve();
    }
  });
});
