// Control UI tests cover the responsive disconnected login gate.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { BrowserContextOptions, Page } from "playwright";
import { assert, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";
import { renderLoginGate } from "./login-gate-e2e.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI responsive login gate E2E",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});
async function newPage(options: BrowserContextOptions = {}) {
  const context = await suite.newBrowserContext({
    viewport: { height: 900, width: 1280 },
    ...options,
  });
  return context.newPage();
}

const authRequiredError = {
  code: "INVALID_REQUEST",
  message: "token missing",
  details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING },
};

async function expectReconnecting(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.openclawControlUi?.snapshot().gatewayPhase))
    .toBe("reconnecting");
  expect(await page.locator(".connection-action-block").count()).toBe(0);
  expect(await page.locator("#control-ui-main").getAttribute("inert")).toBeNull();
  expect(await page.locator("openclaw-router-outlet").getAttribute("inert")).toBeNull();
  expect(await page.locator("openclaw-router-outlet").getAttribute("aria-disabled")).toBeNull();
}

suite.define(() => {
  it("counts down and automatically enters a reachable Gateway after refused upgrades", async () => {
    const page = await newPage();
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
    const gateway = await installMockGateway(page, { awaitInitialRoster: false });
    await page.route("**/healthz", (route) =>
      route.fulfill({ status: 200, json: { ok: true, status: "live" } }),
    );
    await page.addInitScript(() => {
      class RefusedWebSocket extends EventTarget {
        readyState: WebSocket["readyState"] = WebSocket.CONNECTING;

        send() {
          throw new Error("Upgrade failed before WebSocket open");
        }

        close() {
          this.readyState = WebSocket.CLOSED;
        }
      }
      let refused = 0;
      window.WebSocket = new Proxy(window.WebSocket, {
        construct(target, args) {
          if (refused++ >= 2) {
            return Reflect.construct(target, args);
          }
          const socket = new RefusedWebSocket();
          queueMicrotask(() => {
            socket.readyState = WebSocket.CLOSED;
            socket.dispatchEvent(new Event("error"));
            socket.dispatchEvent(new CloseEvent("close", { code: 1006 }));
          });
          return socket;
        },
      });
    });

    await page.goto(suite.server.baseUrl);
    await page.clock.runFor(1);
    const failure = page.locator('.login-gate__failure[data-kind="busy"]');
    await failure.waitFor();
    expect((await failure.locator(".login-gate__failure-title").textContent())?.trim()).toBe(
      "Gateway busy, retrying…",
    );
    expect(await gateway.getRequests("connect")).toHaveLength(0);

    const retryHealthResponse = page.waitForResponse("**/healthz");
    await page.clock.runFor(1_000);
    // The first probe's busy state can survive while the retry probe is still in flight.
    // Finish its real response before advancing the virtual one-second abort deadline.
    expect(await (await retryHealthResponse).finished()).toBeNull();
    const countdown = failure.locator(".login-gate__retry");
    await countdown.filter({ hasText: "Retrying in 2s…" }).waitFor();
    await page.clock.runFor(1_000);
    expect((await countdown.textContent())?.trim()).toBe("Retrying in 1s…");
    expect(await page.locator("openclaw-app-shell").count()).toBe(0);

    await page.clock.runFor(1_000);
    await gateway.waitForRequest("connect");
    await page.clock.runFor(1);
    await page.locator("openclaw-app-shell").waitFor();
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);
    expect(await gateway.getRequests("connect")).toHaveLength(1);
  });

  it("reloads a protocol mismatch once, then keeps visible manual recovery", async () => {
    const page = await newPage();
    const artifactDir = createControlUiE2eArtifactDir("protocol-mismatch-recovery");
    const documents: string[] = [];
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        documents.push(request.url());
      }
    });
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });
    const mismatch = {
      code: "INVALID_REQUEST",
      message: "protocol mismatch",
      details: {
        code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
        gatewayBuildId: "protocol-build",
        reloadRequired: true,
      },
    };
    await page.goto(suite.server.baseUrl);
    await gateway.waitForRequest("connect");
    const reloaded = page.waitForEvent("domcontentloaded");
    await gateway.rejectDeferred("connect", mismatch);
    await reloaded;
    await expect.poll(() => documents.length).toBe(2);
    expect(new URL(documents[1]!).searchParams.has("openclaw_mount_recovery")).toBe(true);

    await gateway.waitForRequest("connect");
    await page.clock.install();
    await gateway.rejectDeferred("connect", mismatch);
    const failure = page.locator('.login-gate__failure[data-kind="protocol-mismatch"]');
    await failure.waitFor();
    expect((await failure.textContent())?.toLowerCase()).toContain("supported connection protocol");
    const refresh = failure.locator(".login-gate__failure-refresh");
    expect(await refresh.isVisible()).toBe(true);
    await page.clock.runFor(120_000);
    expect(documents).toHaveLength(2);
    expect(await gateway.getRequests("connect")).toHaveLength(1);
    await page.clock.resume();
    const before = await takeControlUiScreenshotFrame(page, failure, [refresh], {
      animations: "disabled",
    });
    await writeFile(path.join(artifactDir, "before-manual-recovery.png"), before.png);

    const refreshed = page.waitForEvent("domcontentloaded");
    await refresh.click();
    await refreshed;
    await expect.poll(() => documents.length).toBe(3);
    await gateway.waitForRequest("connect");
    await gateway.resolveDeferred("connect");
    const shell = page.locator("openclaw-app-shell");
    await shell.waitFor();
    await expect.poll(() => page.locator("openclaw-login-gate").count()).toBe(0);
    const after = await takeControlUiScreenshotFrame(page, shell, [page.locator(".shell")], {
      animations: "disabled",
    });
    await writeFile(path.join(artifactDir, "after-manual-recovery.png"), after.png);
  });

  it("lets reload-required recovery outrank a manually pinned login gate", async () => {
    const page = await newPage();
    await page.addInitScript(() => {
      sessionStorage.setItem(
        "openclaw.controlUi.staleChunkReloadBuildId",
        JSON.stringify({ buildId: "replacement-build", at: Date.now() }),
      );
    });
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    await page.goto(suite.server.baseUrl);
    await gateway.waitForRequest("connect");
    await gateway.rejectDeferred("connect", authRequiredError);
    await page.locator('.login-gate__failure[data-kind="auth-required"]').waitFor();

    await gateway.deferNext("connect");
    await page.getByRole("button", { name: "Connect" }).click();
    await expect.poll(async () => (await gateway.getRequests("connect")).length).toBe(2);
    await gateway.rejectDeferred("connect", {
      code: "UNAVAILABLE",
      message: "protocol mismatch: Control UI updated; reload this page to continue",
      details: {
        code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
        gatewayBuildId: "replacement-build",
        reloadRequired: true,
      },
      retryable: false,
    });

    await expect
      .poll(() =>
        page.evaluate(() => {
          return window.openclawControlUi?.snapshot().gatewayPhase;
        }),
      )
      .toBe("reload-required");
    await page.getByRole("button", { name: /Server updated/u }).waitFor();
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);
  });

  it("keeps the session header available while disabling Gateway actions on reconnect", async () => {
    const page = await newPage();
    const sessionKey = "agent:main:main";
    const gateway = await installMockGateway(page, { sessionKey });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
    const header = page.locator(".chat-pane__header");
    await header.waitFor({ state: "visible" });
    const actions = header.locator(".chat-header-session-menu__trigger");
    await actions.click();
    const split = page.getByRole("menuitem", { name: "Open split view", exact: true });
    expect(await split.isEnabled()).toBe(true);
    await page.keyboard.press("Escape");
    await split.waitFor({ state: "hidden" });
    const panels = page
      .locator(".sidebar-region__panels-toggle")
      .getByRole("button", { name: "Panels", exact: true });
    if ((await panels.getAttribute("aria-expanded")) !== "true") {
      await panels.click();
    }
    const sideHeader = page.locator('[data-region-header="side"]');
    await sideHeader.waitFor();
    await gateway.setOnline(false);

    await expectReconnecting(page);
    const outlet = page.locator("openclaw-router-outlet");
    expect(await outlet.getAttribute("aria-disabled")).toBeNull();
    expect(await header.isVisible()).toBe(true);

    expect(await actions.isVisible()).toBe(false);
    expect(await header.getByRole("button", { name: "Details", exact: true }).isEnabled()).toBe(
      true,
    );
    const position = sideHeader.getByRole("button", { name: "Panel position", exact: true });
    expect(await position.isEnabled()).toBe(true);
    await position.click();
    await page.getByRole("menuitemradio", { name: "Right", exact: true }).click();
    await page.locator(".side-panel-position-menu").waitFor({ state: "hidden" });
    await sideHeader.getByRole("button", { name: "Expand Side panel", exact: true }).click();
    await sideHeader.getByRole("button", { name: "Restore split", exact: true }).click();
    expect(await header.isVisible()).toBe(true);
    await panels.click();
    await sideHeader.waitFor({ state: "hidden" });
    await gateway.setOnline(true);
    await actions.waitFor();
    await actions.click();
    expect(await split.isEnabled()).toBe(true);
    await page.keyboard.press("Escape");
    await split.waitFor({ state: "hidden" });
  });

  it.each([
    { name: "desktop", width: 1280 },
    { name: "tablet", width: 900 },
    { name: "phone", width: 390 },
  ])("keeps the $name settings viewport interactive while reconnecting", async ({ width }) => {
    const page = await newPage({ viewport: { height: 900, width } });
    const gateway = await installMockGateway(page);

    await page.goto(new URL("settings/talk", suite.server.baseUrl).href);
    await page.locator("openclaw-app-shell").waitFor();
    await page.locator("openclaw-config-page .content-header").waitFor();
    await gateway.deferNext("connect");
    await gateway.closeLatest(1012, "test reconnect");

    await expectReconnecting(page);
    expect(await page.locator("openclaw-config-page .content-header").isVisible()).toBe(true);
  });

  it("retries pending pairing and enters the app after approval without clicks", async () => {
    const page = await newPage();
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });
    const pairingError = {
      code: "NOT_PAIRED",
      message: "pairing required (requestId: req-pending)",
      details: {
        code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
        recommendedNextStep: "wait_then_retry",
        retryable: true,
        pauseReconnect: false,
      },
    };

    await page.goto(suite.server.baseUrl);
    await gateway.waitForRequest("connect");
    await gateway.deferNext("connect");
    await gateway.rejectDeferred("connect", pairingError);
    const failure = page.locator('.login-gate__failure[data-kind="pairing-required"]');
    await failure.waitFor();
    await gateway.waitForRequest("connect", { after: 1 });
    expect(await failure.textContent()).toContain(
      "Waiting for approval… this page connects on its own once the request is approved.",
    );
    expect(await failure.getByRole("button", { name: "Check now", exact: true }).isEnabled()).toBe(
      true,
    );
    expect(await page.locator("openclaw-app-shell").count()).toBe(0);

    await gateway.deferNext("connect");
    await gateway.rejectDeferred("connect", pairingError);
    await gateway.waitForRequest("connect", { after: 2 });
    expect(await failure.isVisible()).toBe(true);
    await gateway.resolveDeferred("connect");
    await page.locator("openclaw-app-shell").waitFor();
    expect(await page.locator("openclaw-login-gate").count()).toBe(0);
  });

  it.each(["rejected", "expired"])(
    "shows a terminal pairing %s until Request again",
    async (decision) => {
      const page = await newPage();
      await page.clock.install();
      const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });
      await page.goto(suite.server.baseUrl);
      const request = await gateway.waitForRequest("connect");
      assert(isRecord(request.params) && isRecord(request.params.device));
      const deviceId = request.params.device.id;
      assert(typeof deviceId === "string");
      await gateway.rejectDeferred("connect", {
        code: "NOT_PAIRED",
        message: "pairing required",
        details: {
          code: "PAIRING_REQUIRED",
          requestId: "waiting-request",
          deviceId,
          waitForResolution: true,
          pauseReconnect: false,
        },
      });
      await page.getByRole("button", { name: "Check now", exact: true }).waitFor();
      await page.clock.runFor(60_000);
      expect(await gateway.getRequests("connect")).toHaveLength(1);
      await gateway.emitGatewayEvent("device.pair.resolved", {
        requestId: "waiting-request",
        deviceId,
        decision,
        ts: Date.now(),
      });
      await page
        .getByText(decision === "rejected" ? "Access request declined" : "Access request expired", {
          exact: true,
        })
        .waitFor();
      await page.evaluate(() => {
        window.dispatchEvent(new Event("online"));
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      await page.clock.runFor(60_000);
      expect(await gateway.getRequests("connect")).toHaveLength(1);
      expect(await page.getByText("Waiting for approval", { exact: false }).count()).toBe(0);
      await gateway.deferNext("connect");
      await page.getByRole("button", { name: "Request again", exact: true }).click();
      await gateway.waitForRequest("connect", { after: 1 });
      await gateway.resolveDeferred("connect");
      await page.locator("openclaw-app-shell").waitFor();
    },
  );

  it("retires the static startup fallback after rendering auth-required guidance", async () => {
    const page = await newPage();
    await page.addInitScript(() => {
      window.addEventListener("openclaw-control-ui-rendered", () => {
        const key = "openclaw.control-ui-e2e.render-count";
        const count = Number.parseInt(sessionStorage.getItem(key) ?? "0", 10);
        sessionStorage.setItem(key, String(count + 1));
      });
    });
    await page.clock.install();
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    await page.goto(suite.server.baseUrl);
    await gateway.waitForRequest("connect");
    await gateway.rejectDeferred("connect", authRequiredError);

    const authRequired = page.locator('.login-gate__failure[data-kind="auth-required"]');
    await authRequired.waitFor({ timeout: 10_000 });
    await page.clock.runFor(12_001);

    expect(await authRequired.isVisible()).toBe(true);
    expect(await page.locator("#openclaw-mount-fallback").isHidden()).toBe(true);
    expect((await page.locator("body").getAttribute("class")) ?? "").not.toContain(
      "openclaw-mount-fallback-active",
    );
    expect(
      await page.evaluate(() => sessionStorage.getItem("openclaw.control-ui-e2e.render-count")),
    ).toBe("1");
  });

  it("keeps mobile controls compact, touchable, and keyboard-friendly", async () => {
    const page = await newPage({
      hasTouch: true,
      isMobile: true,
      viewport: { height: 500, width: 375 },
    });

    const gateway = await renderLoginGate(page, suite.server.baseUrl);
    const gatewayInput = page.locator(".login-gate__form .field input").first();
    expect(await gatewayInput.getAttribute("inputmode")).toBe("url");
    expect(await gatewayInput.getAttribute("autocapitalize")).toBe("none");
    expect(await gatewayInput.getAttribute("autocorrect")).toBe("off");
    expect(await gatewayInput.getAttribute("spellcheck")).toBe("false");
    expect(await gatewayInput.getAttribute("enterkeyhint")).toBe("go");

    // Editing the production form rerenders the root while preserving its connection action.
    const originalUrl = await gatewayInput.inputValue();
    await gatewayInput.fill(`${originalUrl}/edited`);
    await gatewayInput.fill(originalUrl);
    await gateway.deferNext("connect");
    await gatewayInput.press("Enter");
    await gateway.waitForRequest("connect", { after: 1 });
    expect(await gateway.getRequests("connect")).toHaveLength(2);
    await gateway.rejectDeferred("connect", authRequiredError);
    await page.locator('.login-gate__failure[data-kind="auth-required"]').waitFor();

    const failure = page.locator(".login-gate__failure");
    expect(await failure.evaluate((element) => element.tagName)).toBe("SECTION");
    expect(await page.locator(".login-gate__failure-summary").isVisible()).toBe(true);
    expect(await page.locator(".login-gate__failure-steps").isVisible()).toBe(true);
    expect(await page.locator(".login-gate__failure-docs").isVisible()).toBe(true);
    expect(await page.locator(".login-gate__help").count()).toBe(0);

    const metrics = await page.evaluate(() => {
      const get = (selector: string) => document.querySelector<HTMLElement>(selector)!;
      const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
      const gate = get(".login-gate");
      const card = get(".login-gate__card");
      const style = (element: Element) => getComputedStyle(element);
      return {
        cardPadding: style(card).padding,
        cardTop: card.getBoundingClientRect().top,
        commandBounds: all(".login-gate__failure-steps .login-gate__command").map((command) => {
          const { left, right } = command.getBoundingClientRect();
          return { left, right };
        }),
        connectMinHeight: style(get(".login-gate__connect")).minHeight,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        gateClientHeight: gate.clientHeight,
        gateOverflowY: style(gate).overflowY,
        gatePadding: style(gate).padding,
        gateScrollHeight: gate.scrollHeight,
        inputMinHeights: all(".login-gate__form .field input").map(
          (input) => style(input).minHeight,
        ),
        toggleSizes: all(".login-gate__form .settings-secret__toggle").map((toggle) => {
          const { height, width } = style(toggle);
          return { height, width };
        }),
      };
    });

    expect(metrics).toMatchObject({
      gatePadding: "16px",
      cardPadding: "20px 20px 24px",
      connectMinHeight: "44px",
      gateOverflowY: "auto",
      inputMinHeights: ["44px", "44px"],
    });
    expect(metrics.cardTop).toBeGreaterThanOrEqual(0);
    expect(metrics.documentScrollWidth).toBe(metrics.documentClientWidth);
    expect(metrics.commandBounds.length).toBeGreaterThan(0);
    expect(metrics.commandBounds.every(({ left, right }) => left >= 0 && right <= 375)).toBe(true);
    expect(metrics.gateScrollHeight).toBeGreaterThan(metrics.gateClientHeight);
    expect(metrics.toggleSizes).toHaveLength(1);
    expect(
      metrics.toggleSizes.every(({ height, width }) => height === "32px" && width === "32px"),
    ).toBe(true);

    const failureDocs = page.locator(".login-gate__failure-docs");
    await failureDocs.scrollIntoViewIfNeeded();
    const failureDocsBox = await failureDocs.boundingBox();
    if (!failureDocsBox) {
      throw new Error("Missing failure documentation link bounds");
    }
    expect(failureDocsBox.y + failureDocsBox.height).toBeLessThanOrEqual(500);
  });

  it("keeps generic help collapsed until requested when there is no failure", async () => {
    const page = await newPage();
    const chatModule = await holdModuleResponse(
      page,
      controlUiE2eBuiltModuleRequest("ui/src/pages/chat/route-entry.ts"),
    );
    const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });

    try {
      await page.goto(suite.server.baseUrl);
      await gateway.waitForRequest("connect");
      await gateway.rejectDeferred("connect", authRequiredError);
      await page.locator('.login-gate__failure[data-kind="auth-required"]').waitFor();
      const chatModuleUrl = await chatModule.request;
      const priorConnects = await gateway.deferNext("connect");
      // Retry clears the owner error and pins the gate while the handshake is held.
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await gateway.waitForRequest("connect", { after: priorConnects });
      expect(await page.locator("openclaw-chat-page").count()).toBe(0);

      const help = page.locator(".login-gate__help");
      expect(await help.evaluate((element) => element.tagName)).toBe("DETAILS");
      expect(await page.locator(".login-gate__failure").count()).toBe(0);
      expect(await help.getAttribute("open")).toBeNull();
      expect(await page.locator(".login-gate__steps").isVisible()).toBe(false);
      chatModule.release();
      await page.evaluate(`import(${JSON.stringify(chatModuleUrl)}).then(() => undefined)`);
      await page.waitForFunction(() => window.openclawControlUi?.snapshot().booted === true);
      await help.locator("summary").click();
      expect(await page.locator(".login-gate__steps").isVisible()).toBe(true);
    } finally {
      chatModule.release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

  it.each([false, true])(
    "applies safe-area insets exactly once (standalone: %s)",
    async (standalone) => {
      const page = await newPage({
        hasTouch: true,
        isMobile: true,
        viewport: { height: 500, width: 375 },
      });
      await renderLoginGate(page, suite.server.baseUrl);
      const metrics = await page.evaluate((installed) => {
        const root = document.documentElement;
        root.style.setProperty("--safe-area-top", "34px");
        root.style.setProperty("--safe-area-right", "20px");
        root.style.setProperty("--safe-area-bottom", "21px");
        root.style.setProperty("--safe-area-left", "18px");
        if (installed) {
          // Installed-mode contract simulation, not a native iPhone capture.
          for (const sheet of document.styleSheets) {
            for (const rule of sheet.cssRules) {
              if (rule instanceof CSSMediaRule) {
                rule.media.mediaText = rule.conditionText.replaceAll(
                  "(display-mode: standalone)",
                  "(min-width: 0px)",
                );
              }
            }
          }
        }
        const app = document.querySelector("openclaw-app");
        const gate = app?.querySelector<HTMLElement>(".login-gate");
        if (!app || !gate) {
          throw new Error("Missing production login gate wrapper");
        }
        const bounds = gate.getBoundingClientRect();
        return {
          bodyPadding: getComputedStyle(document.body).padding,
          appPadding: getComputedStyle(app).padding,
          gatePadding: getComputedStyle(gate).padding,
          top: bounds.top,
          bottom: bounds.bottom,
          left: bounds.left,
          right: bounds.right,
        };
      }, standalone);
      expect(metrics).toEqual({
        bodyPadding: "0px",
        appPadding: "34px 20px 21px 18px",
        gatePadding: "16px",
        top: 34,
        bottom: 479,
        left: 18,
        right: 355,
      });
      const docs = page.locator(".login-gate__failure-docs");
      await docs.scrollIntoViewIfNeeded();
      const docsBounds = await docs.boundingBox();
      expect(docsBounds).not.toBeNull();
      expect(docsBounds!.y + docsBounds!.height).toBeLessThanOrEqual(479);
      const input = page.locator(".login-gate__form .field input").first();
      await input.focus();
      const resizeViewport = async (height: number) =>
        page.evaluate(async (visibleHeight) => {
          const viewport = window.visualViewport!;
          Object.defineProperty(viewport, "height", { configurable: true, value: visibleHeight });
          viewport.dispatchEvent(new Event("resize"));
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          });
          return {
            height: document.querySelector("openclaw-app")!.getBoundingClientRect().height,
            bottomInset: document.documentElement.style.getPropertyValue(
              "--shell-safe-area-bottom",
            ),
          };
        }, height);
      expect(await resizeViewport(300)).toEqual({ height: 300, bottomInset: "0px" });
      await input.scrollIntoViewIfNeeded();
      const inputBounds = await input.boundingBox();
      expect(inputBounds!.y + inputBounds!.height).toBeLessThanOrEqual(300);
      expect(await resizeViewport(500)).toEqual({ height: 500, bottomInset: "" });
      expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
    },
  );
});
