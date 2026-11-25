import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";

const googlePlanRefusal = "This request requires an active Google AI Ultra subscription.";

function createFailureSuite(provider: "fixture" | "google") {
  const google = provider === "google";
  let instance: OpenClawTestInstance;
  let upstreamRequests = 0;
  const suite = createControlUiE2eSuite({
    name: provider + " provider failure",
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
              response.writeHead(google ? 403 : 401, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  error: google
                    ? { code: 403, status: "PERMISSION_DENIED", message: googlePlanRefusal }
                    : { message: "Incorrect API key provided", code: "invalid_api_key" },
                }),
              );
            });
          }),
      });
      const baseUrl = `http://127.0.0.1:${upstream.claim.port}/${google ? "v1beta" : "v1"}`;
      instance = await createChatGatewayInstance({
        name: "chat-provider-failure-cause",
        provider,
        identity: "Assistant",
        model: "current",
        api: google ? "google-generative-ai" : "openai-completions",
        baseUrl,
        apiKey: "sk-synthetic-revoked",
        models: [{ id: "current", name: "Fixture model" }],
        config: {
          update: { checkOnStart: false },
          browser: { enabled: false },
          ...(google
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
      await instance.startGateway().catch(async (error: unknown) => {
        await close();
        throw error;
      });
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
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

  return { suite, open, upstreamRequests: () => upstreamRequests };
}

const { suite, open, upstreamRequests } = createFailureSuite("fixture");

suite.define(() => {
  it("shows a rejected key's cause on the failed reply and links to Models", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.goto(await open("chat"));
        await waitForControlUiGatewayReady(page);
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).fill("Hello");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const failure = page.locator(".chat-run-failure").first();
        await failure.waitFor({ timeout: 60_000 });
        expect(upstreamRequests()).toBeGreaterThan(0);
        const shot = process.env.OPENCLAW_E2E_SHOT;
        if (shot) {
          await page.screenshot({ path: shot });
        }
        // The cause is on the line itself, without opening the details.
        expect(await failure.locator(".chat-run-failure__title").textContent()).toBe(
          "Fixture didn’t accept the saved credentials",
        );
        // Reloading reads the same cause back from the stored transcript.
        await page.reload();
        await waitForControlUiGatewayReady(page);
        const stored = page.locator(".chat-run-failure").first();
        await stored.waitFor({ timeout: 30_000 });
        expect(await stored.locator(".chat-run-failure__title").textContent()).toBe(
          "Fixture didn’t accept the saved credentials",
        );
        await stored.getByRole("button", { name: "Open Models", exact: true }).click();
        await page.waitForURL((url) => url.pathname.endsWith("/settings/model-providers"));
        expect(new URL(page.url()).searchParams.get("provider")).toBe("fixture");
      },
    );
  });
});

const google = createFailureSuite("google");

google.suite.define(() => {
  it("shows Google's plan refusal on the failed reply after reload", async () => {
    await google.suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.goto(await google.open("chat"));
        await waitForControlUiGatewayReady(page);
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).fill("Hello");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const failure = page.locator(".chat-run-failure").first();
        const checkMessage = async () => {
          await failure.waitFor({ timeout: 60_000 });
          await failure.locator(".chat-run-failure__toggle").click();
          const details = page.locator(".chat-run-failure__log");
          await details.waitFor();
          if (process.env.OPENCLAW_E2E_SHOT) {
            await page.screenshot({ path: process.env.OPENCLAW_E2E_SHOT, animations: "disabled" });
          }
          expect(await details.textContent()).toBe(googlePlanRefusal);
          expect(await failure.locator(".chat-run-failure__title").textContent()).toBe(
            googlePlanRefusal,
          );
        };
        await checkMessage();
        expect(google.upstreamRequests()).toBeGreaterThan(0);
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await checkMessage();
      },
    );
  });
});
