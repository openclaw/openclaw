import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { AuditRunInspectResult } from "../../../packages/gateway-protocol/src/schema/audit-run.js";
import type { GatewayFrame } from "../../../packages/gateway-protocol/src/schema/frames.js";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { pairControlUiPage } from "../test-helpers/control-ui-browser-pairing.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  installControlUiE2ePageDiagnosticRing,
  installControlUiE2eUnhandledRejectionRing,
} from "../test-helpers/control-ui-e2e-diagnostics.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installControlUiE2eRendererStallProbe } from "../test-helpers/control-ui-e2e-renderer-stall.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { withControlUiRunInspector } from "../test-helpers/control-ui-run-inspector.ts";
import { showHeading, showText } from "./activity-assertions.test-support.ts";
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
        for (const url of [browserUrl, controlUiSessionUrl(suite.server.baseUrl, sessionKey)]) {
          await chat.goto(url);
          await waitForControlUiGatewayReady(chat);
        }
        await showText(chat, replyText);
        const composer = chat.getByRole("textbox", { name: "Chat composer", exact: true });
        const draft = "Keep this unsent Inspector draft";
        await composer.fill(draft);
        const chatUrl = chat.url();

        // Explicit replay must fail even when this context already has a paired device.
        const replay = await context.newPage();
        const rejectionDetails: unknown[] = [];
        replay.on("websocket", (socket) => {
          socket.on("framereceived", ({ payload }) => {
            const frame: GatewayFrame = JSON.parse(String(payload));
            if (frame.type === "res" && !frame.ok && frame.error) {
              rejectionDetails.push(frame.error.details);
            }
          });
        });
        await replay.goto(browserUrl);
        await showText(replay, "Pairing link is no longer valid", false);
        expect(rejectionDetails).toContainEqual(
          expect.objectContaining({ code: "AUTH_BOOTSTRAP_TOKEN_INVALID" }),
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
              preparePage: async (page) => {
                installControlUiE2ePageDiagnosticRing(page);
                await installControlUiE2eUnhandledRejectionRing(page);
                await installControlUiE2eRendererStallProbe(page);
                await pairControlUiPage(page, runCli);
              },
            },
            async (page, inspector) => {
              try {
                for (const reload of [false, true]) {
                  if (reload) {
                    await page.reload();
                  }
                  await inspector.waitFor({ state: "visible" });
                  await showHeading(page, "Identity and authority");
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
                }
              } catch (error) {
                await captureControlUiE2eFailureDiagnostics(page, {
                  error: error instanceof Error ? error : new Error(String(error)),
                  label: "Run Inspector identity retention",
                });
                throw error;
              }
            },
          );
          expect(context.pages()).toEqual([chat]);
          expect(freshContext.pages()).toEqual([]);
          expect(chat.url()).toBe(chatUrl);
          expect(await composer.inputValue()).toBe(draft);
        }
        await chat.reload();
        await waitForControlUiGatewayReady(chat);
        await showText(chat, replyText);
      },
    });
  }, 90_000);
});
