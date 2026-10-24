import type { Page } from "playwright";
import { expect, it } from "vitest";
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

function approvalInboxButton(page: Page) {
  return page.locator("openclaw-sidebar-attention .sidebar-issues-button");
}

function approvalInboxPanel(page: Page) {
  return page.locator("openclaw-sidebar-attention #sidebar-issues-panel");
}
const inlineApproval = (page: Page, id: string) =>
  page.locator(`.chat-inline-approval [data-approval-id="${id}"]`);
async function openChat(options: Parameters<typeof installMockGateway>[1] = {}) {
  const context = await suite.newBrowserContext({
    viewport: { height: 800, width: 1200 },
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, options);
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, activeSessionKey));
  await gateway.waitForRequest("sessions.list");
  const request = (...args: Parameters<typeof approval>) =>
    gateway.emitGatewayEvent("exec.approval.requested", approval(...args));
  return { page, gateway, request };
}

suite.define(() => {
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

  it("keeps no-auth Inbox approvals readable while blocking decisions", async () => {
    const { page, request } = await openChat({
      omitConnectHelloAuth: true,
      sessionKey: activeSessionKey,
    });

    await request("approval-review-only", "echo review only", 1_000);

    await approvalInboxButton(page).click();
    const inboxPanel = approvalInboxPanel(page);
    const inboxRow = inboxPanel.locator('[data-approval-id="approval-review-only"]');
    await expect
      .poll(() => inboxRow.locator(".sidebar-approval-row__command").textContent())
      .toContain("echo review only");
    await inboxRow
      .getByText("Review only. Sign in with approval access to record a decision.", { exact: true })
      .waitFor();
    expect(
      await inboxRow
        .locator(".sidebar-approval-row__actions button")
        .evaluateAll((items) => items.map((button) => (button as HTMLButtonElement).disabled)),
    ).toEqual([true, true, true]);
  });
});
