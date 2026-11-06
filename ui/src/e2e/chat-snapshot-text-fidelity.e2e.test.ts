import path from "node:path";
import { expect, it } from "vitest";
import { projectChatDisplayMessages } from "../../../src/gateway/chat-display-projection.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Cached transcript text fidelity" });
const markdown = Array.from(
  { length: 24 },
  (_, index) => `- **Verification ${index + 1}** ${"Synthetic evidence. ".repeat(30)}`,
).join("\n\n");
const message = {
  role: "assistant",
  content: markdown,
  __openclaw: { id: "long-answer", seq: 1 },
};

suite.define(() => {
  it("keeps the complete displayed Markdown while reloading offline and reconnecting", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:chat:long-answer";
      const row = createControlUiSessionRow(sessionKey, "Synthetic long answer", 1, {
        lifecycleRevision: "revision-1",
      });
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [row],
        authMethod: "trusted-proxy",
        authMode: "trusted-proxy",
        historyMessages: projectChatDisplayMessages([
          message,
          {
            role: "user",
            content: "Unrelated synthetic follow-up",
            __openclaw: { id: "follow-up", seq: 2 },
          },
        ]),
        deferredMethods: ["connect"],
        methodResponses: { "chat.message.get": { ok: true, message } },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("connect");
      await gateway.resolveDeferred("connect");
      const body = page.locator(".chat-group.assistant .chat-text");
      await body.getByText("Verification 24", { exact: true }).waitFor();
      const liveText = await body.textContent();
      await page.evaluate(async () => {
        const pane = document.querySelector(".chat-pane-cache__pane--active");
        await Reflect.get(pane!, "sessionSnapshotStore").flush();
      });
      await page.reload();
      await gateway.waitForRequest("connect");
      await body.waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        await page.screenshot({ path: path.join(suite.artifactDir, "cached.png") });
      }
      // Connect is still held: every character must come from the disk snapshot.
      expect(await body.textContent()).toBe(liveText);
      expect(await body.textContent()).not.toContain("...(truncated)...");
      const cachedHeight = await body.evaluate((element) => element.getBoundingClientRect().height);
      const followUp = page.locator('.chat-bubble[data-entry-id="follow-up"]');
      await expect.poll(() => followUp.count()).toBe(1);
      await page.locator(".agent-chat__composer-combobox textarea").focus();
      await page.keyboard.press("ControlOrMeta+f");
      const search = page.getByRole("textbox", { name: "Search messages", exact: true });
      await search.fill("Verification 24");
      await expect.poll(() => followUp.count()).toBe(0);
      expect(await body.textContent()).toBe(liveText);
      await search.press("Escape");
      await expect.poll(() => search.count()).toBe(0);
      await expect.poll(() => followUp.count()).toBe(1);
      await gateway.resolveDeferred("connect");
      await gateway.waitForRequest("chat.message.get");
      expect(await body.textContent()).toBe(liveText);
      expect(
        Math.abs(
          (await body.evaluate((element) => element.getBoundingClientRect().height)) - cachedHeight,
        ),
      ).toBeLessThanOrEqual(0.5);
    });
  });
});
