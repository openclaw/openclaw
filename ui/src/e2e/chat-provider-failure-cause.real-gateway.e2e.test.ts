import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";

const providerMessage = "This request needs the fixture team plan.";

function createFailureSuite(provider: "fixture" | "message-fixture") {
  const custom = provider === "message-fixture";
  let instance: OpenClawTestInstance;
  const requestedProviders: string[] = [];
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
              const customRequest = request.url?.startsWith("/fallback/") === true;
              requestedProviders.push(customRequest ? "message-fixture" : "fixture");
              response.writeHead(customRequest ? 403 : 401, { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  error: customRequest
                    ? { code: "insufficient_quota", message: "fixture_plan_required" }
                    : { message: "Incorrect API key provided", code: "invalid_api_key" },
                }),
              );
            });
          }),
      });
      const origin = `http://127.0.0.1:${upstream.claim.port}`;
      const primary = {
        api: "openai-completions",
        baseUrl: `${origin}/v1`,
        apiKey: "sk-synthetic-revoked",
        models: [{ id: "current", name: "Fixture model" }],
      };
      instance = await createChatGatewayInstance({
        name: "chat-provider-failure-cause",
        provider: "fixture",
        identity: "Assistant",
        model: "current",
        ...primary,
        defaults: custom
          ? {
              model: { primary: "fixture/current", fallbacks: ["message-fixture/current"] },
              modelPolicy: { allow: ["fixture/*", "message-fixture/*"] },
            }
          : undefined,
        config: {
          update: { checkOnStart: false },
          browser: { enabled: false },
          ...(custom
            ? {
                models: {
                  catalogRefresh: { enabled: false },
                  providers: {
                    fixture: primary,
                    "message-fixture": {
                      ...primary,
                      baseUrl: `${origin}/fallback/v1`,
                    },
                  },
                },
              }
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
      if (custom) {
        const pluginDir = instance.state.path("message-provider");
        await fs.mkdir(pluginDir, { recursive: true });
        await fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: "message-provider",
            providers: ["message-fixture"],
            configSchema: { type: "object", properties: {} },
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "index.js"),
          `export default { id: "message-provider", register(api) {
            api.registerProvider({ id: "message-fixture", label: "Message fixture", auth: [],
              classifyFailoverReason: ({ errorMessage }) => errorMessage.includes("fixture_plan_required") ? "billing" : undefined,
              formatUserFacingError: ({ errorMessage }) => errorMessage.includes("fixture_plan_required") ? ${JSON.stringify(providerMessage)} : undefined,
            });
          } };`,
        );
        await instance.state.writeConfig({
          ...JSON.parse(await fs.readFile(instance.configPath, "utf8")),
          plugins: {
            allow: ["message-provider"],
            load: { paths: [pluginDir] },
            entries: { "message-provider": { enabled: true } },
          },
        });
      }
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

  return { suite, open, requestedProviders };
}

const { suite, open, requestedProviders } = createFailureSuite("fixture");

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
        expect(requestedProviders).toContain("fixture");
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

const custom = createFailureSuite("message-fixture");

custom.suite.define(() => {
  it("preserves the final provider message through fallback and reload", async () => {
    await custom.suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.goto(await custom.open("chat"));
        await waitForControlUiGatewayReady(page);
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).fill("Hello");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const failure = page.locator(".chat-run-failure").first();
        const checkMessage = async () => {
          await failure.waitFor({ timeout: 60_000 });
          await failure.locator(".chat-run-failure__toggle").click();
          const details = page.locator(".chat-run-failure__log");
          await details.waitFor();
          expect([...new Set(custom.requestedProviders)]).toEqual(["fixture", "message-fixture"]);
          expect(await details.textContent()).toBe(providerMessage);
          expect(await failure.locator(".chat-run-failure__title").textContent()).toBe(
            providerMessage,
          );
        };
        await checkMessage();
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await checkMessage();
      },
    );
  });
});
