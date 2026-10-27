import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
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
  it("keeps approvals passive through detail review and queued decisions", async () => {
    const sessions: GatewaySessionRow[] = [
      { key: activeSessionKey, label: "Main", kind: "direct", updatedAt: 1_000 },
      {
        key: "agent:main:other",
        label: "Review navigation",
        kind: "direct",
        updatedAt: 2_000,
        worktree: { id: "review", branch: "review/navigation", repoRoot: "/projects/atlas" },
        spawnedCwd: "/projects/atlas-review",
      },
    ];
    const { page, gateway, request } = await openChat({ sessionKey: activeSessionKey, sessions });
    const initial = approval("approval-inline", "echo inline", 1_000);
    await gateway.emitGatewayEvent("exec.approval.requested", {
      ...initial,
      request: { ...initial.request, host: "sandbox", resolvedPath: "/usr/bin/echo" },
    });

    await inlineApproval(page, "approval-inline").waitFor();
    expect(
      await inlineApproval(page, "approval-inline")
        .locator(".exec-approval-prompt .exec-approval-host")
        .count(),
    ).toBe(0);
    expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
    await inlineApproval(page, initial.id)
      .getByRole("button", { name: "Request details", exact: true })
      .click();
    const details = page.getByRole("dialog", { name: "Request details", exact: true });
    await details.getByText("/usr/bin/echo", { exact: true }).waitFor();
    expect(await gateway.getRequests("exec.approval.resolve")).toHaveLength(0);
    await page.keyboard.press("Escape");
    await details.waitFor({ state: "hidden" });

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
    await page.keyboard.press("Escape");
    await inlineApproval(page, "approval-inline")
      .getByRole("button", { name: "1 more pending" })
      .click();
    const modal = page.locator("openclaw-exec-approval .exec-approval-card");
    await modal.locator(".exec-approval-list__item", { hasText: "echo other" }).click();
    await expect.poll(() => modal.getAttribute("data-approval-id")).toBe("approval-other");
    expect(await modal.locator(".exec-approval-title").textContent()).toContain(
      "Review navigation",
    );
    const renamed = { ...sessions[1], label: "Review navigation updated", updatedAt: Date.now() };
    await gateway.setSessionsListResponse(chatSessionListResponse([sessions[0], renamed]));
    await gateway.emitGatewayEvent("sessions.changed", { agentId: "main", reason: "update" });
    await expect
      .poll(() => modal.locator(".exec-approval-title").textContent(), { timeout: 15_000 })
      .toContain("Review navigation updated");
    await page.keyboard.press("Escape");
    await page.locator("openclaw-modal-dialog").waitFor({ state: "hidden" });
    await inlineApproval(page, "approval-inline")
      .getByRole("button", { name: "1 more pending" })
      .click();
    await expect
      .poll(() => modal.locator(".exec-approval-title").textContent())
      .toContain("Review navigation updated");
    expect(await gateway.getRequests("exec.approval.resolve")).toHaveLength(0);
    await gateway.deferNext("exec.approval.resolve", { id: "approval-other" });
    const allow = modal.getByRole("button", { name: "Allow once", exact: true });
    await allow.click();
    const decision = await gateway.waitForRequest("exec.approval.resolve");
    expect(decision.params).toEqual({ id: "approval-other", decision: "allow-once" });
    await expect.poll(() => allow.isDisabled()).toBe(true);
    await gateway.resolveDeferred("exec.approval.resolve");
    await expect.poll(() => modal.getAttribute("data-approval-id")).toBe("approval-inline");
    await expect.poll(() => modal.getByRole("button", { name: /echo other/ }).count()).toBe(0);
    expect(await modal.locator(".exec-approval-source").count()).toBe(0);
  });

  it("keeps no-auth Inbox approvals readable while blocking decisions", async () => {
    const { page, request } = await openChat({
      omitConnectHelloAuth: true,
      sessionKey: activeSessionKey,
    });

    await request("approval-review-only", "echo review only", 1_000);
    const card = inlineApproval(page, "approval-review-only");
    await card.getByText("View only", { exact: true }).waitFor();
    expect(await card.locator(".exec-approval-actions button").count()).toBe(0);

    await approvalInboxButton(page).click();
    const inboxPanel = approvalInboxPanel(page);
    const inboxRow = inboxPanel.locator('[data-approval-id="approval-review-only"]');
    await expect
      .poll(() => inboxRow.locator(".sidebar-approval-row__command").textContent())
      .toContain("echo review only");
    await inboxRow.getByText("You don’t have permission to approve.", { exact: true }).waitFor();
    expect(
      await inboxRow
        .locator(".sidebar-approval-row__actions button")
        .evaluateAll((items) => items.map((button) => (button as HTMLButtonElement).disabled)),
    ).toEqual([true, true, true]);
  });
});
