import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI approval flow",
  trackBrowserContexts: true,
});

const activeSessionKey = "agent:main:main";

function approval(id: string, command: string, createdAtMs: number, sessionKey = activeSessionKey) {
  return {
    id,
    createdAtMs,
    expiresAtMs: Date.now() + 60_000,
    request: { command, agentId: "main", sessionKey },
  };
}

const requireRecord = createRequireRecord("record", "expected-object-value");

function approvalInboxButton(page: Page) {
  return page.locator("openclaw-sidebar-attention .sidebar-issues-button");
}

function approvalInboxPanel(page: Page) {
  return page.locator("openclaw-sidebar-attention #sidebar-issues-panel");
}
const inlineApproval = (page: Page, id: string) =>
  page.locator(`.chat-inline-approval [data-approval-id="${id}"]`);
async function openChat(
  options: Parameters<typeof installMockGateway>[1] = {},
  { home = true } = {},
) {
  const context = await suite.newBrowserContext({
    viewport: { height: 800, width: 1200 },
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, options);
  const url = home
    ? controlUiSessionUrl(suite.server.baseUrl, activeSessionKey)
    : `${suite.server.baseUrl}chat`;
  await page.goto(url);
  await gateway.waitForRequest("sessions.list");
  const request = (...args: Parameters<typeof approval>) =>
    gateway.emitGatewayEvent("exec.approval.requested", approval(...args));
  return { page, gateway, request };
}

suite.define(() => {
  it("keeps a resolve failure scoped to its approval when a newer one arrives", async () => {
    const { page, gateway, request } = await openChat({ sessionKey: activeSessionKey });
    await gateway.deferNext("exec.approval.resolve");
    await request("approval-active", "echo active", 1_000);
    const activeCard = inlineApproval(page, "approval-active");
    await activeCard.getByText("echo active", { exact: true }).waitFor();
    const allow = activeCard.getByRole("button", { name: "Allow once" });
    await allow.focus();
    expect(await allow.evaluate((button) => button === document.activeElement)).toBe(true);
    await allow.click();

    await request("approval-newer", "echo newer", 2_000);
    await approvalInboxButton(page).waitFor();
    await gateway.rejectDeferred("exec.approval.resolve", {
      code: "UNAVAILABLE",
      message: "gateway unavailable",
    });

    await expect
      .poll(() => activeCard.locator(".exec-approval-error").textContent())
      .toBe("Approval failed: gateway unavailable");

    await approvalInboxButton(page).click();
    const newerRow = approvalInboxPanel(page).locator('[data-approval-id="approval-newer"]');
    await expect
      .poll(() => newerRow.locator(".sidebar-approval-row__command").textContent())
      .toContain("echo newer");
    await expect.poll(() => newerRow.locator('[role="alert"]').count()).toBe(0);
    await expect.poll(() => newerRow.getByRole("button", { name: /Deny/ }).isEnabled()).toBe(true);
  });

  it("keeps approvals passive until the Inbox opens the full queue", async () => {
    const { page, request } = await openChat({ sessionKey: activeSessionKey });
    await request("approval-inline", "echo inline", 1_000);

    await inlineApproval(page, "approval-inline").waitFor();
    expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);

    await request("approval-other", "echo other", 2_000, "agent:main:other");

    await approvalInboxButton(page).waitFor();
    expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
    expect(await page.getByText("echo other", { exact: true }).count()).toBe(0);

    await approvalInboxButton(page).click();
    const inboxPanel = approvalInboxPanel(page);
    await inboxPanel.locator('[data-approval-id="approval-inline"]').waitFor();
    await inboxPanel.locator('[data-approval-id="approval-other"]').waitFor();
    await expect.poll(() => inboxPanel.locator("[data-approval-id]").count()).toBe(2);
    await inboxPanel.getByRole("tab", { name: "Approvals 2" }).waitFor();
  });

  it("keeps no-auth inline and Inbox approvals readable while blocking decisions", async () => {
    const { page, request } = await openChat({
      omitConnectHelloAuth: true,
      sessionKey: activeSessionKey,
    });

    await request("approval-review-only", "echo review only", 1_000);

    const inlineCard = inlineApproval(page, "approval-review-only");
    await inlineCard.waitFor();
    await inlineCard.getByText("echo review only", { exact: true }).waitFor();
    const assertReviewOnly = async (card: ReturnType<Page["locator"]>, selector: string) => {
      const hint = "Review only. Sign in with approval access to record a decision.";
      await card.getByText(hint, { exact: true }).waitFor();
      expect(
        await card
          .locator(selector)
          .evaluateAll((items) => items.map((button) => (button as HTMLButtonElement).disabled)),
      ).toEqual([true, true, true]);
    };
    await assertReviewOnly(inlineCard, ".exec-approval-actions button");

    await approvalInboxButton(page).click();
    const inboxPanel = approvalInboxPanel(page);
    const inboxRow = inboxPanel.locator('[data-approval-id="approval-review-only"]');
    await expect
      .poll(() => inboxRow.locator(".sidebar-approval-row__command").textContent())
      .toContain("echo review only");
    await assertReviewOnly(inboxRow, ".sidebar-approval-row__actions button");
  });

  it("sends a typed approval command immediately while the active run waits", async () => {
    const { page, gateway } = await openChat({}, { home: false });

    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await composer.fill("run a command that needs approval");
    await page.getByRole("button", { name: "Send message" }).click();
    const firstSend = requireRecord((await gateway.waitForRequest("chat.send")).params);
    expect(firstSend.message).toBe("run a command that needs approval");
    await page.getByRole("button", { name: "Stop generating" }).waitFor();

    await composer.fill("/approve approval-123 allow-once");
    await page.getByRole("button", { name: "Send message" }).click();

    await expect
      .poll(async () => (await gateway.getRequests("chat.send")).length, { timeout: 10_000 })
      .toBe(2);
    const sends = await gateway.getRequests("chat.send");
    const approvalSend = requireRecord(sends[1]?.params);
    expect(approvalSend.message).toBe("/approve approval-123 allow-once");
    expect(approvalSend.deliver).toBe(false);
    expect(typeof approvalSend.idempotencyKey).toBe("string");
    expect(await page.locator(".chat-queue").count()).toBe(0);
    expect(await composer.inputValue()).toBe("");
    expect(await page.getByRole("button", { name: "Stop generating" }).count()).toBe(1);
  });
});
