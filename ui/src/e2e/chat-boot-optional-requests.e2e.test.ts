import { expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat boot optional requests" });
suite.define(() => {
  it("loads transcript images with rows while deferring optional surfaces and hidden artwork", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const requested: string[] = [];
        page.on("request", (request) => requested.push(new URL(request.url()).pathname));
        const loginModuleRequest = controlUiE2eBuiltModuleRequest(
          "ui/src/components/login-gate-solid.tsx",
        );
        const loginRequests = () => requested.filter((path) => loginModuleRequest.test(path));
        const imageModule = controlUiE2eBuiltModuleRequest(
          "ui/src/pages/chat/components/chat-message-images-solid.tsx",
        );
        const mediaModules = ["chat-message-attachments-solid.tsx", "widget-card-view.tsx"].map(
          (file) => controlUiE2eBuiltModuleRequest(`ui/src/pages/chat/components/${file}`),
        );
        const mediaRequests = () =>
          requested.filter((path) => mediaModules.some((module) => module.test(path)));
        const subagentActivityModule = controlUiE2eBuiltModuleRequest(
          "ui/src/pages/chat/components/chat-subagent-activity-live.tsx",
        );
        const activityPillsModule = controlUiE2eBuiltModuleRequest(
          "ui/src/pages/chat/components/chat-activity-pills.tsx",
        );
        const iconRequests = () =>
          requested.filter((path) => path.endsWith("/apple-touch-icon.png"));
        const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
        const initialMessage = {
          role: "assistant",
          content: "Cold chat request proof.",
          __openclaw: { id: "boot-text", seq: 1 },
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          deviceToken: null, // Keep the rejection terminal while the login module loads.
          deferredMethods: ["connect"],
          historyMessages: [initialMessage],
        });
        await page.goto(
          `${controlUiSessionUrl(suite.server.baseUrl, sessionKey)}#token=synthetic-boot-token`,
        );
        await gateway.waitForRequest("connect");
        expect(loginRequests()).toEqual([]);
        await gateway.resolveDeferred("connect");
        await page.getByText("Cold chat request proof.", { exact: true }).waitFor();
        await page.locator(".topbar-brand__logo").waitFor({ state: "attached" });
        expect(await page.locator(".topbar").isVisible()).toBe(false);
        expect(iconRequests()).toEqual([]);
        expect(loginRequests()).toEqual([]);
        expect(mediaRequests()).toEqual([]);
        expect(requested.some((path) => imageModule.test(path))).toBe(true);
        expect(requested.filter((path) => subagentActivityModule.test(path))).toEqual([]);

        const imageMessage = {
          role: "assistant",
          __openclaw: { id: "deferred-image", seq: 2 },
          content: [
            { type: "text", text: "The image loads within this message." },
            {
              type: "image",
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
              alt: "Inline transcript image",
            },
          ],
        };
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Keep this draft while the image loads");
        await gateway.setHistoryMessages([initialMessage, imageMessage]);
        await gateway.emitGatewayEvent("session.message", {
          message: imageMessage,
          sessionKey,
          messageId: "deferred-image",
          messageSeq: 2,
          activeRunIds: [],
          hasActiveRun: false,
        });
        await page.locator('.chat-message-images img[alt="Inline transcript image"]').waitFor();
        expect(await page.locator("[data-message-id] .lazy-view-state--loading").count()).toBe(0);
        expect(mediaRequests()).toEqual([]);
        expect(await composer.inputValue()).toBe("Keep this draft while the image loads");
        expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
        await composer.fill("");

        await page.setViewportSize({ width: 600, height: 900 });
        await page.locator('.agent-chat__composer-shell[data-mobile-composer="true"]').waitFor();
        await page.waitForLoadState("networkidle");
        expect(requested.filter((path) => activityPillsModule.test(path))).toEqual([]);
        expect(requested.filter((path) => subagentActivityModule.test(path))).toEqual([]);
        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await page.locator(".topbar-brand__logo").waitFor({ state: "visible" });
        await page.locator(".topbar-brand__logo").evaluate(async (image) => {
          if (!(image instanceof HTMLImageElement)) {
            throw new Error("Expected the topbar image");
          }
          await image.decode();
        });
        expect(iconRequests()).toHaveLength(1);

        await page.goto(
          `${controlUiSessionUrl(suite.server.baseUrl, sessionKey)}#token=synthetic-bad-token`,
        );
        await gateway.waitForRequest("connect");
        await gateway.rejectDeferred("connect", {
          code: "INVALID_REQUEST",
          message: "token mismatch",
          details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH },
        });
        await page.locator("openclaw-login-gate").waitFor({ state: "visible" });
        expect(loginRequests().length).toBeGreaterThan(0);
      },
    );
  });
});
