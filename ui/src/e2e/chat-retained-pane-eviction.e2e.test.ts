import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Retained chat pane eviction" });

suite.define(() => {
  it("keeps a surviving pane warm when an older conversation is evicted", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      // Eviction changes lexical order from [A, B, C] to [B, D, C].
      const keys = [
        "agent:main:render-actions",
        "agent:main:render-empty",
        "agent:main:render-pending",
        "agent:main:render-eviction",
      ] as const;
      const messageId = "retained-full-reply";
      const fullReply = "The recovered reply stays loaded while other conversations are opened.";
      const gateway = await installMockGateway(page, {
        sessionKey: keys[0],
        sessions: keys.map((key, index) => ({
          key,
          kind: "direct",
          label: `Conversation ${index + 1}`,
          updatedAt: 4 - index,
        })),
        sessionTranscripts: Object.fromEntries(
          keys.map((key, index) => [
            key,
            {
              messages: [
                {
                  role: "assistant",
                  timestamp: 1,
                  content:
                    index === 1
                      ? "Reply preview.\n...(truncated)..."
                      : `Conversation ${index + 1} reply.`,
                  __openclaw: {
                    id: index === 1 ? messageId : `reply-${index}`,
                    seq: 1,
                    ...(index === 1 ? { truncated: true, reason: "display-cap" } : {}),
                  },
                },
              ],
            },
          ]),
        ),
        methodResponses: {
          "chat.message.get": { ok: true, message: { role: "assistant", content: fullReply } },
        },
      });
      const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, keys[0]));
      await activePane.getByText("Conversation 1 reply.", { exact: true }).waitFor();
      const select = async (key: string) => {
        await page.locator(`.sidebar-recent-session[data-session-key="${key}"] a`).click();
        await expect
          .poll(() => activePane.evaluate((pane) => pane.getAttribute("data-mcp-app-owner-key")))
          .toContain(key);
      };

      await select(keys[1]);
      await activePane.getByText(fullReply, { exact: true }).waitFor();
      expect(await gateway.getRequests("chat.startup", { sessionKey: keys[1] })).toHaveLength(1);
      expect(await gateway.getRequests("chat.message.get", { messageId })).toHaveLength(1);
      await select(keys[2]);
      await activePane.getByText("Conversation 3 reply.", { exact: true }).waitFor();
      await select(keys[3]);
      await activePane.getByText("Conversation 4 reply.", { exact: true }).waitFor();

      expect(await page.locator("openclaw-chat-pane").count()).toBe(3);
      expect(
        await page.locator(`openclaw-chat-pane[data-mcp-app-owner-key*="${keys[0]}"]`).count(),
      ).toBe(0);
      await select(keys[1]);
      await activePane.getByText(fullReply, { exact: true }).waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const directory = createControlUiE2eArtifactDir("retained-pane-eviction");
        await writeFile(
          path.join(directory, "survivor.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [activePane]),
        );
      }
      expect(await gateway.getRequests("chat.startup", { sessionKey: keys[1] })).toHaveLength(1);
      expect(await gateway.getRequests("chat.message.get", { messageId })).toHaveLength(1);
    });
  });
});
