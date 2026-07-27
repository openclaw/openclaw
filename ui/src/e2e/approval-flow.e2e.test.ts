// Control UI E2E tests cover approval queue behavior through the Gateway WebSocket.
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

// Browser contexts preserve test isolation; keep one process warm for this file.
let browser: Browser;
let page: Page | undefined;
let server: ControlUiE2eServer | undefined;

function approval(id: string, command: string, createdAtMs: number) {
  return {
    id,
    createdAtMs,
    expiresAtMs: Date.now() + 60_000,
    request: { command },
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object value");
  }
  return value as Record<string, unknown>;
}

describeControlUiE2e("Control UI approval flow", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });

  afterEach(async () => {
    await page
      ?.context()
      .close()
      .catch(() => {});
    page = undefined;
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await server?.close();
  });

  it("keeps an older resolve failure off the newly active approval", async () => {
    const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage);

    await currentPage.goto(`${server?.baseUrl ?? ""}chat`);
    await gateway.waitForRequest("sessions.list");
    await gateway.deferNext("exec.approval.resolve");
    await gateway.emitGatewayEvent(
      "exec.approval.requested",
      approval("approval-active", "echo active", 1_000),
    );
    await currentPage.getByText("echo active", { exact: true }).waitFor();
    await currentPage.getByRole("button", { name: "Allow once" }).click();

    await gateway.emitGatewayEvent(
      "exec.approval.requested",
      approval("approval-newer", "echo newer", 2_000),
    );
    // New requests appear in the pending list, but the security modal pins
    // its presented card until the user explicitly reviews another prompt.
    await currentPage
      .locator(".exec-approval-list__item")
      .filter({ hasText: "echo newer" })
      .click();
    const activeCard = currentPage.locator(
      '.exec-approval-card[data-approval-id="approval-newer"]',
    );
    await activeCard.waitFor();
    await gateway.rejectDeferred("exec.approval.resolve", {
      code: "UNAVAILABLE",
      message: "gateway unavailable",
    });

    await expect.poll(() => activeCard.locator(".exec-approval-error").count()).toBe(0);
    await expect
      .poll(() => currentPage.getByRole("button", { name: "Deny" }).isEnabled())
      .toBe(true);

    await currentPage
      .locator(".exec-approval-list__item")
      .filter({ hasText: "echo active" })
      .click();
    const failedCard = currentPage.locator(
      '.exec-approval-card[data-approval-id="approval-active"]',
    );
    await failedCard.locator(".exec-approval-error").waitFor();
    expect(await failedCard.locator(".exec-approval-error").textContent()).toContain(
      "gateway unavailable",
    );
  });

  for (const outcome of ["success", "failure"] as const) {
    it(`reconciles a refreshed same-generation approval after decision ${outcome}`, async () => {
      const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
      const currentPage = await context.newPage();
      page = currentPage;
      const gateway = await installMockGateway(currentPage);

      await currentPage.goto(`${server?.baseUrl ?? ""}chat`);
      await gateway.waitForRequest("sessions.list");
      await gateway.deferNext("exec.approval.resolve");
      await gateway.emitGatewayEvent(
        "exec.approval.requested",
        approval("approval-refreshed", "echo original approval", 1_000),
      );
      await currentPage.getByText("echo original approval", { exact: true }).waitFor();
      await currentPage.getByRole("button", { name: "Allow once" }).click();

      await gateway.emitGatewayEvent(
        "exec.approval.requested",
        approval("approval-refreshed", "echo refreshed approval", 1_000),
      );
      const refreshed = currentPage.getByText("echo refreshed approval", { exact: true });
      await refreshed.waitFor();

      if (outcome === "success") {
        await gateway.resolveDeferred("exec.approval.resolve", { ok: true });
        await expect.poll(() => refreshed.count()).toBe(0);
        return;
      }

      await gateway.rejectDeferred("exec.approval.resolve", {
        code: "UNAVAILABLE",
        message: "gateway unavailable",
      });
      const refreshedCard = currentPage.locator(
        '.exec-approval-card[data-approval-id="approval-refreshed"]',
      );
      await expect
        .poll(async () => (await refreshedCard.locator(".exec-approval-error").textContent()) ?? "")
        .toContain("gateway unavailable");
      const denyButton = refreshedCard.getByRole("button", { name: "Deny" });
      await expect.poll(() => denyButton.isEnabled()).toBe(true);
      await denyButton.click();
      await expect
        .poll(async () => (await gateway.getRequests("exec.approval.resolve")).length)
        .toBe(2);
      await expect.poll(() => refreshed.count()).toBe(0);
    });
  }

  for (const outcome of ["success", "failure"] as const) {
    it(`keeps a reused-id replacement actionable after an older decision ${outcome}`, async () => {
      const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
      const currentPage = await context.newPage();
      page = currentPage;
      const gateway = await installMockGateway(currentPage);

      await currentPage.goto(`${server?.baseUrl ?? ""}chat`);
      await gateway.waitForRequest("sessions.list");
      await gateway.deferNext("exec.approval.resolve");
      await gateway.emitGatewayEvent(
        "exec.approval.requested",
        approval("approval-reused", "echo original approval", 1_000),
      );
      await currentPage.getByText("echo original approval", { exact: true }).waitFor();
      await currentPage.getByRole("button", { name: "Allow once" }).click();

      await gateway.emitGatewayEvent(
        "exec.approval.requested",
        approval("approval-reused", "echo replacement approval", 2_000),
      );
      const replacement = currentPage.getByText("echo replacement approval", { exact: true });
      await replacement.waitFor();

      if (outcome === "success") {
        await gateway.resolveDeferred("exec.approval.resolve", { ok: true });
      } else {
        await gateway.rejectDeferred("exec.approval.resolve", {
          code: "UNAVAILABLE",
          message: "gateway unavailable",
        });
      }

      await expect.poll(() => replacement.isVisible()).toBe(true);
      await expect.poll(() => currentPage.locator(".exec-approval-error").count()).toBe(0);
      const denyButton = currentPage.getByRole("button", { name: "Deny" });
      await expect.poll(() => denyButton.isEnabled()).toBe(true);
      await denyButton.click();
      await expect
        .poll(async () => (await gateway.getRequests("exec.approval.resolve")).length)
        .toBe(2);
      await expect.poll(() => replacement.count()).toBe(0);
    });
  }

  it("sends a typed approval command immediately while the active run waits", async () => {
    const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage);

    await currentPage.goto(`${server?.baseUrl ?? ""}chat`);
    await gateway.waitForRequest("sessions.list");

    const composer = currentPage.locator(".agent-chat__composer-combobox textarea");
    await composer.fill("run a command that needs approval");
    await currentPage.getByRole("button", { name: "Send message" }).click();
    const firstSend = requireRecord((await gateway.waitForRequest("chat.send")).params);
    expect(firstSend.message).toBe("run a command that needs approval");
    await currentPage.getByRole("button", { name: "Stop generating" }).waitFor();

    await composer.fill("/approve approval-123 allow-once");
    await currentPage.getByRole("button", { name: "Send message" }).click();

    await expect
      .poll(async () => (await gateway.getRequests("chat.send")).length, { timeout: 10_000 })
      .toBe(2);
    const sends = await gateway.getRequests("chat.send");
    const approvalSend = requireRecord(sends[1]?.params);
    expect(approvalSend.message).toBe("/approve approval-123 allow-once");
    expect(approvalSend.deliver).toBe(false);
    expect(typeof approvalSend.idempotencyKey).toBe("string");
    expect(await currentPage.locator(".chat-queue").count()).toBe(0);
    expect(await composer.inputValue()).toBe("");
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(1);
  });
});
