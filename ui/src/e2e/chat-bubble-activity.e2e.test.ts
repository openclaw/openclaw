import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  createControlUiMockBootstrapConfig,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Bubble identity and activity" });
const sessionKey = "agent:main:dashboard:bubble-activity";

async function enableBubbles(page: Page) {
  await page.addInitScript(
    ({ key, session }) => {
      localStorage.setItem(
        key,
        JSON.stringify({ chatBubbleSessionKeys: [session], theme: "dark" }),
      );
    },
    { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), session: sessionKey },
  );
  await page.route("**/control-ui-config.json", (route) =>
    route.fulfill({
      json: { ...createControlUiMockBootstrapConfig(), chatBubblesEnabled: true },
    }),
  );
}

function userMessage(content: string, timestamp: number) {
  return {
    role: "user",
    content,
    timestamp,
    __openclaw: {
      id: `layout-user-${timestamp}`,
      runId: "layout-request",
      senderId: "profile-riley",
      senderIdentity: { type: "profile", id: "profile-riley" },
      senderName: "Riley",
    },
  };
}
function assistantMessage(content: string, timestamp: number, phase = "final_answer") {
  return { role: "assistant", content, timestamp, phase, runId: "layout" };
}

suite.define(() => {
  it.each([
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ])("keeps identity on the first message and work compact at $width px", async (viewport) => {
    await suite.withPage({ viewport, reducedMotion: "reduce" }, async ({ page }) => {
      await enableBubbles(page);
      await installMockGateway(page, {
        sessionKey,
        presenceUsers: [
          {
            self: true,
            id: "profile-riley",
            identity: { type: "profile", id: "profile-riley" },
            name: "Riley",
          },
        ],
        historyMessages: [
          userMessage("Please check the layout.", 1),
          userMessage("Keep the avatar where it is.", 2),
          assistantMessage("I’ll check the spacing first.", 3, "commentary"),
          {
            role: "toolResult",
            toolName: "read",
            toolCallId: "read-layout",
            content: "Layout inspection complete.",
            runId: "layout",
            timestamp: 4,
          },
          assistantMessage("The layout now has room to breathe.", 5),
          assistantMessage("The second message keeps its rounded corners.", 6),
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const chat = page.locator("section.chat");
      await browserExpect(chat).toHaveClass(/chat--bubbles/);
      const last = chat.getByText("The second message keeps its rounded corners.", { exact: true });
      await browserExpect(last).toBeVisible();
      await browserExpect(
        chat.getByText("I’ll check the spacing first.", { exact: true }),
      ).toBeVisible();
      const geometry = await chat.locator(".chat-group").evaluateAll((groups) =>
        groups
          .filter(
            (group) => group.classList.contains("user") || group.classList.contains("assistant"),
          )
          .map((group) => ({
            role: group.classList.contains("user") ? "user" : "assistant",
            corners: Array.from(
              group.querySelectorAll(".chat-bubble:not(.chat-bubble--tool-shell)"),
            ).map((bubble) => {
              const style = getComputedStyle(bubble);
              return [
                style.borderTopLeftRadius,
                style.borderTopRightRadius,
                style.borderBottomRightRadius,
                style.borderBottomLeftRadius,
              ].join(" ");
            }),
          })),
      );
      expect(geometry.find((group) => group.role === "user")?.corners).toEqual([
        "18px 4px 18px 18px",
        "18px 18px 18px 18px",
      ]);
      expect(geometry.find((group) => group.role === "assistant")?.corners).toEqual([
        "4px 18px 18px 18px",
        "18px 18px 18px 18px",
        "18px 18px 18px 18px",
      ]);
      expect(await chat.locator(".chat-bubble-dots").count()).toBe(0);
      expect(await chat.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const activity = chat.locator(".chat-activity-group > button").first();
      await browserExpect(activity).toHaveText(/operation|Read|Worked|Raw details/);
      expect((await activity.boundingBox())!.height).toBeLessThanOrEqual(36);
      await activity.click();
      await browserExpect(chat.locator(".chat-tool-msg-summary").first()).toBeVisible();
    });
  });

  it("renders a first fragment before any tool or final event and preserves it across tools", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await enableBubbles(page);
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessionInfo: { reasoningLevel: "stream" },
        sessions: [{ key: sessionKey, reasoningLevel: "stream" }],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const chat = page.locator("section.chat");
      const preamble = chat.locator(".chat-text").getByText("I’ll", { exact: true });
      const workingDots = chat.locator(".chat-bubble-dots--working");
      await page.locator(".agent-chat__composer-combobox textarea").fill("Check the live layout.");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const request = await gateway.waitForRequest("chat.send");
      const runId = String(asOptionalRecord(request.params)?.idempotencyKey);
      const emit = (event: string, seq: number, payload: Record<string, unknown>) =>
        gateway.emitGatewayEvent(event, { sessionKey, runId, seq, ...payload });
      const tool = (seq: number, data: Record<string, unknown>) =>
        emit("session.tool", seq, { agentId: "main", ts: Date.now(), stream: "tool", data });
      await emit("agent", 1, {
        agentId: "main",
        ts: Date.now(),
        stream: "thinking",
        data: { itemId: "layout-thinking", text: "Inspecting the layout" },
      });
      await browserExpect(chat.locator(".chat-thinking")).toHaveCount(1);
      await page.evaluate(() => {
        performance.mark("bubble-first-delta");
        const observer = new MutationObserver(() => {
          if (
            document
              .querySelector(".chat-bubble.streaming .chat-text")
              ?.textContent?.includes("I’ll")
          ) {
            performance.measure("bubble-delta-to-visible", { start: "bubble-first-delta" });
            observer.disconnect();
          }
        });
        observer.observe(document.querySelector("section.chat")!, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      });
      await emit("chat", 2, {
        state: "delta",
        deltaText: "I’ll",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Inspecting the layout" },
            { type: "text", text: "I’ll" },
          ],
        },
      });
      await browserExpect(chat.locator(".chat-bubble.streaming .chat-text")).toHaveText("I’ll");
      const latency = await page.evaluate(
        () => performance.getEntriesByName("bubble-delta-to-visible")[0]?.duration,
      );
      expect(latency).toBeTypeOf("number");
      expect(latency).toBeLessThan(1000);
      await browserExpect(workingDots).toHaveCount(0);
      // Publish the keyed preamble only after proving first-fragment visibility.
      await emit("chat", 3, {
        state: "delta",
        deltaText: "",
        replace: true,
        message: { role: "assistant", content: [] },
      });
      await emit("agent", 4, {
        ts: Date.now(),
        stream: "item",
        data: { kind: "preamble", itemId: "layout-preamble", phase: "end", progressText: "I’ll" },
      });
      await tool(5, {
        phase: "start",
        toolCallId: "live-read",
        name: "read",
        args: { path: "layout.css" },
      });
      await browserExpect(workingDots).toHaveCount(1);
      const working = chat.locator(".chat-bubble-activity--working");
      await working.locator("summary").click();
      await browserExpect(working).toHaveAttribute("open", "");
      await browserExpect(preamble).toBeVisible();
      await tool(6, {
        phase: "result",
        toolCallId: "live-read",
        name: "read",
        result: "The layout is ready.",
      });
      await browserExpect(workingDots).toHaveCount(1);
      await browserExpect(working).toHaveAttribute("open", "");
      await gateway.emitChatFinal({ sessionKey, runId, text: "The layout is ready." });
      await browserExpect(
        chat.getByText("The layout is ready.", { exact: true }).last(),
      ).toBeVisible();
      await browserExpect(preamble).toBeVisible();
      await browserExpect(workingDots).toHaveCount(0);
    });
  });
});
