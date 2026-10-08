import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { AuditRunInspectResult } from "../../../packages/gateway-protocol/src/schema/audit-run.js";
import type {
  ErrorShape,
  GatewayFrame,
} from "../../../packages/gateway-protocol/src/schema/frames.js";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { withControlUiRunInspector } from "../test-helpers/control-ui-run-inspector.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const replyText = "Inspector pairing fixture completed.";
let instance: OpenClawTestInstance;
const suite = createControlUiE2eSuite({
  name: "Run Inspector with real browser pairing",
  startServerBeforeBrowser: true,
  async startServer() {
    const provider = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          request.resume().once("end", () => {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            writeOpenAiResponsesText(response, {
              text: replyText,
              messageId: "inspector-message",
              responseId: "inspector-response",
            });
          });
        }),
    });
    const cleanup = () =>
      runQaGatewayFixture(
        () => instance?.cleanup(),
        async () => {
          provider.listener.closeAllConnections();
          await provider.releaseListener();
        },
        () => provider.claim.release(),
      );
    try {
      instance = await createOpenClawTestInstance({
        name: "inspector-pairing",
        env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
        config: {
          gateway: { controlUi: { enabled: true } },
          logging: { audit: { executionIdentity: true } },
          cron: { enabled: false },
          agents: {
            ownership: "explicit",
            defaults: {
              model: "inspector-fixture/echo",
              modelPolicy: { allow: ["inspector-fixture/*"] },
            },
            entries: { main: { identity: { name: "Inspector fixture" } } },
          },
          models: {
            catalogRefresh: { enabled: false },
            providers: {
              "inspector-fixture": {
                api: "openai-responses",
                apiKey: "synthetic-unused-key",
                baseUrl: `http://127.0.0.1:${provider.claim.port}/v1`,
                models: [{ id: "echo", name: "Echo" }],
              },
            },
          },
          plugins: { allow: [] },
        },
      });
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close: cleanup };
    } catch (error) {
      return runQaGatewayFixture(async () => {
        throw error;
      }, cleanup);
    }
  },
});

async function runCli(args: string[]): Promise<string> {
  const result = await instance.cli(args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

async function rpc(method: string, params: Record<string, unknown>) {
  return JSON.parse(
    await runCli(["gateway", "call", method, "--params", JSON.stringify(params), "--json"]),
  );
}

suite.define(() => {
  it("pairs each Inspector page independently and retains identity across reload", async (test) => {
    await suite.runScenario(test, {
      retainedState: () => instance.stateDir,
      run: async () => {
        const sessionKey = "agent:main:inspector-pairing";
        await rpc("sessions.create", { key: sessionKey, agentId: "main" });
        const runId = randomUUID();
        await rpc("chat.send", {
          sessionKey,
          message: "Complete the fixture.",
          idempotencyKey: runId,
        });
        expect(await rpc("agent.wait", { runId, timeoutMs: 30_000 })).toMatchObject({
          status: "ok",
          terminalReply: { disposition: "visible", text: replyText },
        });
        const inspected: AuditRunInspectResult = await rpc("audit.run.inspect", { runId });
        if (inspected.identity.state !== "present") {
          throw new Error(`Fixture identity is ${inspected.identity.state}`);
        }
        const { executionId } = inspected.identity.context;
        const receipt = inspected.decisionDisplays.find(
          (display) =>
            display.provenance.state === "verified" &&
            display.provenance.producer === "run-admission",
        );
        if (!receipt) {
          throw new Error("Fixture run admission receipt is missing");
        }
        const { browserUrl }: { browserUrl: string } = JSON.parse(
          await runCli(["dashboard", "--json"]),
        );
        const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
        const freshContext = await suite.newBrowserContext(createControlUiE2eContextOptions());
        for (const browserContext of [context, freshContext]) {
          await browserContext.addInitScript(() => {
            localStorage.setItem("openclaw:control-ui:community-invite:v2", "dismissed");
          });
        }
        const chat = await context.newPage();
        // Keep this handoff only for the explicit replay rejection below.
        await chat.goto(browserUrl);
        await waitForControlUiGatewayReady(chat);
        await chat.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await enterControlUiSession(chat);
        await chat.getByText(replyText, { exact: true }).waitFor();
        const composer = chat.getByRole("textbox", { name: "Chat composer", exact: true });
        const draft = "Keep this unsent Inspector draft";
        await composer.fill(draft);
        const chatUrl = chat.url();

        // Explicit replay must fail even when this context already has a paired device.
        const replay = await context.newPage();
        const rejections: ErrorShape[] = [];
        replay.on("websocket", (socket) => {
          socket.on("framereceived", ({ payload }) => {
            const frame: GatewayFrame = JSON.parse(String(payload));
            if (frame.type === "res" && !frame.ok && frame.error) {
              rejections.push(frame.error);
            }
          });
        });
        await replay.goto(browserUrl);
        await replay.getByText("Pairing link is no longer valid", { exact: false }).waitFor();
        expect(rejections).toContainEqual(
          expect.objectContaining({
            details: expect.objectContaining({ code: "AUTH_BOOTSTRAP_TOKEN_INVALID" }),
          }),
        );
        expect(await replay.locator("#activity-run-panel").count()).toBe(0);
        await replay.close();

        for (const inspectorContext of [context, freshContext]) {
          await withControlUiRunInspector(
            inspectorContext,
            {
              baseUrl: suite.server.baseUrl,
              selector: { kind: "execution", id: executionId },
              receipt: { id: receipt.selectorId },
              preparePage: (page) => pairControlUiPage(page, runCli),
            },
            async (page, inspector) => {
              const assertIdentity = async () => {
                await inspector.waitFor({ state: "visible" });
                await page.getByRole("heading", { name: "Identity and authority" }).waitFor();
                expect(await inspector.getAttribute("data-execution-id")).toBe(executionId);
                expect(await inspector.getAttribute("data-run-id")).toBe(runId);
                const detail = inspector.locator(
                  '[aria-labelledby="run-inspector-receipt-detail"]',
                );
                await detail.waitFor({ state: "visible" });
                expect(await detail.getAttribute("data-receipt-selector-id")).toBe(
                  receipt.selectorId,
                );
                expect(await detail.textContent()).toContain(receipt.decision.reasonCode);
              };
              await assertIdentity();
              await page.reload();
              await assertIdentity();
            },
          );
          expect(context.pages()).toEqual([chat]);
          expect(freshContext.pages()).toEqual([]);
          expect(chat.url()).toBe(chatUrl);
          expect(await composer.inputValue()).toBe(draft);
        }
        await chat.reload();
        await enterControlUiSession(chat);
        await chat.getByText(replyText, { exact: true }).waitFor();
      },
    });
  }, 90_000);
});
