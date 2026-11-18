import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";
import { respondAsReasoningModel } from "./reasoning-upstream.test-support.js";

// Setup's one-shot check behind a dialog must report a scripted provider's failures promptly.
let instance: OpenClawTestInstance;
let inferenceRequests = 0;
const reasonCaps: unknown[] = [];
let upstreamMode: "error" | "hang" | "reason" = "error";
const suite = createControlUiE2eSuite({
  name: "Model setup check against a failing provider",
  startServerBeforeBrowser: true,
  async startServer() {
    const upstream = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          // Catalog discovery must succeed before the inference failure under test.
          if (request.url === "/v1/models") {
            request.resume();
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ data: [{ id: "hy4-preview" }] }));
            return;
          }
          void buffer(request).then((raw) => {
            const body = JSON.parse(raw.toString() || "{}");
            const inference = request.url?.endsWith("/chat/completions");
            inferenceRequests += inference ? 1 : 0;
            // Thinks past the 256-token cap setup used to send, like measured reasoning models.
            if (inference && upstreamMode === "reason") {
              reasonCaps.push(body.max_completion_tokens ?? body.max_tokens);
              respondAsReasoningModel(request.url ?? "", body, response, 300);
            } else if (!inference || upstreamMode === "error") {
              response.writeHead(500, { "content-type": "application/json" });
              response.end(
                JSON.stringify({ error: { message: "Upstream overloaded", code: 500 } }),
              );
            }
          });
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
  it("reports failures promptly and passes a reasoning provider from Test & use", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.goto(await open("settings/model-providers"));
        await page.getByRole("button", { name: "Add account", exact: true }).first().click();
        const picker = page.getByRole("dialog", { name: "Add an account" });
        await picker.getByRole("searchbox", { name: "Search providers…" }).fill("Tencent");
        await picker.getByRole("button", { name: "Tencent TokenHub" }).click();
        const form = page.getByRole("dialog", { name: "Add provider" });
        await form.getByRole("textbox", { name: "API key" }).fill("sk-synthetic-setup-check");
        await form.getByRole("button", { name: "Save provider", exact: true }).click();
        await expect.poll(() => form.isVisible(), { timeout: 30_000 }).toBe(false);
        // Adding the first provider already ran one check, which the 5xx also failed.
        expect(inferenceRequests).toBe(1);
        inferenceRequests = 0;
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

        // A reasoning model passes without an output cap and becomes the default.
        upstreamMode = "reason";
        await startCheck();
        await dialog.waitFor();
        const failure = dialog.getByText(/default unchanged/);
        await expect
          .poll(async () => (await failure.isVisible()) || !(await dialog.isVisible()), {
            timeout: 30_000,
          })
          .toBe(true);
        expect(await failure.isVisible()).toBe(false);
        // A capped check spends 256 tokens thinking, then retries; the uncapped one asks once.
        expect(reasonCaps).not.toContain(256);
      },
    );
  });
});
