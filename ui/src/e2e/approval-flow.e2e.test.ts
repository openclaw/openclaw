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

let browser: Browser | undefined;
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

describeControlUiE2e("Control UI approval flow", () => {
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

  it("keeps an older resolve failure off the newly active approval", async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
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
    await currentPage.getByText("echo newer", { exact: true }).waitFor();
    await gateway.rejectDeferred("exec.approval.resolve", {
      code: "UNAVAILABLE",
      message: "gateway unavailable",
    });

    await expect.poll(() => currentPage.locator(".exec-approval-error").count()).toBe(0);
    await expect
      .poll(() => currentPage.getByRole("button", { name: "Deny" }).isEnabled())
      .toBe(true);
  });
});
