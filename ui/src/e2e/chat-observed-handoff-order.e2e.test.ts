import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { rasterizeProofAnnotations } from "../test-helpers/proof-annotations.ts";
import { sendMessage } from "./chat-flow-fixtures.test-support.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps an observed accepted handoff before remote and local successor turns", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const sessionKey = "agent:main:dashboard:handoff-order-proof";
        const sessionId = "handoff-order-proof-session";
        const handoffText = "The handoff is ready. Verify the result next.";
        const nextText = "Continue from the handoff.";
        const replyText = "The result is verified.";
        const localText = "Summarize the verified result.";
        const now = Date.now();
        const session = {
          key: sessionKey,
          sessionId,
          kind: "direct",
          label: "Handoff ordering",
          status: "idle",
          hasActiveRun: false,
          activeRunIds: [],
          updatedAt: now,
        };
        const messages = [
          {
            role: "user",
            content: "Prepare the work for a handoff.",
            timestamp: now - 20_000,
            __openclaw: { id: "earlier-request", seq: 1 },
          },
          {
            role: "assistant",
            content: "The current work is complete.",
            timestamp: now - 10_000,
            __openclaw: { id: "earlier-reply", seq: 2 },
          },
        ];
        const pendingInputs = {
          total: 1,
          items: [
            {
              id: "earlier-handoff",
              runId: "earlier-handoff-run",
              acceptedAt: now - 5_000,
              state: "queued",
              message: {
                role: "assistant",
                content: handoffText,
                timestamp: now - 5_000,
                provenance: { kind: "inter_session", sourceTool: "sessions_send" },
                senderSession: { sessionKey: "agent:helper:main", agentId: "helper" },
                __openclaw: { id: "pending:earlier-handoff" },
              },
            },
          ],
        };
        const history = {
          ...prepareChatHistoryFixture(messages),
          pendingInputs,
          inputReceipts: [{ runId: "earlier-handoff-run", state: "pending" }],
          sessionId,
          sessionInfo: session,
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessionInfo: session,
          sessions: [session],
          methodResponses: { "chat.startup": history, "chat.history": history },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        const labels = new Set([
          ...messages.map((message) => message.content),
          handoffText,
          nextText,
          replyText,
          localText,
        ]);
        const order = async () =>
          (await thread.locator(".chat-text").allTextContents())
            .map((text) => text.trim())
            .filter((text) => labels.has(text));
        const initial = [...messages.map((message) => message.content), handoffText];
        // Inter-session updates start collapsed in the real transcript.
        await thread.locator(".chat-session-activity__chevron").click();
        await expect.poll(order).toEqual(initial);

        // Another client can publish a saved turn without a local optimistic row.
        const next = {
          role: "user",
          content: nextText,
          timestamp: now - 100_000,
          __openclaw: { id: "next-request", seq: 3, idempotencyKey: "remote-turn:user" },
        };
        const reply = {
          role: "assistant",
          content: replyText,
          timestamp: now - 99_000,
          __openclaw: { id: "next-reply", seq: 4, runId: "remote-turn" },
        };
        const saved = [...messages, next, reply];
        await gateway.setMethodResponse("chat.history", {
          ...history,
          ...prepareChatHistoryFixture(saved),
        });
        for (const [message, messageId, messageSeq] of [
          [next, "next-request", 3],
          [reply, "next-reply", 4],
        ] as const) {
          await gateway.emitGatewayEvent("session.message", {
            sessionKey,
            agentId: "main",
            session,
            message,
            messageId,
            messageSeq,
          });
          await thread
            .locator(".chat-bubble")
            .getByText(message.content, { exact: true })
            .waitFor();
        }
        // Capture the real before-state too, before the regression assertion fails.
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const handoff = thread.getByText(handoffText, { exact: true });
          const successor = thread.getByText(nextText, { exact: true });
          const frame = await takeControlUiScreenshotFrame(page, thread, [handoff, successor], {
            elements: [handoff, successor],
            animations: "disabled",
          });
          await writeFile(path.join(suite.artifactDir, "canonical-clean.png"), frame.png);
          const annotated = await rasterizeProofAnnotations(suite.browser, {
            image: frame.png,
            viewport: page.viewportSize()!,
            scale: await page.evaluate(() => window.devicePixelRatio),
            annotations: [
              {
                kind: "outline",
                rect: frame.elements[0]!.bounds,
                text: "Previously visible handoff",
                labelAt: { x: 32, y: 32 },
                color: "#ffb000",
              },
            ],
          });
          await writeFile(path.join(suite.artifactDir, "canonical-annotated.png"), annotated);
        }
        await expect.poll(order).toEqual([...initial, nextText, replyText]);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        await gateway.deferNext("chat.send");
        await sendMessage(page, localText);
        const send = await gateway.waitForRequest("chat.send");
        const runId = requireString(
          requireRecord(send.params).idempotencyKey,
          "send idempotency key",
        );
        await expect.poll(order).toEqual([...initial, nextText, replyText, localText]);
        const confirmed = {
          role: "user",
          content: localText,
          timestamp: now + 1_000,
          __openclaw: { id: "local-request", seq: 5, idempotencyKey: `${runId}:user` },
        };
        await gateway.setMethodResponse("chat.history", {
          ...history,
          ...prepareChatHistoryFixture([...saved, confirmed]),
          inputReceipts: [
            ...history.inputReceipts,
            { runId, state: "consumed", consumedByEventId: "local-request" },
          ],
        });
        await gateway.resolveDeferred("chat.send", { runId, status: "started", messageSeq: 5 });
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          agentId: "main",
          session,
          message: confirmed,
          messageId: "local-request",
          messageSeq: 5,
        });
        await expect.poll(() => page.locator(".chat-send-status").count()).toBe(0);
        await expect.poll(order).toEqual([...initial, nextText, replyText, localText]);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      },
    );
  });
});
