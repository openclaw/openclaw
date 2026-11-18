import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Current-source message rows" });
const sessionKey = "agent:main:main";
const runId = "template-setup";
const greeting =
  "Hi Patrick — I’m your Travel Copilot. I can help compare options and turn trip ideas into a practical plan.";
const status =
  "The Expedia plugin is installed but disabled. You can ask me to enable it when you’re ready.";
const card = {
  type: "clawhub",
  kind: "plugin",
  id: "ch_travel_themes",
  pluginId: "travel-themes",
  name: "Travel Themes",
  description: "Plan trips around themes, seasons and events.",
  official: false,
  installed: false,
};

let at = 1_800_000_000_000;
const call = (id: string, name: string, args: Record<string, unknown>) => ({
  role: "assistant",
  runId,
  content: [{ type: "toolCall", id, name, arguments: args }],
  timestamp: ++at,
});
const result = (id: string, name: string, text: string, details: Record<string, unknown> = {}) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  runId,
  isError: false,
  content: [{ type: "text", text }],
  details,
  timestamp: ++at,
});
// The message tool's result for a reply it wrote into this session's transcript.
const currentRunReply = {
  status: "ok",
  deliveryStatus: "sent",
  channel: "webchat",
  target: "current-run",
  sourceReplyTranscriptOwner: true,
  sourceReplySink: "internal-ui",
  messageDelivery: { status: "settled", partialDelivery: false, createdThreadIds: [] },
};
const mirror = (toolCallId: string, content: unknown[]) => ({
  role: "assistant",
  runId,
  content,
  openclawDeliveryMirror: { kind: "message-tool-source-reply", final: false, toolCallId },
  timestamp: ++at,
});
const sent = "Sent visible reply to the current source conversation via internal-ui.";

suite.define(() => {
  it("shows Template setup replies without message tool rows", async () => {
    const history = prepareChatHistoryFixture([
      call("greet", "message", { action: "send", final: false, message: greeting }),
      result("greet", "message", sent, currentRunReply),
      mirror("greet", [{ type: "text", text: greeting }]),
      {
        role: "assistant",
        runId,
        content: [
          { type: "toolCall", id: "manifest", name: "read", arguments: { path: "CLAW.md" } },
          { type: "toolCall", id: "jobs", name: "automations", arguments: { action: "list" } },
          { type: "toolCall", id: "installed", name: "plugins", arguments: { action: "list" } },
          {
            type: "toolCall",
            id: "status",
            name: "message",
            arguments: { action: "send", final: false, message: status },
          },
        ],
        timestamp: ++at,
      },
      result("manifest", "read", "# Travel Copilot"),
      result("jobs", "automations", "[]"),
      result("installed", "plugins", "expedia: installed, disabled"),
      result("status", "message", sent, currentRunReply),
      mirror("status", [{ type: "text", text: status }]),
      call("card", "message", {
        action: "send",
        final: false,
        clawhub: { plugin: "travel-themes" },
      }),
      result("card", "message", sent, currentRunReply),
      mirror("card", [card]),
      {
        role: "assistant",
        runId,
        content: [
          {
            type: "text",
            text: "This edition researches, plans and drafts; booking stays with you. Where would you like to go first?",
          },
        ],
        timestamp: ++at,
      },
    ]);
    await suite.withPage(
      { colorScheme: "dark", viewport: { width: 1200, height: 900 }, reducedMotion: "reduce" },
      async ({ page }) => {
        await page.addInitScript((key) => {
          localStorage.setItem(key, JSON.stringify({ theme: "dark" }));
        }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
        await installMockGateway(page, {
          sessionKey,
          communityInvite: false,
          historyMessages: history.messages,
          featureMethods: ["plugins.catalog.get", "plugins.catalog.install"],
          methodResponses: {
            "chat.history": history,
            "plugins.catalog.get": {
              plugin: {
                id: card.id,
                catalog: { name: card.name, official: false, categories: [] },
                local: { installed: false, action: "install" },
              },
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const thread = page.locator(".chat-thread");
        await browserExpect(thread.getByText(greeting)).toBeVisible();
        await browserExpect(thread.getByText(status)).toBeVisible();
        await browserExpect(
          thread.getByRole("button", { name: "Install", exact: true }),
        ).toBeVisible();
        await browserExpect(thread.getByText(/Where would you like to go first/)).toBeVisible();
        await browserExpect(thread.getByRole("button", { name: /Read files/ })).toBeVisible();
        if (process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1") {
          const frame = await takeControlUiScreenshotFrame(page, thread, [thread], {
            animations: "disabled",
            elements: [thread],
          });
          writeFileSync(
            path.join(suite.artifactDir, "template-welcome.png"),
            frame.elements[0]!.png,
          );
        }

        // The sent text and card are already in the thread, so their sends get no row of their own.
        expect(await thread.locator(".chat-tool-row").allTextContents()).not.toContainEqual(
          expect.stringContaining("Message"),
        );
        expect(
          await thread.locator(".chat-activity-group__summary").allTextContents(),
        ).not.toContainEqual(expect.stringMatching(/message/i));
      },
    );
  });
});
