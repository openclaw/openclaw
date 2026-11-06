import fs from "node:fs/promises";
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

// A first-run agent has no model. Adding a provider's API key from Models must end in a chat
// that answers, without a detour through Set up a model.
let instance: OpenClawTestInstance;
const chatRequests: { hasAuth: boolean }[] = [];
const suite = createControlUiE2eSuite({
  name: "Adding the first provider ends in a working chat",
  startServerBeforeBrowser: true,
  async startServer() {
    const upstream = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          void buffer(request).then((raw) => {
            if (request.url === "/v1/models") {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ data: [{ id: "hy4-preview" }] }));
              return;
            }
            if (request.url !== "/v1/chat/completions") {
              response.writeHead(404).end();
              return;
            }
            chatRequests.push({ hasAuth: Boolean(request.headers.authorization) });
            const model = JSON.parse(raw.toString() || "{}").model;
            const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
              `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(
              [
                chunk({ role: "assistant", content: "" }),
                chunk({ content: "pong" }),
                chunk({}, "stop"),
                "data: [DONE]\n\n",
              ].join(""),
            );
          });
        }),
    });
    instance = await createOpenClawTestInstance({
      name: "model-add-provider-to-chat",
      reserveIdlePort: false,
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
        // Host provider keys would give the agent a model before the flow under test.
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
            // No inline model list: a listed loopback endpoint is a keyless local server.
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
  it("adds a key, activates its model and chats from the add dialog", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.goto(await open("settings/model-providers"));
        await waitForControlUiGatewayReady(page);
        await page.locator('[data-model-readiness="model-required"]').waitFor();

        let clicks = 0;
        const started = Date.now();
        await page.getByRole("button", { name: "Add account", exact: true }).first().click();
        clicks++;
        const picker = page.getByRole("dialog", { name: "Add an account" });
        await picker.getByRole("searchbox", { name: "Search providers…" }).fill("Tencent");
        await picker.getByRole("button", { name: "Tencent Tokenhub" }).click();
        clicks++;
        const form = page.getByRole("dialog", { name: "Add provider" });
        // A provider with config still shows its display name, not its config id.
        expect((await form.locator(".oc-dialog__title").innerText()).trim()).toBe(
          "Tencent Tokenhub",
        );
        await form.getByRole("textbox", { name: "API key" }).fill("sk-synthetic-first-provider");
        await form.getByRole("button", { name: "Save provider", exact: true }).click();
        clicks++;

        // The dialog ends on a model that passed the same check as Test & use.
        const startChat = form.getByRole("button", { name: /^Start a new chat with / });
        await startChat.waitFor({ timeout: 30_000 });
        expect(await form.textContent()).toContain("is ready to chat.");
        const config = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
        expect(JSON.stringify(config.agents)).toContain("tencent-tokenhub/hy4-preview");

        await startChat.click();
        clicks++;
        await page.waitForURL((url) => !url.pathname.includes("settings"), { timeout: 30_000 });
        expect(page.url()).not.toContain("model-setup");
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).fill("Hello");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page
          .locator(".chat-group.assistant .chat-bubble")
          .getByText("pong", { exact: true })
          .first()
          .waitFor({ timeout: 30_000 });
        const elapsed = Date.now() - started;
        console.log(`[add-to-chat] key to reply ${elapsed} ms, ${clicks} clicks before typing`);
        expect(clicks).toBeLessThanOrEqual(4);
        expect(chatRequests.length).toBeGreaterThan(0);
        expect(chatRequests.every((request) => request.hasAuth)).toBe(true);
      },
    );
  });
});
