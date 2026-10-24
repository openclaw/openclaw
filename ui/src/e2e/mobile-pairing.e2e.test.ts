import { writeFile } from "node:fs/promises";
// Control UI tests cover mobile pairing setup through the mocked Gateway.
import path from "node:path";
import type { Page } from "playwright";
import qrcode from "qrcode";
import { beforeEach, expect, it } from "vitest";
import type { OpenClawModalDialog } from "../components/modal-dialog.tsx";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
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
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

// Visual proof rides the behavioral scenario so every captured state is one the
// assertions above it already proved, at whatever SHA the lane ran.
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let uiProofArtifactDir: string;
beforeEach(() => {
  if (captureUiProofEnabled) {
    uiProofArtifactDir = createControlUiE2eArtifactDir("mobile-pairing");
  }
});

async function captureUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await page.screenshot({ animations: "disabled", path: path.join(uiProofArtifactDir, fileName) });
}

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
        const bounds = element.getBoundingClientRect();
        return (
          element.scrollWidth > element.clientWidth + 1 ||
          bounds.left < setupBounds.left - 1 ||
          bounds.right > setupBounds.right + 1
        );
      })
      .map((element) => element.className);
    if (
      copy &&
      code &&
      code.getBoundingClientRect().right > copy.getBoundingClientRect().left + 1
    ) {
      outside.push("copy-overlap");
    }
    if (getComputedStyle(setup).overflowX === "hidden") {
      outside.push("clipped-overflow");
    }
    let qrState = qr === null;
    if (currentMode === "qr") {
      qrState = qr ? Math.abs(qr.clientWidth - qr.clientHeight) <= 1 : false;
    }
    return {
      accessCards: document.querySelectorAll(".device-pair-setup__access label").length,
      outside,
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      qrState,
    };
  }, mode);

  expect(layout).toEqual({
    accessCards: 3,
    outside: [],
    pageOverflow: false,
    qrState: true,
  });
}

suite.define(() => {
  it("keeps setup creation admin-only while preserving device approval access", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.pairing"],
        presenceUsers: [{ self: true, id: "pairing-operator", name: "Pairing operator" }],
        methodResponses: {
          "device.pair.list": {
            paired: [],
            pending: [
              {
                requestId: "synthetic-browser-request",
                deviceId: "synthetic-browser",
                displayName: "Synthetic browser",
                role: "operator",
                roles: ["operator"],
                scopes: ["operator.read"],
                ts: Date.now(),
              },
            ],
          },
          "device.pair.approve": { requestId: "synthetic-browser-request" },
          "node.list": { nodes: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".sidebar-identity-card").click();
      const menu = page.locator(".sidebar-identity-menu");
      const pair = menu.locator('[data-value="command:pair-mobile"]');
      await pair.waitFor();
      if (captureUiProofEnabled) {
        const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [pair], {
          animations: "disabled",
        });
        await writeFile(path.join(uiProofArtifactDir, "pairing-operator-menu.png"), frame.png);
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
      await pending.getByRole("button", { name: "Approve Synthetic browser", exact: true }).click();
      const approved = await gateway.waitForRequest("device.pair.approve");
      expect(approved.params).toEqual({ requestId: "synthetic-browser-request" });
      await pending.waitFor({ state: "hidden" });
      expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);
    });
  });

  it("opens pairing from a catalog command without creating a transcript turn", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const baselineText = "Pairing command baseline transcript.";
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            content: [{ text: baselineText, type: "text" }],
            role: "assistant",
            timestamp: Date.now(),
          },
        ],
        methodResponses: {
          "commands.list": {
            commands: [
              {
                name: "pair",
                textAliases: ["/pair"],
                description: "Generate setup codes and approve device pairing requests.",
                source: "plugin",
                scope: "both",
                acceptsArgs: true,
                clientPresentation: {
                  when: "no-arguments",
                  action: { kind: "device-pairing" },
                },
              },
            ],
          },
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
        commands: [
          {
            name: "pair",
            textAliases: ["/pair"],
            description: "Generate setup codes and approve device pairing requests.",
            source: "plugin",
            scope: "both",
            acceptsArgs: true,
          },
        ],
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

  it("keeps QR and node pairing usable at mobile and desktop widths", async () => {
    const setupCode =
      "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9." +
      "Ab9_".repeat(54) +
      ".SyntheticSignatureForLayoutOnly";
    const qrDataUrl = await qrcode.toDataURL(setupCode, { margin: 2, width: 360 });
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        permissions: ["clipboard-read", "clipboard-write"],
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ self: true, id: "operator", name: "Operator" }],
          methodResponses: {
            "device.pair.list": { paired: [], pending: [] },
            "node.list": { nodes: [] },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/security");
        const pair = page.locator(".security-page").getByRole("button", { name: "Pair device" });
        const dialog = page.getByRole("dialog", { name: "Pair a device" });
        const setup = page.locator(".device-pair-setup");
        const command = 'openclaw node run --pair "oc-pair://' + setupCode + '"';
        for (const [access, width] of [
          ["full", 390],
          ["limited", 1280],
          ["node", 1280],
          ["node", 390],
        ] as const) {
          const viewport = { height: width === 390 ? 844 : 900, width };
          await page.setViewportSize(viewport);
          await gateway.setMethodResponse("device.pair.setupCode", {
            setupId: "setup-" + access + width,
            setupCode,
            access,
            expiresAtMs: Date.now() + 120_000,
            auth: "token",
            gatewayUrl: "wss://gateway.example.test",
            urlSource: "test",
            ...(access === "node" ? {} : { qrDataUrl }),
          });
          await pair.click();
          try {
            await dialog.waitFor();
          } catch (reopenError) {
            try {
              const state = await evaluateControlUiContext(page, (context) => {
                const overlay = context.overlays.snapshot;
                const gatewaySnapshot = context.gateway.snapshot;
                return {
                  gatewayPhase: gatewaySnapshot.phase,
                  admin: gatewaySnapshot.hello?.auth?.scopes?.includes("operator.admin") ?? false,
                  pairingOpen: overlay.devicePairSetupOpen,
                  pairingPhase: overlay.devicePairSetupLifecycle.phase,
                  modalLayers: document.openClawModalLayers?.size ?? 0,
                  hosts: Array.from(
                    document.querySelectorAll<OpenClawModalDialog>("openclaw-modal-dialog"),
                    (host) => ({
                      open: host.open,
                      connected: host.isConnected,
                      dialogs: Array.from(host.querySelectorAll("dialog"), (native) => ({
                        open: native.open,
                        inert: native.inert,
                        phase: native.dataset.phase,
                        visible: native.getClientRects().length > 0,
                      })),
                    }),
                  ),
                };
              });
              console.warn(
                "[mobile-pairing] reopen timeout",
                JSON.stringify({ viewport, pageErrorCount: pageErrors.length, state }),
              );
            } catch {
              console.warn("[mobile-pairing] reopen timeout diagnostics unavailable");
            }
            throw reopenError;
          }
          expect((await setup.boundingBox())?.width).toBeLessThanOrEqual(width);
          await page
            .locator('input[name="device-pair-access"]')
            .nth(access === "full" ? 0 : access === "limited" ? 1 : 2)
            .check();
          await gateway.deferNext("device.pair.setupCode");
          await page.getByRole("button", { name: "Create setup code", exact: true }).click();
          await page.getByRole("status").getByText("Creating a secure setup code…").waitFor();
          expect(await page.getByAltText("OpenClaw mobile pairing QR code").count()).toBe(0);
          expect(await page.locator('input[name="device-pair-access"]').first().isDisabled()).toBe(
            true,
          );
          await gateway.resolveDeferred("device.pair.setupCode");
          if (access === "node") {
            await page.getByText(command, { exact: true }).waitFor();
            const copy = setup.locator(".chat-copy-btn");
            await copy.focus();
            expect(await copy.evaluate((element) => element === document.activeElement)).toBe(true);
            await page.evaluate(() => navigator.clipboard.writeText("before-copy"));
            await copy.click();
            await expect
              .poll(() => page.evaluate(() => navigator.clipboard.readText()))
              .toBe(command);
          } else {
            await page.getByAltText("OpenClaw mobile pairing QR code").waitFor();
          }
          await expectPairingLayout(page, access === "node" ? "node" : "qr");
          await captureUiProof(page, `pairing-${access}-${width}.png`);
          expect((await gateway.getRequests("device.pair.setupCode")).at(-1)?.params).toEqual(
            access === "full"
              ? {}
              : { bootstrapProfile: access, ...(access === "node" ? { includeQr: false } : {}) },
          );
          if (access === "full") {
            const helpDocumentUrl = "https://docs.openclaw.ai/channels/pairing";
            const helpUrl = helpDocumentUrl + "#pair-from-the-control-ui-recommended";
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
            await captureUiProof(page, "10-mobile-pairing-help-focus-hover.png");
            const [popup] = await Promise.all([page.waitForEvent("popup"), help.click()]);
            await popup.waitForURL(helpUrl);
            expect(await popup.title()).toBe("Pairing help");
            await popup.close();
          }
          const manage = page.getByRole("button", { name: "Manage devices", exact: true });
          await manage.scrollIntoViewIfNeeded();
          await manage.click({ trial: true });
          if (access !== "node" || width !== 390) {
            await page.locator(".device-pair-setup__close").click();
            await dialog.waitFor({ state: "hidden" });
          }
          if (access === "full") {
            // A lost completion event still reconciles through status when the code expires.
            await pair.click();
            await gateway.setMethodResponse("device.pair.setupCode", {
              setupId: "setup-missed",
              setupCode,
              access: "full",
              expiresAtMs: Date.now() + 2_000,
              auth: "token",
              gatewayUrl: "wss://gateway.example.test",
              urlSource: "test",
              qrDataUrl,
            });
            await gateway.setMethodResponse("device.pair.setupStatus", {
              completion: {
                setupId: "setup-missed",
                deviceId: "phone-missed",
                deviceName: "Recovered iPhone",
                access: "full",
                ts: 5,
              },
            });
            await page.getByRole("button", { name: "Create setup code" }).click();
            const qr = page.getByAltText("OpenClaw mobile pairing QR code");
            await qr.waitFor();
            await page.getByText("Recovered iPhone", { exact: true }).waitFor();
            expect(await qr.count()).toBe(0);
            expect(await page.getByText("Setup code expired", { exact: true }).count()).toBe(0);
            expect((await gateway.getRequests("device.pair.setupStatus")).at(-1)?.params).toEqual({
              setupId: "setup-missed",
            });
            await captureUiProof(page, "06-desktop-reconciled-success.png");
            await page.getByRole("button", { name: "Done" }).click();
            await dialog.waitFor({ state: "hidden" });
            await gateway.setMethodResponse("device.pair.setupStatus", {});
          }
        }
        const scrollBody = setup.locator(".device-pair-setup__body");
        await scrollBody.hover();
        await page.mouse.wheel(0, 1000);
        await expect
          .poll(() => scrollBody.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(0);
        const footer = await setup.locator(".device-pair-setup__footer").boundingBox();
        expect(footer).not.toBeNull();
        expect(footer!.y + footer!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
        await page.getByRole("button", { name: "Manage devices", exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/devices");
        expect(pageErrors).toEqual([]);
      },
    );
  });
});
