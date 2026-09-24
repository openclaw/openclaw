import { expect } from "playwright/test";
import { it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "saved attempts in the existing queue",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:input-recovery";
const sessionId = "input-recovery-session";
const models = [{ id: "gpt-4.1", name: "Demo model", provider: "openai" }];
const sessionInfo = {
  key: sessionKey,
  sessionId,
  kind: "direct",
  displayName: "Recovery proof",
  model: "gpt-4.1",
  modelProvider: "openai",
};
const messages = [
  {
    role: "assistant",
    content: "The current answer stays in the conversation.",
    timestamp: 500,
    __openclaw: { id: "answer", seq: 1 },
  },
];
const input = {
  id: "saved-input",
  state: "interrupted",
  acceptedAt: 100,
  message: {
    role: "user",
    content: "Saved preview",
    __openclaw: { id: "pending:saved-input", truncated: true },
  },
};
const cancelled = {
  ...input,
  id: "cancelled-input",
  state: "cancelled",
  message: { role: "user", content: "A cancelled prompt" },
};
const history = {
  sessionId,
  sessionInfo,
  messages,
  metadata: { models },
  pendingInputs: { items: [input, cancelled], total: 2 },
};

suite.define(() => {
  it("never sends saved rows automatically; Discard survives reload and Send submits the full prompt once", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [sessionInfo],
        models,
        historyMessages: messages,
        methodResponses: {
          "chat.startup": history,
          "chat.history": history,
          "chat.message.get": {
            ok: true,
            message: {
              role: "user",
              content: "The complete saved prompt",
              __openclaw: { id: "pending:saved-input" },
            },
          },
        },
      });
      await page.addInitScript(
        ({ key, selectedKey }) => {
          if (!localStorage.getItem(key)) {
            localStorage.setItem(
              key,
              JSON.stringify({
                sidebarSessionLayouts: {
                  [selectedKey]: { columns: [], open: false, expanded: false },
                },
              }),
            );
          }
        },
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), selectedKey: sessionKey },
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const rows = page.locator("[data-chat-recovery-input]");
      await expect(rows).toHaveCount(2);
      await expect(page.locator(".chat-queue")).toHaveCount(1);
      await expect(page.locator(".sidebar-region--open")).toHaveCount(0);
      await expect(page.locator(".chat-thread")).not.toContainText("Saved preview");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
      await page
        .locator('[data-chat-recovery-input="cancelled-input"]')
        .getByRole("button", { name: "Discard saved attempt" })
        .click();
      await expect(rows).toHaveCount(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
      await page.reload();
      await expect(page.locator('[data-chat-recovery-input="saved-input"]')).toBeVisible();
      await expect(page.locator('[data-chat-recovery-input="cancelled-input"]')).toHaveCount(0);
      const draft = page.locator(".agent-chat__composer-combobox > textarea");
      await draft.fill("Keep my current draft");
      await page
        .locator('[data-chat-recovery-input="saved-input"]')
        .getByRole("button", { name: "Send", exact: true })
        .click();
      const sent = await gateway.waitForRequest("chat.send");
      expect(sent.params).toMatchObject({ message: "The complete saved prompt" });
      await expect(rows).toHaveCount(0);
      await expect(draft).toHaveValue("Keep my current draft");
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    });
  });
});
