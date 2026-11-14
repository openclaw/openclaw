// Inference is synthetic; WebChat admission, tool execution, persistence, and browser rendering are real.
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { writeToolCall } from "../../../src/gateway/gateway-provider-fixture.test-support.ts";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:telegram:direct:123:thread:123:456";
const prompt = "Show progress here before completing this task.";
const progress = "The active WebChat progress is saved.";
const final = "The active WebChat task is complete.";
let instance: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>>;

async function startProvider() {
  const failures: string[] = [];
  let requests = 0;
  let toolOutput = "";
  const owned = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            request.resume();
            response.writeHead(404).end();
            return;
          }
          const body = asOptionalRecord(JSON.parse((await buffer(request)).toString("utf8")));
          if (body?.model === "metadata") {
            writeOpenAiResponsesText(response, {
              text: "Active WebChat source proof",
              messageId: "metadata",
              responseId: "metadata",
            });
            return;
          }
          expect(body?.model).toBe("source-reply");
          const input = JSON.stringify(body?.input);
          if (requests++ === 0) {
            expect(input).toContain(prompt);
            writeToolCall(response, "message", { action: "send", message: progress, final: false });
          } else {
            expect(requests).toBe(2);
            const outputs = Array.isArray(body?.input)
              ? body.input.filter((item) => asOptionalRecord(item)?.type === "function_call_output")
              : [];
            toolOutput = JSON.stringify(outputs);
            writeOpenAiResponsesText(response, {
              text: final,
              messageId: "final",
              responseId: "final",
            });
          }
        })().catch((error: unknown) => {
          failures.push(String(error));
          if (!response.headersSent) {
            response.writeHead(500);
          }
          response.end("Synthetic provider failed");
        });
      }),
  });
  return {
    port: owned.claim.port,
    failures,
    result: () => ({ requests, toolOutput }),
    close: () =>
      runQaGatewayFixture(async () => {
        owned.listener.closeAllConnections();
        await owned.releaseListener();
      }, owned.claim.release),
  };
}

let provider: Awaited<ReturnType<typeof startProvider>>;
const suite = createControlUiE2eSuite({
  name: "Active WebChat source reply through a real Gateway",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      client = await connectChatGateway(instance, signal);
    },
    async close() {
      await client?.stopAndWait();
    },
  },
  async startServer() {
    provider = await startProvider();
    const close = () =>
      runQaGatewayFixture(
        async () => {},
        () => instance?.cleanup(),
        () => provider.close(),
      );
    try {
      instance = await createOpenClawTestInstance({
        name: "active-source-reply-proof",
        entrypoint: ["dist/index.js"],
        env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
        config: {
          update: { checkOnStart: false },
          gateway: { controlUi: { enabled: true } },
          cron: { enabled: false },
          browser: { enabled: false },
          tools: { profile: "full", codeMode: false, toolSearch: false },
          agents: {
            ownership: "explicit",
            defaults: {
              workspace: "${OPENCLAW_WORKSPACE_DIR}",
              model: "source-fixture/source-reply",
              utilityModel: "source-fixture/metadata",
              modelPolicy: { allow: ["source-fixture/*"] },
              models: {
                "source-fixture/source-reply": { params: { transport: "sse" } },
                "source-fixture/metadata": { params: { transport: "sse" } },
              },
            },
            entries: { main: { identity: { name: "Source reply assistant" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "source-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-source-fixture-key",
                baseUrl: `http://127.0.0.1:${provider.port}/v1`,
                request: { allowPrivateNetwork: true },
                models: [
                  { id: "source-reply", name: "Source reply" },
                  { id: "metadata", name: "Metadata" },
                ],
              },
            },
          },
          plugins: { allow: ["openai"] },
        },
      });
      instance.env.OPENCLAW_WORKSPACE_DIR = instance.state.path("workspace");
      await mkdir(instance.env.OPENCLAW_WORKSPACE_DIR, { recursive: true });
      ensureGatewayOwnerProfile("Synthetic source operator", { env: instance.env });
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
    } catch (error) {
      return runQaGatewayFixture(async () => {
        throw error;
      }, close);
    }
  },
});

suite.define(() => {
  it("keeps targetless progress in a Telegram-shaped WebChat session across reload", async () => {
    await client.request("sessions.create", {
      key: sessionKey,
      agentId: "main",
      label: "Active source proof",
      permissionMode: "full",
    });
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        permissions: ["local-network-access"],
        viewport: { width: 1280, height: 900 },
      },
      async ({ page }) => {
        await pairFixture(page, instance);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await waitForControlUiGatewayReady(page);
        await assertServedUi(page, suite.server.baseUrl);
        const { pane, composer, send, stop } = chatControls(page);
        await composer.fill(prompt);
        await send.click();
        const assistant = pane.locator(".chat-group.assistant .chat-bubble");
        await assistant.getByText(final, { exact: true }).waitFor();
        await stop.waitFor({ state: "detached" });
        expect(provider.failures).toEqual([]);
        expect(provider.result().requests).toBe(2);
        expect(provider.result().toolOutput).toContain(
          "Sent visible reply to the current source conversation via internal-ui.",
        );
        expect(await assistant.getByText(progress, { exact: true }).count()).toBe(1);
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await assistant.getByText(final, { exact: true }).waitFor();
        expect(await assistant.getByText(progress, { exact: true }).count()).toBe(1);
        expect(provider.result().requests).toBe(2);
      },
    );
  });
});
