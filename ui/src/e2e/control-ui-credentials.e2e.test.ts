// Control UI tests cover browser credential submission and visible recovery.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Gateway secret E2E",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});
let artifactDir: string;
beforeEach(() => {
  artifactDir = createControlUiE2eArtifactDir("control-ui-credentials");
});
const viewport = { height: 900, width: 1280 };

const requireRecord = createRequireRecord("record", "expected-object-value");

function readConnectAuth(request: MockGatewayRequest): Record<string, unknown> | undefined {
  const auth = requireRecord(request.params).auth;
  return auth == null ? undefined : requireRecord(auth);
}

async function createCredentialPage() {
  const context = await suite.newBrowserContext({
    locale: "en-US",
    recordVideo:
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? { dir: artifactDir, size: viewport }
        : undefined,
    serviceWorkers: "block",
    viewport,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
  const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });
  const response = await page.goto(suite.server.baseUrl);
  expect(response?.status()).toBe(200);
  return { context, gateway, page };
}

type CredentialFlow = Awaited<ReturnType<typeof createCredentialPage>>;

async function submitSecret({ page, gateway }: CredentialFlow, secret: string) {
  const previousCount = (await gateway.getRequests("connect")).length;
  await gateway.deferNext("connect");
  await page.getByLabel("Gateway secret", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  expect(readConnectAuth(await waitForNextConnect(gateway, previousCount))).toMatchObject({
    token: secret,
    password: secret,
  });
}

async function captureCredentialPage(page: Page, fileName: string, rejected = false) {
  await writeFile(
    path.join(artifactDir, fileName),
    await takeControlUiViewportScreenshot(
      page,
      page.locator(rejected ? ".login-gate__card" : ".shell"),
      [page.locator(rejected ? ".login-gate__failure-steps" : "#control-ui-main")],
    ),
  );
}

async function acceptSecret({ page, gateway }: CredentialFlow, fileName: string) {
  await gateway.resolveDeferred("connect");
  await page.locator("openclaw-app-shell").waitFor();
  expect(await page.locator("openclaw-login-gate").count()).toBe(0);
  await captureCredentialPage(page, fileName);
}

async function waitForNextConnect(
  gateway: MockGatewayControls,
  previousCount: number,
): Promise<MockGatewayRequest> {
  await expect
    .poll(async () => (await gateway.getRequests("connect")).length)
    .toBe(previousCount + 1);
  const request = (await gateway.getRequests("connect")).at(-1);
  if (!request) {
    throw new Error("Expected a new Control UI connect request");
  }
  return request;
}

async function rejectInitialConnect(
  page: Page,
  gateway: MockGatewayControls,
  code: string,
  message: string,
): Promise<void> {
  const initialConnect = await gateway.waitForRequest("connect");
  expect(readConnectAuth(initialConnect)).toBeUndefined();
  await gateway.rejectDeferred("connect", {
    code: "UNAUTHORIZED",
    details: { code },
    message,
  });
  await page.locator("openclaw-login-gate").waitFor();
}

suite.define(() => {
  it("submits one secret for both authentication modes with visible acceptance and rejection recovery", async () => {
    const tokenFlow = await createCredentialPage();
    const tokenPageErrors: string[] = [];
    tokenFlow.page.on("pageerror", (error) => tokenPageErrors.push(String(error)));
    await rejectInitialConnect(
      tokenFlow.page,
      tokenFlow.gateway,
      ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
      "unauthorized: gateway token required",
    );

    await submitSecret(tokenFlow, "token-accepted-by-mock");
    await acceptSecret(tokenFlow, "01-token-connected.png");
    expect(tokenPageErrors).toEqual([]);
    await suite.closeBrowserContext(tokenFlow.context);

    const passwordFlow = await createCredentialPage();
    const passwordPageErrors: string[] = [];
    passwordFlow.page.on("pageerror", (error) => passwordPageErrors.push(String(error)));
    await rejectInitialConnect(
      passwordFlow.page,
      passwordFlow.gateway,
      ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
      "unauthorized: gateway password required",
    );

    await submitSecret(passwordFlow, "password-rejected-by-mock");
    await passwordFlow.gateway.rejectDeferred("connect", {
      code: "UNAUTHORIZED",
      details: { code: ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH },
      message: "unauthorized: gateway password mismatch",
    });

    const failure = passwordFlow.page.locator(".login-gate__failure");
    await failure.waitFor();
    expect(await failure.getAttribute("role")).toBe("status");
    expect(await failure.getAttribute("aria-live")).toBe("polite");
    expect(await failure.textContent()).toContain("This Gateway expects its password");
    expect(
      (await failure.locator(".login-gate__failure-raw").textContent())?.toLowerCase(),
    ).toContain("gateway password mismatch");
    expect(await failure.locator(".login-gate__failure-steps").isVisible()).toBe(true);
    expect(await passwordFlow.page.locator("openclaw-app-shell").count()).toBe(0);
    await captureCredentialPage(passwordFlow.page, "02-password-rejected.png", true);
    await submitSecret(passwordFlow, "password-accepted-by-mock");
    await acceptSecret(passwordFlow, "03-password-recovered.png");
    expect(passwordPageErrors).toEqual([]);
  });
});
