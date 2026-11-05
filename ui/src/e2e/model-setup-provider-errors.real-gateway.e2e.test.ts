import { createServer } from "node:http";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";

// A provider that answers every inference request with a server error. The setup check
// is one-shot verification: it must report the failure, not walk the chat retry ladder.
let instance: OpenClawTestInstance;
let inferenceRequests = 0;
const suite = createControlUiE2eSuite({
  name: "Model setup check against a failing provider",
  startServerBeforeBrowser: true,
  async startServer() {
    const upstream = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          request.resume();
          if (request.url?.endsWith("/chat/completions")) {
            inferenceRequests += 1;
          }
          response.statusCode = 500;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ error: { message: "Upstream overloaded", code: 500 } }));
        }),
    });
    instance = await createOpenClawTestInstance({
      name: "model-setup-provider-errors",
      reserveIdlePort: false,
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
        // Host provider keys would satisfy first-run setup and skip the check under test.
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter((key) => key.endsWith("_API_KEY"))
            .map((key) => [key, undefined]),
        ),
      },
      config: {
        gateway: { controlUi: { enabled: true } },
        agents: { entries: { main: {} } },
        models: {
          providers: {
            // The bundled provider keeps its catalog and setup path; only the endpoint moves.
            "tencent-tokenhub": {
              baseUrl: `http://127.0.0.1:${upstream.claim.port}/v1`,
              api: "openai-completions",
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
    try {
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
    } catch (error) {
      await close();
      throw error;
    }
  },
});

suite.define(() => {
  it("reports a provider server error from Test & use without retrying for a minute", async () => {
    // Pairing links are single-use, so each page load gets its own handoff.
    const open = async (route: string) => {
      const handoff = await instance.cli(["dashboard", "--json"]);
      expect(handoff.code, handoff.stderr).toBe(0);
      const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
      const url = new URL(route, browserUrl);
      url.hash = new URL(browserUrl).hash;
      return url.href;
    };
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.goto(await open("settings/model-providers"));
        await waitForControlUiGatewayReady(page);
        await page.getByRole("button", { name: "Add account", exact: true }).first().click();
        const picker = page.getByRole("dialog", { name: "Add an account" });
        await picker.getByRole("searchbox", { name: "Search providers…" }).fill("Tencent");
        await picker.getByRole("button", { name: "Tencent Tokenhub" }).click();
        const form = page.getByRole("dialog", { name: "Add provider" });
        await form.getByRole("textbox", { name: "API key" }).fill("sk-synthetic-setup-check");
        await form.getByRole("button", { name: "Save provider", exact: true }).click();
        await expect.poll(() => form.isVisible(), { timeout: 30_000 }).toBe(false);

        // Chat routes to Set up a model until a model is verified.
        await page.goto(await open("chat"));
        await waitForControlUiGatewayReady(page);
        const saved = page
          .locator("li, article, section, div")
          .filter({ hasText: "Saved Tencent TokenHub sign-in" })
          .filter({ has: page.getByRole("button", { name: "Test & use", exact: true }) })
          .last();
        await saved.getByRole("button", { name: "Test & use", exact: true }).click({
          timeout: 60_000,
        });
        const started = Date.now();
        const dialog = page.getByRole("dialog", { name: "Set up a model" });
        // Before the fix the check retried for ~90 s; one failed attempt should settle quickly.
        await dialog.getByText(/temporarily overloaded/i).waitFor({ timeout: 20_000 });
        expect(Date.now() - started).toBeLessThan(20_000);
        expect(inferenceRequests).toBe(1);
      },
    );
  });
});
