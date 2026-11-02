import { expect, it } from "vitest";
import { controlUiSessionPath, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI dashboard final reply recovery",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const dashboardPath = controlUiSessionPath(sessionKey).replace(/^\/chat\//u, "/dashboard/");
const textContent = (text: string) => [{ type: "text", text }];

suite.define(() => {
  it("projects a distinct durable reply after interim text and a message-less terminal", async () => {
    await suite.withPage(
      { locale: "en-US", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey,
          featureMethods: ["board.get", "chat.metadata", "chat.startup"],
          sessions: [
            {
              boardFace: "dashboard",
              key: sessionKey,
              kind: "direct",
              label: "Nightly Disk Cleanup",
              updatedAt: Date.now(),
            },
          ],
          methodResponses: {
            "board.get": {
              revision: 1,
              sessionKey,
              tabs: [
                { tabId: "main", title: "Nightly Disk Cleanup", position: 0, chatDock: "right" },
              ],
              widgets: [],
            },
            "sessions.resolve": { ok: true, key: sessionKey, boardFace: "dashboard" },
          },
        });

        await page.goto(new URL(dashboardPath, suite.server.baseUrl).href);
        const prompt = "Why did Done appear without my reply?";
        const interimText = "Checking the dashboard state.";
        const updatedInterimText = "Still checking the dashboard state.";
        const partialFinalText = "Drafting the durable dashboard reply.";
        const stalePartialFinalText = "Drafting more of the durable dashboard reply.";
        const finalText = "The durable dashboard reply is visible after Done.";
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const params = send.params as Record<string, unknown>;
        const runId = typeof params.idempotencyKey === "string" ? params.idempotencyKey : "";
        expect(runId).not.toBe("");

        const emitDelta = (text: string, seq: number, replace = false) =>
          gateway.emitGatewayEvent("chat", {
            runId,
            sessionKey,
            seq,
            state: "delta",
            deltaText: text,
            ...(replace ? { replace } : {}),
            message: { role: "assistant", content: textContent(text), timestamp: seq },
          });
        await emitDelta(interimText, 1);
        await page.locator(".chat-thread-inner", { hasText: interimText }).waitFor();
        await emitDelta(partialFinalText, 2, true);
        await page.locator(".chat-thread-inner", { hasText: partialFinalText }).waitFor();

        const assistantMessage = (id: string, text: string, seq: number, phase?: string) => ({
          role: "assistant",
          timestamp: seq,
          __openclaw: { id: `dashboard-${id}`, runId, seq },
          ...(phase
            ? { phase, content: [{ text, type: "text", cache_control: { type: "ephemeral" } }] }
            : { content: textContent(text), stopReason: "stop" }),
        });
        const persistedHistory = [
          {
            role: "user",
            content: textContent(prompt),
            timestamp: 1,
            __openclaw: { id: "dashboard-prompt", idempotencyKey: `${runId}:user`, seq: 1 },
          },
          // Stale phased messages retain reordered keys and cache metadata, not a terminal reply.
          assistantMessage("interim", updatedInterimText, 2, "commentary"),
          assistantMessage("partial-final", stalePartialFinalText, 3, "final_answer"),
          assistantMessage("final", finalText, 4),
        ];
        const historyCount = (await gateway.getRequests("chat.history")).length;
        await gateway.setHistoryMessages(persistedHistory);
        await gateway.emitGatewayEvent("chat", {
          runId,
          sessionKey,
          state: "final",
        });

        const recoveryRequest = await gateway.waitForRequest("chat.history", {
          after: historyCount,
        });
        expect(recoveryRequest.params).toMatchObject({ sessionKey, limit: 80 });
        const visibleFinal = page.locator(".chat-thread-inner .chat-text", { hasText: finalText });
        await visibleFinal.waitFor({ timeout: 10_000 });
        await expect.poll(() => visibleFinal.count()).toBe(1);
        await expect
          .poll(async () => (await gateway.getRequests("chat.history")).length)
          .toBe(historyCount + 1);
      },
    );
  });
});
