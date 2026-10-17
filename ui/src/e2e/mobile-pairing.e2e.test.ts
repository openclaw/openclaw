import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { Locator, Page } from "playwright";
import qrcode from "qrcode";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
  tooltipTitleText,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI mobile pairing mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
type Access = "full" | "limited" | "node";

async function expectVisible(locator: Locator) {
  expect(await locator.isVisible()).toBe(true);
}

async function expectAbsent(locator: Locator) {
  expect(await locator.count()).toBe(0);
}

const pairCommand = {
  name: "pair",
  textAliases: ["/pair"],
  description: "Generate setup codes and approve device pairing requests.",
  source: "plugin",
  scope: "both",
  acceptsArgs: true,
};
const localPairCommand = {
  ...pairCommand,
  clientPresentation: { when: "no-arguments", action: { kind: "device-pairing" } },
};

async function expectPairingLayout(page: Page, mode: "node" | "qr") {
  const layout = await page.evaluate((currentMode) => {
    const setup = document.querySelector<HTMLElement>(".device-pair-setup")!;
    const setupBounds = setup.getBoundingClientRect();
    const elements = document.querySelectorAll<HTMLElement>(
      `.device-pair-setup, .device-pair-setup__body, .device-pair-setup__access label, .device-pair-setup__meta, .device-pair-setup__fallback, .device-pair-setup__footer, ${
        currentMode === "node"
          ? ".device-pair-setup__command, .login-gate__command, .login-gate__command code, .device-pair-setup .chat-copy-btn"
          : ".device-pair-setup__qr-frame, .device-pair-setup__qr"
      }`,
    );
    const copy = setup.querySelector<HTMLElement>(".chat-copy-btn");
    const code = setup.querySelector<HTMLElement>(".login-gate__command code");
    const qr = setup.querySelector<HTMLElement>(".device-pair-setup__qr");
    const outside = [...elements]
      .filter((element) => {
        const { left, right } = element.getBoundingClientRect();
        return (
          element.scrollWidth > element.clientWidth + 1 ||
          left < setupBounds.left - 1 ||
          right > setupBounds.right + 1
        );
      })
      .map((element) => element.className);
    return {
      accessCards: document.querySelectorAll(".device-pair-setup__access label").length,
      outside,
      copyOverlap: Boolean(
        copy && code && code.getBoundingClientRect().right > copy.getBoundingClientRect().left + 1,
      ),
      clipped: getComputedStyle(setup).overflowX === "hidden",
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      qrState:
        currentMode === "qr"
          ? Boolean(qr && Math.abs(qr.clientWidth - qr.clientHeight) <= 1)
          : qr === null,
    };
  }, mode);
  expect(layout).toEqual({
    accessCards: 3,
    outside: [],
    copyOverlap: false,
    clipped: false,
    pageOverflow: false,
    qrState: true,
  });
}

suite.define(() => {
  it("keeps setup creation admin-only while preserving device approval access", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const request = {
        requestId: "synthetic-browser-request",
        deviceId: "synthetic-browser",
        displayName: "Synthetic browser",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.read"],
        ts: Date.now(),
      };
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.pairing"],
        presenceUsers: [{ self: true, id: "pairing-operator", name: "Pairing operator" }],
        methodResponses: {
          "device.pair.list": { paired: [], pending: [request] },
          "device.pair.approve": { requestId: request.requestId },
          "node.list": { nodes: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".sidebar-identity-card").click();
      const menu = page.locator(".sidebar-identity-menu");
      const pair = menu.locator('[data-value="command:pair-mobile"]');
      await pair.waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        await takeControlUiScreenshotFrame(page, page.locator("body"), [pair], {
          animations: "disabled",
        });
      }
      expect(await pair.getAttribute("disabled")).not.toBeNull();
      expect(await tooltipTitleText(pair)).toBe(
        "Administrator access is required to create setup codes.",
      );
      await page.keyboard.press("Escape");
      await page.goto(`${suite.server.baseUrl}settings/devices`);
      const pending = page.locator(".device-entry", { hasText: "Synthetic browser" });
      await pending.waitFor();
      expect(
        await page.getByRole("button", { name: "Pair device", exact: true }).isDisabled(),
      ).toBe(true);
      await gateway.setMethodResponse("device.pair.list", { pending: [], paired: [] });
      await pending.getByRole("button", { name: "Approve", exact: true }).click();
      const approved = await gateway.waitForRequest("device.pair.approve");
      expect(approved.params).toEqual({ requestId: "synthetic-browser-request" });
      await pending.waitFor({ state: "hidden" });
      expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);
    });
  });

  it("opens pairing from a catalog command without creating a transcript turn", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const baselineText = "Pairing command baseline transcript.";
      const history = {
        content: [{ text: baselineText, type: "text" }],
        role: "assistant",
        timestamp: Date.now(),
      };
      const gateway = await installMockGateway(page, {
        historyMessages: [history],
        methodResponses: {
          "commands.list": { commands: [localPairCommand] },
          "device.pair.list": { paired: [], pending: [] },
        },
        operatorScopes: ["operator.admin"],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const baseline = page
        .locator(".chat-group.assistant .chat-text")
        .getByText(baselineText, { exact: true });
      await baseline.waitFor();
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("/pa");
      await gateway.waitForRequest("commands.list");
      const pairOption = page.getByRole("option").filter({ hasText: "/pair" });
      await pairOption.waitFor();
      await pairOption.click();
      await expect.poll(() => composer.inputValue()).toBe("/pair ");
      await page.getByRole("button", { name: "Send message" }).click();

      const dialog = page.getByRole("dialog", { name: "Pair a device" });
      await dialog.waitFor();
      expect(await gateway.getRequests("chat.send")).toEqual([]);
      expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);
      expect(await baseline.count()).toBe(1);
      expect(await page.locator(".chat-group.user", { hasText: "/pair" }).count()).toBe(0);

      await page.locator(".device-pair-setup__close").click();
      await dialog.waitFor({ state: "hidden" });
      await page.reload();
      await baseline.waitFor();
      expect(await page.locator(".chat-group.user", { hasText: "/pair" }).count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toEqual([]);

      await composer.fill("/pair status");
      await page.getByRole("button", { name: "Send message" }).click();
      const remote = await gateway.waitForRequest("chat.send");
      const remoteParams = requireRecord(remote.params);
      expect(remoteParams).toEqual(expect.objectContaining({ message: "/pair status" }));
      const remoteReply = "Pair status completed remotely.";
      await gateway.emitChatFinal({
        runId: requireString(remoteParams.idempotencyKey, "pair status run id"),
        text: remoteReply,
      });
      await page
        .locator(".chat-group.assistant .chat-text")
        .getByText(remoteReply, { exact: true })
        .waitFor();
      await expect.poll(() => page.locator(".chat-queue").count()).toBe(0);

      await gateway.setMethodResponse("commands.list", {
        commands: [pairCommand],
      });
      await page.reload();
      await baseline.waitFor();
      await composer.fill("/pa");
      await expect.poll(async () => (await gateway.getRequests("commands.list")).length).toBe(1);
      await page.getByRole("option").filter({ hasText: "/pair" }).click();
      await page.getByRole("button", { name: "Send message" }).click();
      await expect.poll(async () => (await gateway.getRequests("chat.send")).length).toBe(1);
      expect((await gateway.getRequests("chat.send")).at(-1)?.params).toEqual(
        expect.objectContaining({ message: "/pair" }),
      );
    });
  });

  it("retires exact setup credentials across success, expiry, regeneration, and errors", async () => {
    const setupCode = `eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.${"Ab9_".repeat(54)}.SyntheticSignatureForLayoutOnly`;
    const qrDataUrl = await qrcode.toDataURL(setupCode, { margin: 2, width: 360 });
    const setupResult = (setupId: string, access: Access, expiresAtMs = Date.now() + 120_000) => ({
      setupId,
      expiresAtMs,
      auth: "token",
      gatewayUrl: "wss://gateway.example.test",
      ...(access === "node" ? {} : { qrDataUrl }),
      setupCode,
      urlSource: "test",
      access,
    });

    const context = {
      ...createControlUiE2eContextOptions(),
      permissions: ["clipboard-read", "clipboard-write"],
      viewport: { height: 844, width: 390 },
    };
    await suite.withPage(context, async ({ page }) => {
      const button = (name: string) => page.getByRole("button", { name });
      const text = (value: string) => page.getByText(value, { exact: true });
      const heading = (name: string) => page.getByRole("heading", { name, exact: true });
      const close = () => page.locator(".device-pair-setup__close").click();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      const gateway = await installMockGateway(page, {
        presenceUsers: [{ self: true, id: "operator", name: "Operator" }],
        methodResponses: {
          "device.pair.list": { paired: [], pending: [] },
          "device.pair.setupCode": setupResult("setup-full", "full"),
          "device.pair.setupStatus": {},
          "node.list": { nodes: [] },
        },
      });
      const setSetup = (...args: Parameters<typeof setupResult>) =>
        gateway.setMethodResponse("device.pair.setupCode", setupResult(...args));
      const resolveSetup = (...args: Parameters<typeof setupResult>) =>
        gateway.resolveDeferred("device.pair.setupCode", setupResult(...args));
      const completion = (setupId: string, access: Access, deviceName?: string) => ({
        setupId,
        access,
        deviceId: "synthetic-phone",
        ts: 1,
        ...(deviceName ? { deviceName } : {}),
      });
      const complete = (...args: Parameters<typeof completion>) =>
        gateway.emitGatewayEvent("device.pair.setup.completed", completion(...args));

      const response = await page.goto(`${suite.server.baseUrl}settings/security`);
      expect(response?.status()).toBe(200);
      const pairFromSettings = page
        .locator(".security-page")
        .getByRole("button", { name: "Pair device" });
      const access = page.locator('input[name="device-pair-access"]');
      const openSetup = async (id: string, profile: Access, ttlMs = 120_000) => {
        await pairFromSettings.click();
        if (profile !== "full") {
          await access.nth(profile === "limited" ? 1 : 2).check();
        }
        await setSetup(id, profile, ttlMs === 0 ? 0 : Date.now() + ttlMs);
        await button("Create setup code").click();
      };
      await expect.poll(async () => pairFromSettings.isEnabled()).toBe(true);
      await pairFromSettings.click();

      const dialog = page.getByRole("dialog", { name: "Pair a device" });
      const qr = page.getByAltText("OpenClaw mobile pairing QR code");
      await dialog.waitFor();
      await button("Create setup code").waitFor();
      const dialogBox = await page.locator(".device-pair-setup").boundingBox();
      expect(dialogBox?.width).toBeLessThanOrEqual(390);

      const helpDocumentUrl = "https://docs.openclaw.ai/channels/pairing";
      const helpUrl = `${helpDocumentUrl}#pair-from-the-control-ui-recommended`;
      // This mocked scenario owns navigation, not docs-site availability. Context
      // routing also covers the popup's first request, which page routing misses.
      await page.context().route(helpDocumentUrl, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Pairing help</title>",
        }),
      );
      const help = page.getByRole("link", { name: "Pairing help (opens in a new tab)" });
      expect(await help.getAttribute("href")).toBe(helpUrl);
      expect(await help.getAttribute("target")).toBe("_blank");
      expect((await help.getAttribute("rel"))?.split(" ")).toEqual(
        expect.arrayContaining(["noopener", "noreferrer"]),
      );
      expect(await help.locator("svg").count()).toBe(1);
      await help.focus();
      expect(await help.evaluate((element) => element === document.activeElement)).toBe(true);
      await help.hover();
      const [helpPopup] = await Promise.all([page.waitForEvent("popup"), help.click()]);
      await helpPopup.waitForURL(helpUrl);
      expect(helpPopup.url()).toBe(helpUrl);
      expect(await helpPopup.title()).toBe("Pairing help");
      await helpPopup.close();

      await gateway.deferNext("device.pair.setupCode");
      await button("Create setup code").click();
      await expectVisible(page.getByRole("status").getByText("Creating a secure setup code…"));
      await expectAbsent(qr);
      expect(await access.first().isDisabled()).toBe(true);
      await resolveSetup("setup-full", "full");
      await qr.waitFor();
      await expectPairingLayout(page, "qr");

      await complete("setup-unrelated", "full", "Unrelated phone");
      await expectVisible(qr);
      await complete("setup-full", "full", "Test iPhone");
      await expect.poll(async () => qr.count()).toBe(0);
      await expectVisible(text("Test iPhone"));
      await expectVisible(text("Device paired · Full access"));
      await button("Done").click();
      await dialog.waitFor({ state: "hidden" });

      await page.setViewportSize({ height: 900, width: 1280 });
      await openSetup("setup-limited", "limited");
      await qr.waitFor();
      await expectPairingLayout(page, "qr");
      expect((await gateway.getRequests("device.pair.setupCode")).at(-1)?.params).toEqual({
        bootstrapProfile: "limited",
      });
      await complete("setup-limited", "limited");
      await expect.poll(async () => qr.count()).toBe(0);
      await expectVisible(heading("Device paired"));
      await expectVisible(text("Limited access"));
      await button("Done").click();

      // The completion event is droppable. With the event never delivered, the
      // lapsing credential must still resolve to paired, not to expired.
      await gateway.setMethodResponse("device.pair.setupStatus", {
        completion: completion("setup-missed", "full", "Recovered iPhone"),
      });
      await openSetup("setup-missed", "full", 2_000);
      await qr.waitFor();
      await text("Recovered iPhone").waitFor();
      await expectAbsent(qr);
      await expectAbsent(text("Setup code expired"));
      expect((await gateway.getRequests("device.pair.setupStatus")).at(-1)?.params).toEqual({
        setupId: "setup-missed",
      });
      await button("Done").click();

      // Retiring the bearer is not success when the credential-bearing
      // response did not finish. Surface a recovery path instead.
      await gateway.setMethodResponse("device.pair.setupStatus", {
        deliveryUncertain: completion("setup-uncertain", "full"),
      });
      await openSetup("setup-uncertain", "full", 2_000);
      await page
        .getByRole("heading", { name: "Pairing delivery could not be confirmed" })
        .waitFor();
      await expectAbsent(qr);
      await expectVisible(button("Generate new code"));
      await expectVisible(button("Manage devices"));
      await close();

      await gateway.deferNext("device.pair.setupStatus");
      await openSetup("setup-expired", "full", 0);
      await page.getByRole("status").getByText("Loading…", { exact: true }).waitFor();
      await expectAbsent(qr);
      await expectAbsent(button("Copy setup code"));
      await expectAbsent(text(setupCode));
      await gateway.resolveDeferred("device.pair.setupStatus", {});
      await heading("Setup code expired").waitFor();
      await expectAbsent(qr);

      await setSetup("setup-current", "full");
      await gateway.deferNext("device.pair.setupCode");
      await button("Generate new code").click();
      await expectAbsent(qr);
      await expectVisible(text("Creating a secure setup code…"));
      await resolveSetup("setup-current", "full");
      await qr.waitFor();
      await complete("setup-expired", "full");
      await expectVisible(qr);

      await gateway.deferNext("device.pair.setupCode");
      await button("New code").click();
      await expectAbsent(qr);
      await gateway.rejectDeferred("device.pair.setupCode", { message: "setup unavailable" });
      const error = page.getByRole("alert");
      await expectVisible(error.getByText("Could not create a setup code."));
      await expectVisible(error.getByText("setup unavailable", { exact: false }));

      await setSetup("setup-recovered", "full");
      await button("Reload").click();
      await qr.waitFor();

      await page.clock.install();
      await gateway.deferNext("device.pair.setupCode");
      await button("New code").click();
      await page.clock.fastForward(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS + 1);
      await page.clock.runFor(100);
      await expectVisible(
        error.getByText("gateway request timed out after 30000ms: device.pair.setupCode"),
      );
      await button("Reload").click();
      await qr.waitFor();
      await close();
      await dialog.waitFor({ state: "hidden" });
      const nodeCommand = `openclaw node run --pair "oc-pair://${setupCode}"`;
      const setup = page.locator(".device-pair-setup");
      for (const viewport of [
        { height: 900, width: 1280 },
        { height: 844, width: 390 },
      ]) {
        await page.setViewportSize(viewport);
        await openSetup(`setup-node-${viewport.width}`, "node", 60_000);
        await text(nodeCommand).waitFor();
        await expectPairingLayout(page, "node");
        const copy = setup.locator(".chat-copy-btn");
        await copy.focus();
        expect(await copy.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.evaluate(() => navigator.clipboard.writeText("before-copy"));
        await copy.click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(nodeCommand);
        const manageDevices = button("Manage devices");
        await manageDevices.scrollIntoViewIfNeeded();
        await manageDevices.click({ trial: true });
        if (viewport.width === 1280) {
          await close();
        }
      }
      // The body scrolls while completion actions stay outside it in the pinned footer.
      const scrollBody = setup.locator(".device-pair-setup__body");
      await scrollBody.hover();
      await page.mouse.wheel(0, 1000);
      await expect
        .poll(() => scrollBody.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      const footerBounds = await setup.locator(".device-pair-setup__footer").boundingBox();
      expect(footerBounds).not.toBeNull();
      expect(footerBounds!.y + footerBounds!.height).toBeLessThanOrEqual(
        page.viewportSize()!.height,
      );
      expect((await gateway.getRequests("device.pair.setupCode")).at(-1)?.params).toEqual({
        bootstrapProfile: "node",
        includeQr: false,
      });
      await button("Manage devices").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/devices");
      expect(pageErrors).toEqual([]);
    });
  });
});
