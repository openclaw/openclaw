// The chat transcript is a fixture so the test can reach the browser card without
// an agent turn; the preview RPC is forwarded to a real isolated Gateway.
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { callGateway } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI real-Gateway link preview proof" });

function browserHistory(url: string) {
  const browserTab = { target: "host", profile: "managed", targetId: "tab-0", url };
  return [
    {
      role: "assistant",
      timestamp: 2000,
      content: [
        { type: "toolCall", id: "open-0", name: "browser", arguments: { action: "open", url } },
      ],
    },
    {
      role: "toolResult",
      timestamp: 2500,
      toolCallId: "open-0",
      toolName: "browser",
      content: [{ type: "text", text: `Opened ${url} in tab-0` }],
      details: { browserTab },
    },
  ];
}

suite.define(() => {
  it("receives the opted-in empty preview from a real Gateway", async () => {
    const instance = await createOpenClawTestInstance({
      name: "link-preview-real-gateway",
      entrypoint: ["dist/index.js"],
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        update: { checkOnStart: false },
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
        browser: { enabled: false },
        agents: { defaults: { workspace: "${OPENCLAW_WORKSPACE_DIR}" } },
        plugins: { allow: [] },
      },
    });
    try {
      await instance.startGateway();
      const url = "http://127.0.0.1:8080/";
      let realResponse: unknown;
      let handlerError: unknown;
      await suite.withPage(
        { viewport: { width: 390, height: 844 }, colorScheme: "light", serviceWorkers: "block" },
        async ({ page }) => {
          const gateway = await installMockGateway(
            page,
            {
              automaticallyFetchFavicons: true,
              featureMethods: [],
              historyMessages: [
                { role: "user", content: "Preview a local page.", timestamp: 1000 },
                ...browserHistory(url),
                { role: "assistant", content: "Local page ready.", timestamp: 5000 },
              ],
            },
            {
              requestHandlers: {
                "controlUi.linkPreview": async (params) => {
                  try {
                    const output = await callGateway(
                      instance,
                      "controlUi.linkPreview",
                      params as Record<string, unknown>,
                    );
                    realResponse = JSON.parse(output);
                    return realResponse;
                  } catch (error) {
                    handlerError = error;
                    throw error;
                  }
                },
              },
            },
          );
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText("Local page ready.", { exact: true }).waitFor();
          const card = page.locator("openclaw-browser-tab-card").filter({ hasText: url });
          await expect.poll(() => card.count()).toBe(1);
          await expect.poll(() => card.locator(".url").textContent()).toBe(url);
          const request = await gateway.waitForRequest("controlUi.linkPreview", {
            match: { url, allowUnavailable: true },
          });
          expect(request.params).toMatchObject({ url, allowUnavailable: true });
          await expect.poll(() => realResponse ?? handlerError).toEqual({});
          writeFileSync(
            `${suite.artifactDir}/real-gateway-link-preview.json`,
            JSON.stringify({ request: request.params, response: realResponse }, null, 2),
          );
          await page.screenshot({
            path: `${suite.artifactDir}/real-gateway-local-browser-card.png`,
          });
        },
      );
    } finally {
      await instance.cleanup();
    }
  });
});
