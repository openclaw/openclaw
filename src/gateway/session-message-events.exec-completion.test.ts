import { createServer, type Server } from "node:http";
import { json } from "node:stream/consumers";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
  type SessionEventReceipt,
} from "../auto-reply/reply/session-event-handoff.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { peekSystemEventEntries } from "../infra/system-events.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
let providerServer: Server | undefined;
let providerClaim: TestPortClaim | undefined;
let startup: Promise<void> | undefined;
const fixture = createFixtureLifetime();
const token = "exec-completion-test";
const providerRequests: string[] = [];
const providerErrors: unknown[] = [];

beforeAll(() => {
  startup = fixture.run(async () => {
    state = await createOpenClawTestState({
      label: "exec-completion-publication",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
      },
    });
    providerClaim = await acquireTestPortBlock({ offsets: [0] });
    providerServer = createServer((request, response) => {
      void (async () => {
        const body = JSON.stringify(await json(request));
        const title = body.includes("Generate a concise session title");
        const marker = body.match(/EXEC_NOTIFICATION_(?:false|true|silent|metadata)/)?.[0];
        if (!title) {
          providerRequests.push(body);
        }
        writeOpenAiResponsesText(response, {
          text: title
            ? "Exec completion proof"
            : marker === "EXEC_NOTIFICATION_silent"
              ? "NO_REPLY"
              : (marker ?? "Unexpected request"),
          messageId: `message-${providerRequests.length}`,
          responseId: `response-${providerRequests.length}`,
        });
      })().catch((error: unknown) => {
        providerErrors.push(error);
        if (!response.headersSent) {
          response.writeHead(500);
        }
        response.end();
      });
    });
    const server = providerServer;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(providerClaim!.port, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock provider did not bind");
    }
    const provider = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${address.port}/v1`,
      "exec-completion",
    );
    const cfg = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: provider.modelRef },
          models: {
            [provider.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
        },
      },
      models: {
        mode: "replace",
        catalogRefresh: { enabled: false },
        providers: {
          [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
        },
      },
      plugins: { slots: { memory: "none" } },
      messages: { visibleReplies: "message_tool" },
      tools: { profile: "minimal" },
      gateway: { auth: { mode: "token", token } },
    } satisfies OpenClawConfig;
    gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    await gateway.server.startupSettled;
  });
  return startup;
});

afterAll(async () => {
  await runQaGatewayFixture(
    async () => {
      await startup;
    },
    () => gateway && disconnectGatewayClient(gateway.client),
    () => gateway?.server.close({ reason: "exec completion proof complete" }),
    async () => {
      const server = providerServer;
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
    () => providerClaim?.release(),
    () => state?.cleanup(),
    () => fixture.cleanup(),
  );
});

describe("exec completion WebChat publication", () => {
  test.for([
    { name: "connected WebChat", disconnected: false, silent: false },
    { name: "disconnected WebChat", disconnected: true, silent: false },
    { name: "silent completion", disconnected: false, silent: true },
    {
      name: "metadata-only code 0 publication",
      disconnected: false,
      silent: false,
      metadataOnly: true,
    },
  ])("settles $name once", async ({ disconnected, silent, metadataOnly }, { signal }) => {
    if (!gateway) {
      throw new Error("Gateway did not start");
    }
    const suffix = metadataOnly ? "metadata" : silent ? "silent" : String(disconnected);
    const sessionKey = `agent:main:dashboard:exec-completion-${suffix}`;
    const marker = `EXEC_NOTIFICATION_${suffix}`;
    await gateway.client.request("sessions.create", { key: sessionKey });
    const live = createDeferred<unknown>();
    const notifications: unknown[] = [];
    const committedNotifications: unknown[] = [];
    const connect = () =>
      connectGatewayClient({
        url: `ws://127.0.0.1:${gateway!.port}`,
        origin: `http://127.0.0.1:${gateway!.port}`,
        token,
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        platform: "web",
        caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        scopes: ["operator.read"],
        onEvent: (event) => {
          const payload = asOptionalRecord(event.payload);
          const message = asOptionalRecord(payload?.message);
          if (
            event.event === "session.message" &&
            payload?.sessionKey === sessionKey &&
            message?.role === "assistant" &&
            (silent || JSON.stringify(message.content).includes(marker))
          ) {
            notifications.push(message);
            live.resolve(message);
          }
        },
      });
    let client = await connect();
    let receipt: SessionEventReceipt | undefined;
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      const message = asOptionalRecord(update.message);
      if (
        update.sessionKey === sessionKey &&
        message?.role === "assistant" &&
        JSON.stringify(message.content).includes(marker)
      ) {
        committedNotifications.push(message);
      }
    });
    try {
      await client.request("sessions.messages.subscribe", { key: sessionKey });
      if (disconnected) {
        await disconnectGatewayClient(client);
      }
      const expectedTarget = await captureSessionEventTargetForHost("main", sessionKey);
      expect(expectedTarget.lifecycleRevision).toEqual(expect.any(String));
      const completion = metadataOnly
        ? `Exec completed (${marker}, code 0)`
        : `Exec completed (webchat-proof, code 0) :: ${marker}`;
      receipt = enqueueSessionEventForHost(completion, {
        agentId: "main",
        sessionKey,
        source: "exec",
        expectedTarget,
      });
      expect(await withinTest(receipt.settled, signal)).toMatchObject({
        status: "completed",
        executionStarted: true,
        delivered: false,
        ...(silent ? { deliverySuppressionReason: "silent" } : {}),
      });
      expect(committedNotifications).toHaveLength(silent ? 0 : 1);
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      expect(receipt.cancel()).toBe(false);
      if (!disconnected && !silent) {
        expect(await withinTest(live.promise, signal)).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: marker }],
        });
      }
      await disconnectGatewayClient(client);
      client = await connect();
      const history = await client.request<{
        sessionId: string;
        messages: Array<{ role?: string; content?: unknown }>;
      }>("chat.history", { sessionKey });
      expect(history.sessionId).toBe(expectedTarget.sessionId);
      expect(
        history.messages.filter(
          (message) =>
            message.role === "assistant" &&
            (silent || JSON.stringify(message.content).includes(marker)),
        ),
      ).toHaveLength(silent ? 0 : 1);
      expect(notifications).toHaveLength(disconnected || silent ? 0 : 1);
      expect(providerRequests.filter((request) => request.includes(marker))).toHaveLength(1);
      if (metadataOnly) {
        expect(providerRequests.find((request) => request.includes(marker))).toContain(completion);
      }
      expect(providerErrors).toEqual([]);
    } finally {
      receipt?.cancel();
      await receipt?.settled;
      unsubscribe();
      await disconnectGatewayClient(client);
    }
  });
});
