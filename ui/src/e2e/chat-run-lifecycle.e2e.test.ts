// Control UI E2E tests cover chat run lifecycle behavior through the Gateway WebSocket.
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CHAT_RUN_STATUS_TOAST_DURATION_MS } from "../pages/chat/run-lifecycle.ts";
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

let browser: Browser | undefined;
let page: Page | undefined;
let server: ControlUiE2eServer | undefined;

describeControlUiE2e("Control UI chat run lifecycle", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
  });

  afterEach(async () => {
    await page
      ?.context()
      .close()
      .catch(() => {});
    await browser?.close().catch(() => {});
    page = undefined;
    browser = undefined;
  });

  afterAll(async () => {
    await server?.close();
  });

  it("keeps Send visible when a stale active row outlives the terminal toast", async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    const context = await browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage);

    await currentPage.goto(`${server?.baseUrl ?? ""}chat`);
    await gateway.waitForRequest("sessions.list");
    await currentPage.locator(".agent-chat__composer-combobox textarea").fill("finish this run");
    await currentPage.getByRole("button", { name: "Send message" }).click();
    const send = await gateway.waitForRequest("chat.send");
    const params = send.params as { idempotencyKey?: unknown };
    expect(typeof params.idempotencyKey).toBe("string");
    const runId = params.idempotencyKey as string;

    await currentPage.getByRole("button", { name: "Stop generating" }).waitFor();
    await gateway.emitChatFinal({ runId, text: "Run complete." });
    await currentPage.getByText("Run complete.", { exact: true }).waitFor();
    await currentPage.getByRole("button", { name: "Send message" }).waitFor();

    await gateway.emitGatewayEvent("sessions.changed", {
      activeRunIds: [runId],
      hasActiveRun: true,
      key: "main",
      kind: "direct",
      reason: "lifecycle",
      startedAt: Date.now() - 1_000,
      status: "running",
      updatedAt: Date.now(),
    });
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);

    await currentPage.waitForTimeout(CHAT_RUN_STATUS_TOAST_DURATION_MS + 250);
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
    expect(await currentPage.getByRole("button", { name: "Send message" }).count()).toBe(1);

    await gateway.emitGatewayEvent("sessions.changed", {
      key: "agent:main:another-session",
      kind: "direct",
      label: "Another session",
      reason: "lifecycle",
      updatedAt: Date.now(),
    });
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
    expect(await currentPage.getByRole("button", { name: "Send message" }).count()).toBe(1);

    // Re-publish after the former 10-second suppression window. The completed
    // run identity stays terminal until the Gateway publishes different state.
    await currentPage.waitForTimeout(CHAT_RUN_STATUS_TOAST_DURATION_MS + 250);
    await gateway.emitGatewayEvent("sessions.changed", {
      activeRunIds: [runId],
      hasActiveRun: true,
      key: "main",
      kind: "direct",
      reason: "lifecycle",
      startedAt: Date.now() - 11_000,
      status: "running",
      updatedAt: Date.now(),
    });
    expect(await currentPage.getByRole("button", { name: "Stop generating" }).count()).toBe(0);
    expect(await currentPage.getByRole("button", { name: "Send message" }).count()).toBe(1);
  });
});
