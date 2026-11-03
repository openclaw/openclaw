import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "agent-written session openings" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("shows the creating agent's name and avatar on a session's opening message", async () => {
    await suite.withPage(
      { viewport: { width: 1180, height: 800 }, locale: "en-US", colorScheme: "light" },
      async ({ page }) => {
        await installMockGateway(page, {
          assistantName: "Roboclaw",
          presenceUsers: [
            {
              self: true,
              id: "profile-ada",
              identity: { type: "profile", id: "profile-ada" },
              name: "Ada Lovelace",
            },
          ],
          historyMessages: [
            chatMessage("user", "You own this pull request end to end in this session.", {
              provenance: {
                kind: "inter_session",
                sourceSessionKey: "agent:main:dashboard:parent",
                sourceTool: "sessions_create",
              },
              __openclaw: { senderId: "agent:main" },
            }),
            chatMessage("assistant", "The fresh worktree is ready."),
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const opening = page
          .locator(".chat-group")
          .filter({ hasText: "You own this pull request end to end" });
        await opening.waitFor();
        await expect
          .poll(() => opening.locator(".chat-sender-name").textContent())
          .toBe("Roboclaw");
        expect(await opening.locator(".chat-avatar.assistant").count()).toBe(1);
        expect(await opening.getByText("agent:main", { exact: true }).count()).toBe(0);
        if (captureUiProof) {
          await page.screenshot({ path: path.join(suite.artifactDir, "agent-opening-sender.png") });
        }
      },
    );
  });
});
