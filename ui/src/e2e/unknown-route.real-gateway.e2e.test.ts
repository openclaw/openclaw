import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { assertServedUi, pairFixture } from "./chat-lifecycle.test-support.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:unrelated-route";
const message = "Unrelated session fixture";
let owner: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>>;
const suite = createControlUiE2eSuite({
  name: "Unknown links through a real Gateway",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      client = await connectChatGateway(owner, signal);
      await client.request("sessions.create", { key: sessionKey, agentId: "main" });
      await client.request("chat.inject", { sessionKey, message });
    },
    async close() {
      await client?.stopAndWait();
    },
  },
  async startServer() {
    owner = await createOpenClawTestInstance({
      name: "unknown-route",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined, NODE_ENV: undefined },
      config: {
        gateway: { controlUi: { enabled: true } },
        plugins: { enabled: false },
        cron: { enabled: false },
        agents: {
          defaults: { model: "fixture/unused", modelPolicy: { allow: ["fixture/unused"] } },
          entries: { main: { identity: { name: "Route fixture" } } },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "synthetic-route-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [{ id: "unused", name: "Unused fixture model" }],
            },
          },
        },
      },
    });
    try {
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await owner.cleanup();
      throw error;
    }
  },
});

suite.define(() => {
  it.each([
    { width: 1280, height: 900 },
    { width: 400, height: 820 },
  ])(
    "keeps an invalid link separate from a saved session at $width px",
    async (viewport) => {
      await suite.withPage(
        { viewport, locale: "en-US", serviceWorkers: "block" },
        async ({ page }) => {
          await pairFixture(page, owner);
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await waitForControlUiRoute(page, { routeId: "chat" });
          const transcript = page.getByText(message, { exact: true });
          await transcript.waitFor({ state: "visible" });
          await assertServedUi(page, suite.server.baseUrl);

          const requested = new URL(
            "beam/unfinished-share-5?proof=missing#anchor",
            suite.server.baseUrl,
          );
          await page.goto(requested.href);
          await waitForControlUiGatewayReady(page);
          await page.waitForFunction(() => {
            const state = window.openclawControlUi?.snapshot().route;
            return state?.status === "notFound" || state?.status === "success";
          });
          const notice = page.getByText("Page not found", { exact: true });
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const visible = (await notice.isVisible()) ? notice : transcript;
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator("body"),
              [visible],
              {
                animations: "disabled",
              },
            );
            await writeFile(
              path.join(suite.artifactDir, `unknown-route-${viewport.width}.png`),
              frame.png,
            );
          }
          await notice.waitFor({ state: "visible" });
          expect(page.url()).toBe(requested.href);
          expect(await transcript.isVisible()).toBe(false);
          expect(
            await page.getByRole("textbox", { name: "Chat composer", exact: true }).isVisible(),
          ).toBe(false);

          await page.reload();
          await notice.waitFor({ state: "visible" });
          expect(page.url()).toBe(requested.href);
          await page.getByRole("link", { name: "Go to chat", exact: true }).click();
          await waitForControlUiRoute(page, { routeId: "chat" });
          await page.goBack();
          await notice.waitFor({ state: "visible" });
          expect(page.url()).toBe(requested.href);
          await page.goForward();
          await waitForControlUiRoute(page, { routeId: "chat" });
        },
      );
    },
    120_000,
  );
});
