// Load real Gateway/model owners before the fixture deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID, X509Certificate } from "node:crypto";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import * as queueLifecycle from "../auto-reply/reply/queue/lifecycle.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultRuntime } from "../runtime.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  closeProvider,
  listenProvider,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "finishes queued operator auto-fast progress after its predecessor completes",
  { timeout: 90_000 },
  async ({ signal }) => {
    const waitForGate = (gate: PromiseLike<unknown>, work: PromiseLike<unknown>, message: string) =>
      withinTest(awaitGateBeforeSettlement(gate, work, message), signal);
    const state = await createOpenClawTestState({
      label: "queued-authority",
      env: {
        ...KERNEL_TEST_ENV,
        VITEST: process.env.VITEST,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const firstReached = createDeferred();
    const releaseFirst = createDeferred();
    const toolReached = createDeferred();
    const releaseTool = createDeferred();
    const enqueued = createDeferred();
    const terminalEvents = new Map<string, ReturnType<typeof createDeferred<string>>>();
    const terminalFor = (runId: string) => {
      let terminal = terminalEvents.get(runId);
      if (!terminal) {
        terminal = createDeferred<string>();
        terminalEvents.set(runId, terminal);
      }
      return terminal;
    };
    const enqueue = queueLifecycle.markFollowupRunEnqueued;
    const observeQueue = vi
      .spyOn(queueLifecycle, "markFollowupRunEnqueued")
      .mockImplementation((run) => {
        const result = enqueue(run);
        if (result) {
          enqueued.resolve();
        }
        return result;
      });
    const logError = vi.spyOn(defaultRuntime, "error");
    const realNow = Date.now.bind(Date);
    let clock: { mockRestore(): void } | undefined;
    let providerUrl = "";
    let calls = 0;
    const providerErrors: unknown[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        if (request.url === "/tool") {
          toolReached.resolve();
          await releaseTool.promise;
          response.end("synthetic tool completed");
          return;
        }
        request.resume();
        if (++calls === 1) {
          firstReached.resolve();
          await releaseFirst.promise;
        } else if (calls === 2) {
          writeToolCall(response, "exec", {
            command: `node -e 'fetch("${providerUrl}/tool").then(r=>r.text()).then(console.log)'`,
          });
          return;
        }
        writeOpenAiResponsesText(response, {
          text: calls === 1 ? "First turn complete." : "Follow-up completed successfully.",
          messageId: randomUUID(),
          responseId: randomUUID(),
        });
      })().catch((error: unknown) => {
        providerErrors.push(error);
        response.writeHead(500).end("fixture failure");
      });
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      const baseUrl = await listenProvider(server);
      providerUrl = baseUrl.replace(/\/v1$/, "");
      const model = buildMockOpenAiResponsesProvider(baseUrl, "queued-authority");
      const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
      const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
      const scopes: OperatorScope[] = ["operator.read", "operator.write"];
      const connection = {
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        origin: "https://control.example.com",
        tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
        scopes,
        edgeAuthHeaders: {
          "x-forwarded-user": "operator@example.test",
          "x-forwarded-for": "203.0.113.50",
          "x-forwarded-proto": "https",
        },
      };
      const cfg = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            utilityModel: "",
            model: { primary: model.modelRef },
            models: {
              [model.modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
        },
        models: {
          mode: "replace",
          providers: {
            [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
          },
        },
        plugins: { enabled: false, slots: { memory: "none" } },
        tools: {
          allow: ["exec"],
          codeMode: { enabled: false },
          toolSearch: false,
          exec: { host: "gateway", security: "full", ask: "off" },
        },
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-forwarded-user",
              requiredHeaders: ["x-forwarded-proto"],
              allowUsers: ["operator@example.test"],
              allowLoopback: true,
              deviceAutoApprove: { enabled: true, scopes },
            },
          },
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: [connection.origin] },
          tls: { enabled: true, autoGenerate: false, certPath, keyPath },
          roles: {
            default: "operator",
            definitions: { operator: { sessions: { others: "write" }, agents: "*", scopes } },
          },
        },
      } satisfies OpenClawConfig;
      gateway = await startGatewayWithClient({
        ...connection,
        cfg,
        configPath: state.configPath,
        portClaim: await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] }),
        auth: cfg.gateway.auth,
        secure: true,
        onEvent: ({ event, payload }) => {
          if (event !== "chat") {
            return;
          }
          const chat = payload as { runId: string; state: string };
          if (["final", "error", "aborted"].includes(chat.state)) {
            terminalFor(chat.runId).resolve(chat.state);
          }
        },
      });
      await gateway.server.startupSettled;
      const client = gateway.client;
      const profile = await client.request<{ profile: { id: string } }>("users.self", {});
      expect(profile.profile.id).not.toBe(GATEWAY_OWNER_PROFILE_ID);
      const sessionKey = `agent:main:authority-${randomUUID()}`;
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: randomUUID(),
          updatedAt: Date.now(),
          verboseLevel: "full",
          createdActor: { type: "human", source: "profile", id: profile.profile.id },
        },
      );
      const send = (message: string, followup = false) =>
        client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message,
          queueMode: followup ? "followup" : undefined,
          deliver: false,
          fastMode: "auto",
          fastAutoOnSeconds: 1,
          idempotencyKey: randomUUID(),
        });
      const first = await send("Synthetic first turn");
      const firstTerminal = terminalFor(first.runId).promise;
      await waitForGate(
        firstReached.promise,
        firstTerminal,
        "First turn settled before reaching the provider",
      );
      const followup = await send("Synthetic queued follow-up", true);
      await withinTest(enqueued.promise, signal);
      releaseFirst.resolve();
      const terminal = terminalFor(followup.runId).promise;
      await waitForGate(
        toolReached.promise,
        terminal,
        "Follow-up settled before executing its tool",
      );
      expect(await withinTest(firstTerminal, signal)).toBe("final");
      // Cross the auto-fast cutoff without sleeping or changing timer scheduling.
      clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 2_000);
      releaseTool.resolve();
      expect(await withinTest(terminal, signal)).toBe("final");
      expect(providerErrors).toEqual([]);
      expect(logError.mock.calls.flat().join("\n")).not.toContain("operator execution authority");
    } finally {
      clock?.mockRestore();
      releaseFirst.resolve();
      releaseTool.resolve();
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
      }
      await gateway?.server.close({ reason: "queued operator authority test complete" });
      await closeProvider(server);
      observeQueue.mockRestore();
      logError.mockRestore();
      await state.cleanup();
    }
  },
);
