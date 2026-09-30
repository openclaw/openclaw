import { expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat boot optional requests" });

suite.define(() => {
  it("defers login modules and hidden topbar artwork until their surfaces are needed", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const requested: string[] = [];
        page.on("request", (request) => requested.push(new URL(request.url()).pathname));
        const loginRequests = () =>
          requested.filter((path) => /\/login-(gate|runtime)[.-]/u.test(path));
        const iconRequests = () =>
          requested.filter((path) => path.endsWith("/apple-touch-icon.png"));
        const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
        const gateway = await installMockGateway(page, {
          sessionKey,
          deferredMethods: ["connect"],
          historyMessages: [{ role: "assistant", content: "Cold chat request proof." }],
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

        await page.setViewportSize({ width: 600, height: 900 });
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
