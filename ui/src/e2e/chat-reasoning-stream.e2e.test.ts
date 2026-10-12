import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI reasoning tool turns" });

// Adapted from leapdragon's tool-turn replay: live reasoning, tool events,
// delayed session.message publication, then the text-only chat final.
suite.define(() => {
  it.each(["on", "stream"])(
    "keeps each tool step's reasoning with /reasoning %s until history takes over",
    async (reasoningLevel) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const sessionKey = "agent:main:dashboard:reasoning-tool-turn";
          const sessionId = "reasoning-tool-turn-session";
          const prompt = "Read both evidence files and compare them.";
          const thoughts = [
            "Read the first evidence file before comparing.",
            "Read the second evidence file to complete the comparison.",
            "Both files agree, so the comparison is complete.",
          ];
          const answer = "Both evidence files say the answer is 42.";
          const sessionRow = {
            key: sessionKey,
            kind: "direct",
            sessionId,
            reasoningLevel,
            thinkingLevel: "low",
            updatedAt: 1_000,
          };
          const gateway = await installMockGateway(page, {
            sessionKey,
            sessionInfo: { reasoningLevel, thinkingLevel: "low" },
            sessions: [sessionRow],
            historyMessages: [],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
          await pane.locator(".agent-chat__composer-combobox textarea").fill(prompt);
          await page.getByRole("button", { name: "Send message" }).click();
          const send = await gateway.waitForRequest("chat.send");
          const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
          let seq = 0;
          const agent = async (stream: string, data: Record<string, unknown>, ts: number) => {
            await gateway.emitGatewayEvent("agent", {
              runId,
              seq: ++seq,
              stream,
              ts,
              sessionKey,
              data,
            });
          };
          const thinking = (index: number) =>
            agent(
              "thinking",
              { itemId: `thought-${index}`, text: thoughts[index] },
              1_100 + index * 100,
            );
          const reasoning = (index: number) =>
            pane.locator(".chat-thinking", { hasText: thoughts[index] });
          const persisted: unknown[] = [
            {
              role: "user",
              content: prompt,
              timestamp: 1_000,
              __openclaw: { id: "durable-user", seq: 1, idempotencyKey: `${runId}:user` },
            },
          ];
          const persist = async (index: number) => {
            const isFinal = index === 2;
            const messageId = `durable-${index}`;
            const messageSeq = index + 2;
            const message = {
              role: "assistant",
              content: [
                { type: "thinking", thinking: thoughts[index] },
                isFinal
                  ? { type: "text", text: answer }
                  : {
                      type: "toolCall",
                      id: `read-${index}`,
                      name: "read",
                      arguments: { path: `evidence-${index}.txt` },
                    },
              ],
              stopReason: isFinal ? "stop" : "toolUse",
              // Compatible providers can stamp the request before its first token.
              timestamp: 1_050 + index * 100,
              __openclaw: { id: messageId, seq: messageSeq, runId },
            };
            await agent(
              "thinking",
              {
                phase: "persisted",
                itemId: `thought-${index}`,
                messageId,
                messageRunId: runId,
              },
              1_400 + index,
            );
            persisted.push(message);
            const history = {
              messages: [...persisted],
              sessionId,
              sessionInfo: { ...sessionRow, hasActiveRun: true },
            };
            await gateway.setHistoryMessages(history.messages);
            await gateway.setMethodResponse("chat.startup", history);
            await gateway.setMethodResponse("chat.history", history);
            await gateway.emitGatewayEvent("session.message", {
              sessionKey,
              hasActiveRun: true,
              session: { ...sessionRow, hasActiveRun: true, status: "running" },
              messageId,
              messageSeq,
              message,
            });
          };

          await agent("lifecycle", { phase: "start" }, 1_050);
          for (const index of [0, 1]) {
            await thinking(index);
            await reasoning(index).waitFor();
            // The earlier occurrence must survive before its durable row arrives.
            expect(await reasoning(0).count()).toBe(1);
            await agent(
              "tool",
              {
                toolCallId: `read-${index}`,
                name: "read",
                phase: "start",
                args: { path: `evidence-${index}.txt` },
              },
              1_150 + index * 100,
            );
            await agent(
              "tool",
              {
                toolCallId: `read-${index}`,
                name: "read",
                phase: "result",
                result: { content: [{ type: "text", text: "42" }] },
              },
              1_160 + index * 100,
            );
          }
          await thinking(2);
          await reasoning(2).waitFor();
          expect(await pane.locator(".chat-thinking").count()).toBe(3);
          const expectStepOrder = () =>
            expect
              .poll(async () => {
                const steps = await pane
                  .locator(".chat-thinking, .chat-tool-msg-summary")
                  .allTextContents();
                return steps.map((text) => {
                  const thought = thoughts.findIndex((candidate) => text.includes(candidate));
                  if (thought >= 0) {
                    return `thought-${thought}`;
                  }
                  return text.includes("evidence-0.txt")
                    ? "read-0"
                    : text.includes("evidence-1.txt")
                      ? "read-1"
                      : text;
                });
              })
              .toEqual(["thought-0", "read-0", "thought-1", "read-1", "thought-2"]);
          await expectStepOrder();

          const menuTrigger = pane.locator(".chat-header-session-menu__trigger");
          const menu = pane.locator("wa-dropdown.chat-header-session-menu");
          for (const visible of [false, true]) {
            await menuTrigger.click();
            await menu.getByRole("menuitem", { name: "View", exact: true }).hover();
            const toggle = menu.getByRole("menuitemcheckbox", { name: "Reasoning" });
            await toggle.click();
            await expect.poll(() => toggle.getAttribute("aria-checked")).toBe(String(visible));
            await menuTrigger.click();
            await expect.poll(() => pane.locator(".chat-thinking").count()).toBe(visible ? 3 : 0);
          }

          for (const index of [0, 1, 2]) {
            await persist(index);
            await expect.poll(() => reasoning(index).count()).toBe(1);
            expect(await pane.locator(".chat-thinking").count()).toBe(3);
            await expectStepOrder();
          }
          await gateway.emitChatFinal({ runId, sessionKey, text: answer });
          const finalAnswer = pane.locator(".chat-text").getByText(answer, { exact: true });
          await finalAnswer.waitFor();
          await expect
            .poll(() => page.getByRole("button", { name: "Stop generating" }).count())
            .toBe(0);
          const worked = pane.locator(".chat-work-group > .chat-activity-group__summary");
          await worked.waitFor();
          await worked.click();
          await expect.poll(() => worked.getAttribute("aria-expanded")).toBe("true");
          const rawDetails = pane.locator(".chat-activity-group__summary", {
            hasText: "Raw details",
          });
          await rawDetails.click();
          await expect.poll(() => rawDetails.getAttribute("aria-expanded")).toBe("true");
          await expect
            .poll(() => pane.locator(".chat-thinking").count())
            .toBe(reasoningLevel === "on" ? 3 : 0);
          expect(await finalAnswer.count()).toBe(1);
        },
      );
    },
  );
});
