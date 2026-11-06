import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.js";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";
import { expandProvider } from "./model-providers.test-support.ts";

// Removing the provider behind the default model keeps the default (documented logout
// contract), so the confirmation has to say so, and later chats must fail without
// reaching the provider unauthenticated.
let instance: OpenClawTestInstance;
const chatRequests: { hasAuth: boolean }[] = [];
const suite = createControlUiE2eSuite({
  name: "Remove the provider behind the default model",
  startServerBeforeBrowser: true,
  async startServer() {
    const upstream = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          void buffer(request).then((raw) => {
            if (request.url === "/v1/models") {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ data: [{ id: "hy4" }] }));
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
      name: "model-provider-remove-in-use",
      reserveIdlePort: false,
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
        // Host provider keys would keep the provider signed in after removal.
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter((key) => key.endsWith("_API_KEY"))
            .map((key) => [key, undefined]),
        ),
      },
      config: {
        gateway: { controlUi: { enabled: true } },
        agents: { entries: { main: {} }, defaults: { model: "tencent-tokenhub/hy4" } },
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

async function savedDefault() {
  return JSON.parse(await fs.readFile(instance.configPath, "utf8")).agents?.defaults?.model;
}

suite.define(() => {
  it("warns before removing the default model's provider and never chats unauthenticated", async () => {
    const artifacts = createControlUiE2eArtifactDir("model-provider-remove-in-use");
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
        await form.getByRole("textbox", { name: "API key" }).fill("sk-synthetic-remove-in-use");
        await form.getByRole("button", { name: "Save provider", exact: true }).click();
        await expect.poll(() => form.isVisible(), { timeout: 30_000 }).toBe(false);

        const chat = async (message: string) => {
          await page.goto(await open("new"));
          await waitForControlUiGatewayReady(page);
          await page.locator(".new-session-page__message").fill(message);
          await page.getByRole("button", { name: "Start session", exact: true }).click();
        };
        await chat("First message");
        await page.getByText("pong", { exact: true }).last().waitFor({ timeout: 60_000 });
        expect(chatRequests.length).toBeGreaterThan(0);

        await page.goto(await open("settings/model-providers"));
        await waitForControlUiGatewayReady(page);
        const row = await expandProvider(page, "tencent-tokenhub");
        await row
          .getByRole("button", { name: "Remove provider: Tencent Tokenhub", exact: true })
          .click();
        const dialog = page.locator("openclaw-modal-dialog");
        const confirm = dialog.getByRole("button", { name: "Remove provider", exact: true });
        await confirm.waitFor();
        const shot = async (name: string, content: Locator) => {
          // Capture settled frames, not the dialog's entry fade.
          await page.waitForFunction(() =>
            document
              .getAnimations()
              .every(
                (animation) =>
                  animation.playState !== "running" ||
                  animation.effect?.getTiming().iterations === Infinity,
              ),
          );
          await fs.writeFile(
            path.join(artifacts, name),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [content]),
          );
        };
        await shot("confirm.png", confirm);
        expect(await dialog.textContent()).toMatch(/Defaults for all agents keep using \S*hy4/i);
        await confirm.click();

        // The saved account is gone; the default stays selected and the page asks for a model.
        await expect
          .poll(
            () =>
              page
                .getByRole("button", { name: "Remove provider: Tencent Tokenhub", exact: true })
                .count(),
            { timeout: 30_000 },
          )
          .toBe(0);
        const required = page.getByText("Model required", { exact: true });
        await required.waitFor();
        await expect.poll(() => page.getByText("Checking models…").count()).toBe(0);
        await shot("after-remove.png", required);
        expect(await savedDefault()).toBe("tencent-tokenhub/hy4");

        const sent = chatRequests.length;
        await chat("Second message");
        await page.getByText("Couldn’t finish this reply").waitFor({ timeout: 60_000 });
        expect(chatRequests.slice(sent)).toEqual([]);
        expect(chatRequests.every((request) => request.hasAuth)).toBe(true);
      },
    );
  });
});
