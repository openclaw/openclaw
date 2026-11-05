import { createServer } from "node:http";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";

// Setup's one-shot check behind a dialog must report a scripted provider's failures promptly.
let instance: OpenClawTestInstance;
let inferenceRequests = 0;
let upstreamMode: "error" | "hang" = "error";
const suite = createControlUiE2eSuite({
  name: "Model setup check against a failing provider",
  startServerBeforeBrowser: true,
  async startServer() {
    const upstream = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          request.resume();
          // Catalog discovery must succeed before the inference failure under test.
          if (request.url === "/v1/models") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ data: [{ id: "hy4-preview" }] }));
            return;
          }
          const inference = request.url?.endsWith("/chat/completions");
          inferenceRequests += inference ? 1 : 0;
          if (!inference || upstreamMode === "error") {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "Upstream overloaded", code: 500 } }));
          }
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
        plugins: { allow: ["tencent"] },
        models: {
          providers: {
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
    await instance.startGateway().catch(async (error: unknown) => {
      await close();
      throw error;
    });
    return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
  },
});

// Pairing links are single-use, so each page load gets its own handoff.
async function open(route: string) {
  const handoff = await instance.cli(["dashboard", "--json"]);
  expect(handoff.code, handoff.stderr).toBe(0);
  const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
  const url = new URL(route, browserUrl);
  url.hash = new URL(browserUrl).hash;
  return url.href;
}

suite.define(() => {
  it("reports provider errors and silent providers from Test & use promptly", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.goto(await open("settings/model-providers"));
        await page.getByRole("button", { name: "Add account", exact: true }).first().click();
        const picker = page.getByRole("dialog", { name: "Add an account" });
        await picker.getByRole("searchbox", { name: "Search providers…" }).fill("Tencent");
        await picker.getByRole("button", { name: "Tencent Tokenhub" }).click();
        const form = page.getByRole("dialog", { name: "Add provider" });
        await form.getByRole("textbox", { name: "API key" }).fill("sk-synthetic-setup-check");
        await form.getByRole("button", { name: "Save provider", exact: true }).click();
        await expect.poll(() => form.isVisible(), { timeout: 30_000 }).toBe(false);
        const dialog = page.getByRole("dialog", { name: "Set up a model" });
        const startCheck = async () => {
          await page.goto(await open("chat")); // Routes to Set up a model until one is verified.
          const test = page.getByRole("button", { name: "Test & use", exact: true });
          await page
            .locator("li, article, section, div")
            .filter({ hasText: "Saved Tencent TokenHub sign-in", has: test })
            .last()
            .locator(test)
            .click({ timeout: 60_000 });
        };

        // A 5xx is reported after one attempt, not after the chat retry ladder (~90 s).
        await startCheck();
        await dialog.getByText(/temporarily overloaded/i).waitFor({ timeout: 20_000 });
        expect(inferenceRequests).toBe(1);

        // A silent remote API shows the wait and fails at 30 s, not 90 s.
        upstreamMode = "hang";
        await startCheck();
        await dialog.getByText(/Testing your AI connection… \d+s\. You can cancel/).waitFor();
        await dialog.getByText(/timed out/i).waitFor({ timeout: 45_000 });
      },
    );
  });
});
