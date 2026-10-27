import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getDeliveryQueueEntryStatus } from "../infra/delivery-queue-sqlite.test-support.js";
import { scheduleSessionDelivery } from "../infra/session-delivery-queue-runtime.js";
import {
  enqueueClaimedSessionDelivery,
  loadPendingSessionDeliveries,
  releaseSessionDeliveryClaim,
} from "../infra/session-delivery-queue-storage.js";
import { SESSION_DELIVERY_QUEUE_NAME } from "../infra/session-delivery-queue.records.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

// Keep the real delivery scheduler, but disable optional idle cache work that
// can retain admissions after this fixture closes its Gateway.
vi.mock("./server-idle-task.js", () => ({
  scheduleGatewayIdleTask: () => ({ stop: vi.fn() }),
}));

async function startProofProvider(requests: string[]): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(body);
      const outputText = body.includes("clock-jump readiness marker")
        ? "CLOCK_JUMP READY"
        : "CLOCK_JUMP DELIVERED";
      const message = { type: "message", id: "clock-jump-message", role: "assistant" };
      const events = [
        {
          type: "response.output_item.added",
          item: { ...message, content: [], status: "in_progress" },
        },
        {
          type: "response.output_item.done",
          item: {
            ...message,
            status: "completed",
            content: [{ type: "output_text", text: outputText, annotations: [] }],
          },
        },
        {
          type: "response.completed",
          response: { status: "completed" },
        },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

afterEach(() => {
  resetGatewayTestState();
  vi.restoreAllMocks();
});

it(
  "settles a released claim after a clock jump through a real Gateway client",
  { timeout: 90_000 },
  async ({ signal }) => {
    {
      const initialTime = Date.now();
      const wallClock = vi.spyOn(Date, "now").mockReturnValue(initialTime);
      const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome({
        prefix: "openclaw-session-delivery-gateway-",
      });
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => envSnapshot.restore());
      const queueContext = captureOpenClawStateWorkerContext();
      cleanup.defer(async () => {
        await closeOpenClawStateDatabaseByPathAsync(queueContext.admission.databasePath);
        await removeGatewayTempHome(tempHome);
      });
      let deliveryId = "";
      const providerRequests: string[] = [];
      const chatEvents: string[] = [];

      try {
        const providerServer = await startProofProvider(providerRequests);
        cleanup.defer(
          () =>
            new Promise<void>((resolve, reject) => {
              providerServer.close((error) => (error ? reject(error) : resolve()));
            }),
        );
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${providerAddress.port}/v1`,
        );
        const token = "clock-jump-proof-token";
        const configPath = await createGatewayConfigPath(tempHome);
        const sessionKey = "agent:main:clock-jump-proof";
        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: {
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
            },
            entries: { main: {} },
          },
          models: {
            mode: "replace",
            providers: {
              [provider.providerId]: {
                ...provider.config,
                request: { allowPrivateNetwork: true },
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
          plugins: { slots: { memory: "none" } },
          tools: { profile: "minimal" },
        } satisfies OpenClawConfig;
        const gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token,
          scopes: ["operator.admin", "operator.read", "operator.write"],
          onEvent: (event) => {
            if (event.event === "chat") {
              chatEvents.push(JSON.stringify(event.payload ?? {}));
            }
          },
        });
        cleanup.defer(async () => {
          try {
            await disconnectGatewayClient(gateway.client);
          } finally {
            await gateway.server.close({ reason: "session delivery clock-jump proof complete" });
            await expect(scheduleSessionDelivery(deliveryId, queueContext)).resolves.toBe(false);
          }
        });
        await gateway.server.startupSettled;
        // Gateway startup leaves first-turn preparation cold. Finish it before timing claim release.
        await expect(
          gateway.client.request(
            "agent",
            {
              sessionKey: "agent:main:clock-jump-readiness",
              message: "Reply with the clock-jump readiness marker.",
              idempotencyKey: "clock-jump-readiness",
            },
            { expectFinal: true, signal },
          ),
        ).resolves.toMatchObject({ status: "ok" });
        expect(providerRequests).toEqual([expect.stringContaining("clock-jump readiness marker")]);
        await gateway.client.request("sessions.messages.subscribe", { key: sessionKey });
        // Readiness must not consume the held claim timer that release needs to preempt.
        const { id } = await enqueueClaimedSessionDelivery(
          {
            kind: "agentTurn",
            sessionKey,
            message: "Reply with the clock-jump proof marker.",
            messageId: "image:clock-jump:agent-loop",
            idempotencyKey: "image:clock-jump:agent-loop",
            route: { channel: "webchat", to: sessionKey, chatType: "direct" },
            inputProvenance: {
              kind: "inter_session",
              sourceChannel: "internal",
              sourceTool: "image_generate",
            },
            sourceReplyDeliveryMode: "automatic",
          },
          60_000,
          queueContext,
        );

        deliveryId = id;
        await expect
          .poll(() => scheduleSessionDelivery(id, queueContext), { timeout: 10_000, interval: 50 })
          .toBe(true);

        wallClock.mockReturnValue(initialTime + 24 * 60 * 60 * 1_000);
        await releaseSessionDeliveryClaim(id, queueContext);
        await scheduleSessionDelivery(id, queueContext);

        await vi.waitFor(
          async () => {
            expect(await loadPendingSessionDeliveries(queueContext)).toStrictEqual([]);
            // Queue settlement can precede the client's WebSocket event callback.
            expect(chatEvents.join("\n")).toContain("CLOCK_JUMP DELIVERED");
          },
          { timeout: 15_000, interval: 50 },
        );
        expect(providerRequests).toEqual([
          expect.stringContaining("clock-jump readiness marker"),
          expect.stringContaining("clock-jump proof marker"),
        ]);
        expect(getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, id)).toBe("completed");
      } finally {
        wallClock.mockRestore();
      }
    }
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  },
);
