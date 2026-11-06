import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";

// A provider that rejects every request with the key it was given, like a revoked key.
let instance: OpenClawTestInstance;
let upstreamRequests = 0;
const suite = createControlUiE2eSuite({
  name: "A failed reply says why",
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
            response.writeHead(401, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: { message: "Incorrect API key provided", code: "invalid_api_key" },
              }),
            );
          });
        }),
    });
    const baseUrl = `http://127.0.0.1:${upstream.claim.port}/v1`;
    instance = await createOpenClawTestInstance({
      name: "chat-provider-failure-cause",
      reserveIdlePort: false,
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter((key) => key.endsWith("_API_KEY"))
            .map((key) => [key, undefined]),
        ),
      },
      config: {
        gateway: { controlUi: { enabled: true } },
        agents: { entries: { main: {} }, defaults: { model: "fixture/current" } },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "sk-synthetic-revoked",
              baseUrl,
              models: [{ id: "current", name: "Fixture model" }],
            },
          },
        },
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
  const handoff = await instance.cli(["dashboard", "--json"]);
  expect(handoff.code, handoff.stderr).toBe(0);
  const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
  const url = new URL(route, browserUrl);
  url.hash = new URL(browserUrl).hash;
  return url.href;
}

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
        expect(upstreamRequests).toBeGreaterThan(0);
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
