import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";

for (const billing of [false, true]) {
  let instance: OpenClawTestInstance;
  let upstreamRequests = 0;
  const message = "This request requires an active Google AI Ultra subscription.";
  const plansUrl = "https://one.google.com/about/google-ai-plans/";
  const provider = billing ? "google" : "fixture";
  const model = billing ? "gemini-4-argon" : "current";
  const suite = createControlUiE2eSuite({
    name: billing ? "Google subscription recovery copy" : "A failed reply says why",
    startServerBeforeBrowser: true,
    async startServer() {
      const upstream = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer((request, response) => {
            void buffer(request).then(() => {
              if (request.url === "/v1/models") {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ data: [{ id: "current" }] }));
                return;
              }
              upstreamRequests += 1;
              response.writeHead(billing ? 403 : 401, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  error: billing
                    ? {
                        code: 403,
                        status: "PERMISSION_DENIED",
                        message,
                        privateDetail: "RAW_BILLING_CANARY",
                      }
                    : { message: "Incorrect API key provided", code: "invalid_api_key" },
                }),
              );
            });
          }),
      });
      instance = await createChatGatewayInstance({
        name: "chat-provider-failure-cause",
        provider,
        identity: "Assistant",
        model,
        api: billing ? "google-generative-ai" : "openai-completions",
        baseUrl: "http://127.0.0.1:" + upstream.claim.port + (billing ? "/v1beta" : "/v1"),
        apiKey: "sk-synthetic-revoked",
        models: [{ id: model, name: billing ? "Google refusal fixture" : "Fixture model" }],
        config: {
          update: { checkOnStart: false },
          browser: { enabled: false },
          ...(billing
            ? { plugins: { allow: ["google"], entries: { google: { enabled: true } } } }
            : {}),
        },
      });
      const close = async () => {
        try {
          await instance.cleanup();
        } finally {
          upstream.listener.closeAllConnections();
          await upstream.releaseListener();
          await upstream.claim.release();
        }
      };
      try {
        await instance.startGateway();
      } catch (error) {
        await close();
        throw error;
      }
      return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close };
    },
  });

  async function open(route: string) {
    // A fresh Gateway answers "assets are still preparing" until it has published the UI.
    let handoff = await instance.cli(["dashboard", "--json"]);
    await expect
      .poll(
        async () => {
          if (handoff.code !== 0 && /still preparing/u.test(handoff.stderr)) {
            handoff = await instance.cli(["dashboard", "--json"]);
          }
          return /still preparing/u.test(handoff.stderr);
        },
        { timeout: 120_000, interval: 1_000 },
      )
      .toBe(false);
    expect(handoff.code, handoff.stderr).toBe(0);
    const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
    const url = new URL(route, browserUrl);
    url.hash = new URL(browserUrl).hash;
    return url.href;
  }

  suite.define(() => {
    it(
      billing
        ? "preserves the plan refusal and plans link after reload"
        : "shows a rejected key and links to Models",
      async () => {
        await suite.withPage(
          { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
          async ({ page }) => {
            await page.goto(await open("chat"));
            await waitForControlUiGatewayReady(page);
            await page.getByRole("textbox", { name: "Chat composer", exact: true }).fill("Hello");
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            const failure = page.locator(".chat-run-failure").first();
            const toggle = failure.locator(".chat-run-failure__toggle");
            const checkFailure = async () => {
              await failure.waitFor({ timeout: 60_000 });
              if (billing) {
                await toggle.click();
                await page.locator(".chat-run-failure__log").waitFor();
                const plans = page.getByRole("link", { name: "View plans", exact: true });
                expect(await failure.locator(".chat-run-failure__title").textContent()).toBe(
                  message,
                );
                expect(await page.locator(".chat-run-failure__log").textContent()).not.toContain(
                  "RAW_BILLING_CANARY",
                );
                await plans.waitFor();
                expect(await plans.getAttribute("href")).toBe(plansUrl);
                await page.keyboard.press("Escape");
              } else {
                expect(await failure.locator(".chat-run-failure__title").textContent()).toBe(
                  "Fixture didn’t accept the saved credentials",
                );
              }
            };
            await checkFailure();
            expect(upstreamRequests).toBeGreaterThan(0);
            await page.reload();
            await waitForControlUiGatewayReady(page);
            await checkFailure();
            await failure.getByRole("button", { name: "Open Models", exact: true }).click();
            await page.waitForURL((url) => url.pathname.endsWith("/settings/model-providers"));
            expect(new URL(page.url()).searchParams.get("provider")).toBe(provider);
          },
        );
      },
    );
  });
}
