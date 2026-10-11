import { writeFileSync } from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  createControlUiMockBootstrapConfig,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Bubble identity and activity" });
const sessionKey = "agent:main:dashboard:bubble-activity";

suite.define(() => {
  it.each([
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ])("keeps identity on the first message and work compact at $width px", async (viewport) => {
    await suite.withPage({ viewport, reducedMotion: "reduce" }, async ({ page }) => {
      await page.addInitScript(
        ({ key, session }) => {
          localStorage.setItem(
            key,
            JSON.stringify({ chatBubbleSessionKeys: [session], theme: "dark" }),
          );
        },
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), session: sessionKey },
      );
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
          {
            role: "user",
            content: "Please check the layout.",
            timestamp: 1,
            __openclaw: {
              id: "layout-user-1",
              runId: "layout-request",
              senderId: "profile-riley",
              senderIdentity: { type: "profile", id: "profile-riley" },
              senderName: "Riley",
            },
          },
          {
            role: "user",
            content: "Keep the avatar where it is.",
            timestamp: 2,
            __openclaw: {
              id: "layout-user-2",
              runId: "layout-request",
              senderId: "profile-riley",
              senderIdentity: { type: "profile", id: "profile-riley" },
              senderName: "Riley",
            },
          },
          {
            role: "assistant",
            content: "I’ll check the spacing first.",
            phase: "commentary",
            runId: "layout",
            timestamp: 3,
          },
          {
            role: "toolResult",
            toolName: "read",
            toolCallId: "read-layout",
            content: "Layout inspection complete.",
            runId: "layout",
            timestamp: 4,
          },
          {
            role: "assistant",
            content: "The layout now has room to breathe.",
            phase: "final_answer",
            runId: "layout",
            timestamp: 5,
          },
          {
            role: "assistant",
            content: "The second message keeps its rounded corners.",
            phase: "final_answer",
            runId: "layout",
            timestamp: 6,
          },
        ],
      });
      await page.route("**/control-ui-config.json", (route) =>
        route.fulfill({
          json: { ...createControlUiMockBootstrapConfig(), chatBubblesEnabled: true },
        }),
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const chat = page.locator("section.chat");
      await browserExpect(chat).toHaveClass(/chat--bubbles/);
      const last = chat.getByText("The second message keeps its rounded corners.", { exact: true });
      await browserExpect(last).toBeVisible();
      const frame = await takeControlUiScreenshotFrame(page, chat, [last], {
        animations: "disabled",
        elements: [chat],
      });
      writeFileSync(
        path.join(suite.artifactDir, "conversation-" + viewport.width + ".png"),
        frame.elements[0]!.png,
      );
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
              ];
            }),
          })),
      );
      expect(geometry.find((group) => group.role === "user")?.corners).toEqual([
        ["18px", "4px", "18px", "18px"],
        ["18px", "18px", "18px", "18px"],
      ]);
      expect(geometry.find((group) => group.role === "assistant")?.corners).toEqual([
        ["4px", "18px", "18px", "18px"],
        ["18px", "18px", "18px", "18px"],
        ["18px", "18px", "18px", "18px"],
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
      await page.addInitScript(
        ({ key, session }) => {
          localStorage.setItem(
            key,
            JSON.stringify({ chatBubbleSessionKeys: [session], theme: "dark" }),
          );
        },
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), session: sessionKey },
      );
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessionInfo: { reasoningLevel: "stream" },
        sessions: [{ key: sessionKey, reasoningLevel: "stream" }],
      });
      await page.route("**/control-ui-config.json", (route) =>
        route.fulfill({
          json: { ...createControlUiMockBootstrapConfig(), chatBubblesEnabled: true },
        }),
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const chat = page.locator("section.chat");
      await page.locator(".agent-chat__composer-combobox textarea").fill("Check the live layout.");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const request = await gateway.waitForRequest("chat.send");
      const runId = String(asOptionalRecord(request.params)?.idempotencyKey);
      await gateway.emitGatewayEvent("agent", {
        sessionKey,
        agentId: "main",
        runId,
        seq: 1,
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
            performance.mark("bubble-first-visible");
            performance.measure(
              "bubble-delta-to-visible",
              "bubble-first-delta",
              "bubble-first-visible",
            );
            observer.disconnect();
          }
        });
        observer.observe(document.querySelector("section.chat")!, {
          subtree: true,
          childList: true,
          characterData: true,
        });
      });
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        seq: 2,
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
      console.log(
        "Mock Gateway first-fragment to DOM visibility:",
        latency,
        "ms (not provider first-token latency)",
      );
      await browserExpect(chat.locator(".chat-bubble-dots--working")).toHaveCount(1);
      const working = chat.locator(".chat-bubble-activity--working");
      await working.locator("summary").click();
      await browserExpect(working).toHaveAttribute("open", "");
      // The producer retires the live text tail when its keyed preamble is published.
      // First-fragment visibility above deliberately precedes this boundary.
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        seq: 3,
        state: "delta",
        deltaText: "",
        replace: true,
        message: { role: "assistant", content: [] },
      });
      await gateway.emitGatewayEvent("agent", {
        sessionKey,
        runId,
        seq: 4,
        ts: Date.now(),
        stream: "item",
        data: { kind: "preamble", itemId: "layout-preamble", phase: "end", progressText: "I’ll" },
      });
      await gateway.emitGatewayEvent("session.tool", {
        sessionKey,
        agentId: "main",
        runId,
        seq: 5,
        ts: Date.now(),
        stream: "tool",
        data: {
          phase: "start",
          toolCallId: "live-read",
          name: "read",
          args: { path: "layout.css" },
        },
      });
      await browserExpect(
        chat.locator(".chat-text").getByText("I’ll", { exact: true }),
      ).toBeVisible();
      await gateway.emitGatewayEvent("session.tool", {
        sessionKey,
        agentId: "main",
        runId,
        seq: 6,
        ts: Date.now(),
        stream: "tool",
        data: {
          phase: "result",
          toolCallId: "live-read",
          name: "read",
          result: "The layout is ready.",
        },
      });
      await browserExpect(chat.locator(".chat-bubble-dots--working")).toHaveCount(1);
      await browserExpect(working).toHaveAttribute("open", "");
      await gateway.emitChatFinal({ sessionKey, runId, text: "The layout is ready." });
      await browserExpect(
        chat.getByText("The layout is ready.", { exact: true }).last(),
      ).toBeVisible();
      await browserExpect(
        chat.locator(".chat-text").getByText("I’ll", { exact: true }),
      ).toBeVisible();
      await browserExpect(chat.locator(".chat-bubble-dots--working")).toHaveCount(0);
    });
  });
});
