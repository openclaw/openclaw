import path from "node:path";
import type { Route } from "playwright";
import { expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI browser bootstrap" });

suite.define(() => {
  it("recovers a bare HTTPS deep link and reuses the paired browser credential on reload", async () => {
    const artifactDir = suite.artifactDir;
    const handoff = createDeferred();
    const pendingRoutes = new Set<Promise<void>>();
    const trackRoute = (handle: (route: Route) => Promise<void>) => async (route: Route) => {
      const pending = createDeferred();
      pendingRoutes.add(pending.promise);
      try {
        await handle(route);
      } finally {
        pendingRoutes.delete(pending.promise);
        pending.resolve();
      }
    };
    const video = await suite.withPage(
      {
        viewport: { width: 1440, height: 1000 },
        locale: "en-US",
        serviceWorkers: "block",
        recordVideo: { dir: artifactDir, size: { width: 1440, height: 1000 } },
      },
      async ({ page }) => {
        const origin = "https://gateway.example";
        const sessionKey = "agent:main:browser-bootstrap-proof";
        const deepLink = `${controlUiSessionUrl(`${origin}/`, sessionKey)}?keep=yes#section`;
        const bootstrapToken = "synthetic-owner-bootstrap";
        const deviceToken = "synthetic-paired-browser";
        let helperCalls = 0;
        const connectedText = "Your browser is connected. This is synthetic proof data.";
        const expectConnected = async (screenshot: string) => {
          await waitForControlUiGatewayReady(page);
          await page.getByText(connectedText, { exact: true }).waitFor();
          expect(page.url()).toBe(deepLink);
          await page.screenshot({ path: path.join(artifactDir, screenshot) });
        };

        // Exercise secure-origin browser behavior while serving only this test's local bundle.
        await page.route(
          `${origin}/**`,
          trackRoute(async (route) => {
            const requested = new URL(route.request().url());
            const upstream = new URL(
              `${requested.pathname}${requested.search}`,
              suite.server.baseUrl,
            );
            const response = await route.fetch({ url: upstream.href, maxRetries: 1 });
            await route.fulfill({ response });
          }),
        );
        const gateway = await installMockGateway(page, {
          sessionKey,
          deviceToken,
          heldMethods: ["connect"],
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: connectedText }],
            },
          ],
        });
        await page.route(
          `${origin}/.well-known/openclaw/browser-bootstrap`,
          trackRoute(async (route) => {
            helperCalls += 1;
            expect(route.request().method()).toBe("GET");
            expect(route.request().headers().authorization).toBeUndefined();
            await handoff.promise;
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              headers: { "Cache-Control": "no-store" },
              body: JSON.stringify({ bootstrapToken, bootstrapProfile: "owner" }),
            });
          }),
        );

        await page.goto(deepLink);
        const initialConnect = await gateway.waitForRequest("connect");
        expect(initialConnect.params).not.toHaveProperty("auth.bootstrapToken");
        expect(initialConnect.params).not.toHaveProperty("auth.deviceToken");
        await gateway.rejectDeferred("connect", {
          code: "INVALID_REQUEST",
          message: "The Gateway needs a matching token or password.",
          details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING },
        });
        await page.getByText("This Gateway expects its token", { exact: true }).waitFor();
        await expect.poll(() => helperCalls).toBe(1);
        await page.screenshot({ path: path.join(artifactDir, "1-auth-required.png") });

        await gateway.deferNext("connect");
        handoff.resolve();
        const recoveredConnect = await gateway.waitForRequest("connect", { after: 1 });
        expect(recoveredConnect.params).toMatchObject({
          auth: { bootstrapToken },
          device: { id: expect.any(String), signature: expect.any(String) },
        });
        await gateway.resolveDeferred("connect");
        await expectConnected("2-connected.png");

        await page.reload();
        const reloadConnect = await gateway.waitForRequest("connect");
        expect(reloadConnect.params).toMatchObject({ auth: { deviceToken } });
        expect(reloadConnect.params).not.toHaveProperty("auth.bootstrapToken");
        await gateway.resolveDeferred("connect");
        await expectConnected("3-reloaded.png");
        expect(helperCalls).toBe(1);
        return page.video();
      },
      async ({ page }) => {
        // Stop page requests, then drain handlers while the context still owns
        // fetched bodies. Unrouting during the drain can auto-continue active routes.
        handoff.resolve();
        await runQaGatewayFixture(
          () => page.close(),
          () => Promise.all(pendingRoutes),
        );
      },
    );
    await video?.saveAs(path.join(artifactDir, "browser-bootstrap.webm"));
  });
});
