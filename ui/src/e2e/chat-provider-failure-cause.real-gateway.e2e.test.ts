import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
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
  const message = "Using your plan in third-party apps requires an active subscription.";
  const actionUrl = "https://example.com/plans";
  const suite = createControlUiE2eSuite({
    name: billing ? "Provider billing recovery copy" : "A failed reply says why",
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
                        message: "Payment required. " + message + " " + actionUrl,
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
        provider: "fixture",
        identity: "Assistant",
        model: "current",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:" + upstream.claim.port + "/v1",
        apiKey: "sk-synthetic-revoked",
        models: [{ id: "current", name: "Fixture model" }],
        config: { update: { checkOnStart: false }, browser: { enabled: false } },
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
        if (billing) {
          const plugin = instance.state.path("billing-provider");
          await mkdir(plugin);
          await writeFile(
            path.join(plugin, "openclaw.plugin.json"),
            JSON.stringify({
              id: "fixture",
              providers: ["fixture"],
              activation: { onStartup: true },
              configSchema: { type: "object", properties: {}, additionalProperties: false },
            }),
          );
          await writeFile(
            path.join(plugin, "package.json"),
            JSON.stringify({
              name: "billing-fixture",
              version: "0.0.0",
              type: "module",
              openclaw: { extensions: ["./index.js"] },
            }),
          );
          await writeFile(
            path.join(plugin, "index.js"),
            'export default { id: "fixture", register(api) { api.registerProvider({ id: "fixture", label: "Fixture", auth: [], formatBillingError: ({ status }) => status === 403 ? ' +
              JSON.stringify({ message, actionUrl }) +
              " : undefined }); } };",
          );
          const config = JSON.parse(await readFile(instance.configPath, "utf8"));
          await instance.state.writeConfig({
            ...config,
            plugins: {
              allow: ["fixture"],
              load: { paths: [plugin] },
              entries: { fixture: { enabled: true } },
            },
          });
        }
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
    it("shows the provider recovery action and preserves it after reload", async () => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          await page.goto(await open("chat"));
          await waitForControlUiGatewayReady(page);
          await page.getByRole("textbox", { name: "Chat composer", exact: true }).fill("Hello");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          const failure = page.locator(".chat-run-failure").first();
          const checkFailure = async () => {
            await failure.waitFor({ timeout: 60_000 });
            if (billing) {
              expect(
                await failure.locator(".chat-run-failure__billing-message").textContent(),
              ).toBe(message);
              expect(
                await failure
                  .getByRole("link", { name: "View plans", exact: true })
                  .getAttribute("href"),
              ).toBe(actionUrl);
              expect(await failure.textContent()).not.toContain("RAW_BILLING_CANARY");
            } else {
              expect(await failure.locator(".chat-run-failure__title").textContent()).toBe(
                "Fixture didn’t accept the saved credentials",
              );
            }
          };
          await checkFailure();
          expect(upstreamRequests).toBeGreaterThan(0);
          const shot = process.env.OPENCLAW_E2E_SHOT;
          if (shot) {
            await page.screenshot({ path: shot });
          }
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await checkFailure();
          if (billing) {
            await page.setViewportSize({ width: 390, height: 844 });
            await checkFailure();
            const text = await failure.locator(".chat-run-failure__billing-message").boundingBox();
            const link = await failure.locator(".chat-run-failure__plans").boundingBox();
            expect(link!.y).toBeGreaterThanOrEqual(text!.y + text!.height);
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
          } else {
            await failure.getByRole("button", { name: "Open Models", exact: true }).click();
            await page.waitForURL((url) => url.pathname.endsWith("/settings/model-providers"));
            expect(new URL(page.url()).searchParams.get("provider")).toBe("fixture");
          }
        },
      );
    });
  });
}
