import { expect, type Page } from "playwright/test";
import { it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { requireRecord } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

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

function installRecoveryGateway(page: Page, content: string) {
  return installMockGateway(page, {
    sessionKey,
    sessions: [sessionInfo],
    models,
    historyMessages: messages,
    methodResponses: {
      "chat.startup": history,
      "chat.history": history,
      "chat.message.get": {
        ok: true,
        message: { role: "user", content, __openclaw: { id: "pending:saved-input" } },
      },
    },
  });
}

suite.define(() => {
  it("never sends saved rows automatically; Discard survives reload and Send submits the full prompt once", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installRecoveryGateway(page, "The complete saved prompt");
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
      await expect(page.locator("[data-chat-queue-global-state]")).toHaveCount(0);
      await expect(page.locator('[data-chat-recovery-input="cancelled-input"]')).toContainText(
        "Cancelled",
      );
      await expect(page.locator(".sidebar-region--open")).toHaveCount(0);
      await expect(page.locator(".chat-thread")).not.toContainText("Saved preview");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
      const centers = await rows.evaluateAll((elements) =>
        elements.map((row) =>
          [".chat-queue__badge", ".chat-queue__actions", ".chat-queue__leading"].map((selector) => {
            const box = row.querySelector(selector)!.getBoundingClientRect();
            return box.y + box.height / 2;
          }),
        ),
      );
      for (const center of centers) {
        expect(Math.max(...center) - Math.min(...center)).toBeLessThan(1);
      }
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
      const savedRow = page.locator('[data-chat-recovery-input="saved-input"]');
      await savedRow.locator("summary").click();
      await expect(savedRow.locator(".chat-queue__recovery-detail")).toContainText(
        "The complete saved prompt",
      );
      await expect(savedRow.locator(".chat-copy-btn")).toBeVisible();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await savedRow.locator("summary").click();
      await expect(savedRow).not.toHaveAttribute("open");
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
  it("preserves offline reorder and FIFO delivery when saved attempts share the tray", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installRecoveryGateway(page, "Recovered third prompt");
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const savedRow = page.locator('[data-chat-recovery-input="saved-input"]');
      await expect(savedRow).toBeVisible();
      await gateway.setOnline(false);
      await gateway.closeLatest();
      await expect(savedRow.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
      await expect(savedRow).toBeVisible();
      const composer = page.locator(".agent-chat__composer-combobox > textarea:visible");
      await composer.fill("First ordinary prompt");
      await composer.press("Enter");
      await expect(page.locator("[data-chat-queue-item]")).toHaveCount(1);
      await composer.fill("Second ordinary prompt");
      await composer.press("Enter");
      await expect(page.locator("[data-chat-queue-item]")).toHaveCount(2);
      await page
        .locator('[data-chat-recovery-input="cancelled-input"]')
        .getByRole("button", { name: "Discard saved attempt" })
        .click();
      await expect(page.locator("[data-chat-queue-item]")).toHaveCount(2);
      await page
        .locator("[data-chat-queue-item]", { hasText: "Second ordinary prompt" })
        .locator(".chat-queue__grip")
        .focus();
      await page.keyboard.press("ArrowUp");
      await expect(page.locator("[data-chat-queue-item]").first()).toContainText(
        "Second ordinary prompt",
      );
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await gateway.deferNext("chat.send");
      await gateway.setOnline(true);
      const first = requireRecord((await gateway.waitForRequest("chat.send")).params);
      expect(first.message).toBe("Second ordinary prompt");
      await composer.fill("Unrelated draft stays here");
      await expect(savedRow.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await savedRow.getByRole("button", { name: "Send", exact: true }).click();
      await expect(savedRow).toHaveCount(0);
      await expect(composer).toHaveValue("Unrelated draft stays here");
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      await gateway.resolveDeferred("chat.send", {
        runId: first.idempotencyKey,
        status: "ok",
        messageSeq: 1,
      });
      const second = requireRecord(
        (await gateway.waitForRequest("chat.send", { after: 1 })).params,
      );
      expect(second.message).toBe("First ordinary prompt");
      await gateway.emitChatFinal({
        runId: String(second.idempotencyKey),
        text: "First prompt complete.",
      });
      const third = requireRecord((await gateway.waitForRequest("chat.send", { after: 2 })).params);
      expect(third.message).toBe("Recovered third prompt");
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
    });
  });
});
