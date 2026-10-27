import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";
import { waitForGatewayRecoveryScope } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Gateway status with native account identity" });
const withPage = (
  width: number,
  run: Parameters<typeof suite.withPage>[1],
  options: Parameters<typeof suite.withPage>[0] = {},
) =>
  suite.withPage(
    { locale: "en-US", serviceWorkers: "block", viewport: { width, height: 900 }, ...options },
    run,
  );

suite.define(() => {
  it("keeps shared chat usable without polling operator-only surfaces", async () => {
    await withPage(
      1280,
      async ({ page }) => {
        await page.clock.install();
        const sessionKey = "agent:main:scope-reader";
        const operatorMethods = [
          "presence.activity",
          "cron.list",
          "cron.status",
          "talk.catalog",
          "taskSuggestions.list",
          "mcp.app.discover",
          "models.authStatus",
          "config.get",
        ];
        const forbidden = {
          __mockError: { code: "FORBIDDEN", message: "Operator access required" },
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          operatorScopes: ["operator.sessions.read"],
          featureMethods: [...defaultControlUiFeatureMethods, ...operatorMethods],
          historyMessages: [
            { role: "assistant", content: [{ type: "text", text: "Shared discussion" }] },
          ],
          methodResponses: Object.fromEntries(operatorMethods.map((method) => [method, forbidden])),
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.getByText("Shared discussion", { exact: true }).waitFor();
        for (let minute = 0; minute < 15; minute++) {
          await gateway.emitGatewayEvent("cron", {});
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await page.clock.runFor(60_000);
        }
        const requests = await gateway.getRequests();
        expect(requests.filter((request) => operatorMethods.includes(request.method))).toEqual([]);
        expect(requests.some((request) => request.method === "sessions.messages.subscribe")).toBe(
          true,
        );
        await page.goto(`${suite.server.baseUrl}cron`);
        await page
          .getByText(
            "You don't have permission to view scheduled tasks. Ask the person who manages OpenClaw for access.",
            { exact: true },
          )
          .waitFor();
        expect(await gateway.getRequests("cron.list")).toHaveLength(0);

        await gateway.setOperatorScopes(["operator.admin"]);
        await gateway.closeLatest();
        await page.clock.runFor(5_000);
        await gateway.waitForRequest("cron.list");
      },
      { colorScheme: "dark", serviceWorkers: "allow", viewport: { width: 1280, height: 1000 } },
    );
  });

  it("keeps initial recovery from moving the session frame and shows later reconnect recovery", async () => {
    await withPage(
      390,
      async ({ page }) => {
        const recoveryToken = "gateway-status-recovery-test";
        await page.addInitScript((token) => {
          const digest = crypto.subtle.digest.bind(crypto.subtle);
          crypto.subtle.digest = async (algorithm, data) => {
            if (new TextDecoder().decode(data) === token) {
              await new Promise<void>((resolve) => {
                window.addEventListener("test-release-status-recovery", () => resolve(), {
                  once: true,
                });
              });
            }
            return digest(algorithm, data);
          };
        }, recoveryToken);
        const sessionKey = "agent:main:recovery-layout";
        const gateway = await installMockGateway(page, {
          deviceToken: recoveryToken,
          sessionKey,
          sessionTranscripts: {
            [sessionKey]: {
              messages: Array.from({ length: 4 }, (_, index) => ({
                role: index % 2 ? "assistant" : "user",
                content: [{ type: "text", text: `Recovery frame ${index + 1}` }],
              })),
            },
          },
          sessions: [
            { key: sessionKey, label: "Recovery layout", kind: "direct", updatedAt: 1000 },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await waitForControlUiGatewayReady(page);
        await waitForGatewayRecoveryScope(page, false);
        await page.getByText("Recovery frame 4", { exact: true }).waitFor({ state: "visible" });
        const header = page.locator(".agent-chat__header--mobile");
        const initialHeaderY = await header.evaluate(
          (element) => element.getBoundingClientRect().y,
        );
        const connectionStatus = page.locator(".mobile-header__notices:visible");
        const content = page.locator("main.content");
        const initialContentBounds = await content.boundingBox();
        expect(initialContentBounds).not.toBeNull();
        expect(await connectionStatus.count()).toBe(0);

        await page.evaluate(() => window.dispatchEvent(new Event("test-release-status-recovery")));
        await waitForGatewayRecoveryScope(page);
        expect(await connectionStatus.count()).toBe(0);
        const readyHeaderY = await header.evaluate((element) => element.getBoundingClientRect().y);
        const readyHeaderBounds = await header.boundingBox();
        expect(Math.abs(readyHeaderY - initialHeaderY)).toBeLessThanOrEqual(0.1);
        expect(await content.boundingBox()).toEqual(initialContentBounds);

        const connectCount = (await gateway.getRequests("connect")).length;
        await gateway.closeLatest(1001, "synthetic recovery");
        await gateway.waitForRequest("connect", { after: connectCount });
        await waitForControlUiGatewayReady(page);
        await waitForGatewayRecoveryScope(page, false);
        await connectionStatus
          .getByText("Restoring…", { exact: true })
          .waitFor({ state: "visible" });
        expect(await content.boundingBox()).toEqual(initialContentBounds);
        expect(await header.boundingBox()).toEqual(readyHeaderBounds);
        expect(await page.locator(".sidebar-connection-flag").isVisible()).toBe(false);
        await page.evaluate(() => window.dispatchEvent(new Event("test-release-status-recovery")));
        await waitForGatewayRecoveryScope(page);
        await connectionStatus.waitFor({ state: "detached" });
        expect(await content.boundingBox()).toEqual(initialContentBounds);
      },
      { colorScheme: "dark", reducedMotion: "no-preference" },
    );
  });

  it("briefly reveals collapsed-rail status and reopens it for pointer and keyboard access", async () => {
    await withPage(1920, async ({ page }) => {
      await installNativeWebChrome(page);
      const gateway = await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiGatewayReady(page);
      await page.locator(".agent-chat__composer-combobox textarea").waitFor({ state: "visible" });
      await openChatDetails(page);
      await gateway.emitGatewayEvent("ui.command", {
        command: { kind: "sidebar", visible: false },
      });
      await page.locator(".shell--nav-collapsed").waitFor({ state: "visible" });
      const composer = page.locator(".chat-footer .agent-chat__composer-shell");
      const identity = page.locator(".sidebar-identity-card");
      const flag = page.locator(".sidebar-connection-flag");
      const flagRight = async () =>
        (await identity.boundingBox())!.x +
        (await identity.boundingBox())!.width +
        (await flag.boundingBox())!.width;
      await expect
        .poll(async () => (await composer.boundingBox())!.x - (await flagRight()))
        .toBeGreaterThanOrEqual(0);
      await page.clock.install();
      // Keep the four-second reveal window independent of assertion time on slow runners.
      await pauseVirtualClock(page);
      await gateway.setOnline(false);
      // Offline presentation waits for the gateway's two-second grace period.
      await page.clock.runFor(2_001);
      const retainedStatus = page.locator(
        ".sidebar-identity-card[data-connection-status=reconnecting]",
      );
      await retainedStatus.waitFor({ state: "visible" });
      expect(await retainedStatus.getAttribute("aria-label")).toContain("Reconnecting…");
      await expect
        .poll(async () => (await composer.boundingBox())!.x - (await flagRight()))
        .toBeGreaterThanOrEqual(0);
      const identityTooltip = page
        .getByRole("tooltip")
        .filter({ hasText: "Identity and app menu for Owner:" });
      const recovery = flag.locator(".gateway-status");
      await recovery.waitFor({ state: "visible" });
      expect(await retainedStatus.getAttribute("title")).toBe("");
      await page.clock.runFor(4_001);
      await flag.waitFor({ state: "hidden" });
      await page.clock.resume();
      await retainedStatus.hover();
      await recovery.waitFor({ state: "visible" });
      await page.clock.runFor(200);
      expect(await identityTooltip.count()).toBe(0);
      expect(await retainedStatus.getAttribute("aria-label")).toContain("Reconnecting…");
      expect(
        await recovery.evaluate((button) => {
          const bounds = button.getBoundingClientRect();
          return button.contains(
            document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
          );
        }),
      ).toBe(true);
      await page.mouse.move(600, 400);
      await flag.waitFor({ state: "hidden" });
      await pauseVirtualClock(page);
      await gateway.closeLatest(1006, "synthetic failed attempt");
      await retainedStatus.focus();
      await recovery.waitFor({ state: "visible" });
      await page.keyboard.press("Tab");
      expect(await recovery.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.clock.resume();

      await composer.locator("textarea").focus();
      await page.setViewportSize({ width: 1280, height: 900 });
      await openChatDetails(page);
      await expect
        .poll(async () => (await composer.boundingBox())!.x - (await flagRight()))
        .toBeLessThan(0);
      await retainedStatus.hover();
      await page.clock.runFor(200);
      await flag.waitFor({ state: "hidden" });
      await identityTooltip.waitFor({ state: "visible" });
      await retainedStatus.focus();
      expect(await flag.isVisible()).toBe(false);
      expect(await retainedStatus.getAttribute("aria-label")).toContain("Reconnecting…");
      await closeChatDetails(page);
      await page.setViewportSize({ width: 900, height: 900 });
      await page.mouse.move(600, 400);
      await expect
        .poll(async () => (await composer.boundingBox())!.x - (await flagRight()))
        .toBeLessThan(0);
      await retainedStatus.hover();
      await page.clock.runFor(200);
      expect(await flag.isVisible()).toBe(false);
      await identityTooltip.waitFor({ state: "visible" });
    });
  });

  it("shows reconnect once with queued messages and keeps the account menu usable", async () => {
    await withPage(
      1280,
      async ({ page }) => {
        await page.addInitScript(() => {
          Object.assign(window, {
            __OPENCLAW_NATIVE_GATEWAYS__: {
              currentId: "profile:studio",
              gateways: [
                {
                  id: "profile:studio",
                  name: "Studio Gateway",
                  kind: "remote",
                  isPrimary: false,
                  canPromote: true,
                  health: "unknown",
                },
              ],
            },
            webkit: { messageHandlers: { openclawGateways: { postMessage() {} } } },
          });
        });
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ self: true, id: "alex", name: "Alex", email: "alex@example.test" }],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiGatewayReady(page);
        expect((await gateway.getRequests("connect")).length).toBeGreaterThan(0);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        const content = page.locator("main.content");
        const connectedContentBounds = await content.boundingBox();
        expect(connectedContentBounds).not.toBeNull();
        await gateway.setOnline(false);
        for (const message of ["First synthetic draft", "Second synthetic draft"]) {
          await composer.fill(message);
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          await expect.poll(() => composer.inputValue()).toBe("");
        }
        const footer = page.locator(".sidebar-footer-bar");
        const connectionStatus = page.locator(".sidebar-shell__footer .gateway-status");
        await expect.poll(() => page.locator(".chat-queue__item").count()).toBe(2);
        await connectionStatus.getByText("Reconnecting… · 2 queued", { exact: true }).waitFor();
        expect(await connectionStatus.getByRole("button").count()).toBe(0);
        expect(await connectionStatus.count()).toBe(1);
        expect(await connectionStatus.locator(".gateway-status__label").textContent()).toBe(
          "Reconnecting… · 2 queued",
        );
        expect(await content.boundingBox()).toEqual(connectedContentBounds);
        expect((await connectionStatus.boundingBox())!.height).toBe(44);
        const identityStatus = footer.locator(".sidebar-identity-card");
        expect(await identityStatus.isVisible()).toBe(true);
        expect(await identityStatus.getAttribute("data-connection-status")).toBe("reconnecting");
        expect(await identityStatus.locator(".sidebar-identity-card__status").isVisible()).toBe(
          true,
        );
        expect(await footer.locator(".gateway-status").count()).toBe(0);
        expect(await identityStatus.getAttribute("aria-label")).toContain("Reconnecting…");
        expect(await identityStatus.textContent()).toContain("Alex");
        expect(await identityStatus.locator("[role=status]").count()).toBe(0);
        const announcement = page.locator(".shell > .sr-only[role=status]");
        expect(await announcement.count()).toBe(1);
        expect(await announcement.textContent()).toBe("Reconnecting… · 2 queued");
        expect(await connectionStatus.getAttribute("role")).toBeNull();
        expect(await footer.textContent()).not.toContain("in outbox");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        await page.setViewportSize({ width: 390, height: 844 });
        const mobileStatus = page.locator(".mobile-header__notices:visible");
        await mobileStatus.waitFor({ state: "visible" });
        // The drawer stays mounted for its slide; Playwright visibility ignores off-screen placement.
        await expect
          .poll(() => connectionStatus.evaluate((element) => element.getBoundingClientRect().right))
          .toBeLessThanOrEqual(0);
        expect(
          await connectionStatus.evaluate((element) => {
            element.focus();
            return {
              inert: element.closest("[inert]") !== null,
              focused: document.activeElement === element,
            };
          }),
        ).toEqual({ inert: true, focused: false });
        expect(await page.locator(".sidebar-connection-flag").isVisible()).toBe(false);
        expect(await mobileStatus.textContent()).toBe("Reconnecting…");
        expect(await page.locator(".chat-queue__item").count()).toBe(2);
        expect(await announcement.textContent()).toBe("Reconnecting… · 2 queued");
        // The shell owns the single live announcement, including queued messages.
        expect(await mobileStatus.getAttribute("role")).toBeNull();
        expect(await mobileStatus.getAttribute("aria-live")).toBeNull();
        await page.setViewportSize({ width: 1280, height: 900 });
        await footer.waitFor({ state: "visible" });

        await identityStatus.click();
        const menu = page.locator(".sidebar-identity-menu");
        await menu.getByText("Alex", { exact: true }).waitFor();
        await menu.getByRole("menuitem", { name: "Studio Gateway", exact: true }).waitFor();
        expect(await menu.locator(".sidebar-identity-menu__outbox").count()).toBe(0);
        expect(await page.locator(".chat-queue__item").count()).toBe(2);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "hidden" });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "Expand sidebar" }).click();
        await connectionStatus.waitFor({ state: "visible" });
        expect(await connectionStatus.count()).toBe(1);
        expect(await mobileStatus.isVisible()).toBe(false);
        await identityStatus.click();
        await menu.getByText("Alex", { exact: true }).waitFor();
        expect(await menu.locator('[data-value="command:retry-connect"]').count()).toBe(0);
        expect(await menu.locator(".sidebar-identity-menu__outbox").count()).toBe(0);
        expect(await footer.textContent()).not.toContain("in outbox");
        await page.keyboard.press("Escape");
        await gateway.setOnline(true);
        await waitForControlUiGatewayReady(page);
        await connectionStatus.waitFor({ state: "detached" });
        await expect
          .poll(() => identityStatus.getAttribute("data-connection-status"))
          .toBe("connected");
        expect(await announcement.textContent()).toBe("Connected");
        expect(await identityStatus.textContent()).toContain("Alex");
      },
      { colorScheme: "dark", viewport: { width: 1280, height: 808 } },
    );
  });
});
