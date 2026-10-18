import assert from "node:assert/strict";
import { createServer } from "node:http";
import { expect, it, onTestFinished, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureGatewaySessionWorkAdmissions,
  getSessionWorkAdmissionRelease,
} from "../sessions/session-lifecycle-admission.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as queuedChatTurns from "./chat-queued-turns.js";
import * as providerFixture from "./gateway-provider-fixture.test-support.js";
import * as sourceFinalization from "./server-methods/chat-send-source-finalization.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";
import "./server.subagent-prompt-recent.gateway.test-support.js";

it(
  "records an actual RPC queued reply awaiting finalization during restart",
  { timeout: 120_000 },
  async ({ signal }) => {
    const token = "synthetic-rpc-owner-token";
    const state = await createOpenClawTestState({
      label: "rpc-restart-owner",
      env: {
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const sessionKey = "agent:main:rpc-restart-owner";
    const firstGate = createDeferred();
    const finalGate = createDeferred();
    const finalReached = createDeferred();
    const queuedRunRegistered = createDeferred();
    let firstReceived = false;
    let followupReceived = false;
    const tasks = new Set<Promise<void>>();
    const providerServer = createServer((request, response) => {
      const task = (async () => {
        const body = await providerFixture.readProviderBody(request);
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const followup = body.includes("SYNTHETIC_QUEUED_REPLY");
        if (followup) {
          followupReceived = true;
        } else if (body.includes("SYNTHETIC_FIRST_REPLY")) {
          firstReceived = true;
          await firstGate.promise;
        }
        if (!response.destroyed) {
          writeOpenAiResponsesText(response, {
            text: followup ? "QUEUED_REPLY_FOR_RECOVERY" : "FIRST_REPLY_COMPLETE",
            messageId: followup ? "queued-message" : "first-message",
            responseId: followup ? "queued-response" : "first-response",
          });
        }
      })().catch((error: unknown) => {
        if (!response.destroyed) {
          response.writeHead(500).end(String(error));
        }
      });
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    });
    const resources: {
      gateway?: Awaited<ReturnType<typeof startGatewayWithClient>>;
      replyReleased?: Promise<void>;
    } = {};
    let closed = false;
    let context: GatewayRequestContext | undefined;
    const registerQueuedTurn = queuedChatTurns.registerQueuedChatTurn;
    const registrationSpy = vi
      .spyOn(queuedChatTurns, "registerQueuedChatTurn")
      .mockImplementation((params) => {
        const registered = registerQueuedTurn(params);
        if (registered && params.runId === "rpc-queued") {
          queuedRunRegistered.resolve();
        }
        return registered;
      });
    const kernel = await import("./server-kernel-request-runtime.js");
    const prepare = kernel.prepareGatewayKernelRequestRuntime;
    const startupSpy = vi
      .spyOn(kernel, "prepareGatewayKernelRequestRuntime")
      .mockImplementation(async (params) => {
        const result = await prepare(params);
        context = result.gatewayRequestContext;
        return result;
      });
    const createFinalizer = sourceFinalization.createChatSendLateReplyFinalizer;
    const finalizationSpy = vi
      .spyOn(sourceFinalization, "createChatSendLateReplyFinalizer")
      .mockImplementation((params) => {
        const finalize = createFinalizer(params);
        return async (batch) => {
          if (batch.clientRunId === "rpc-queued" && batch.completion.kind !== "progress") {
            finalReached.resolve();
            await finalGate.promise;
          }
          return await finalize(batch);
        };
      });
    onTestFinished(async () => {
      startupSpy.mockRestore();
      registrationSpy.mockRestore();
      finalizationSpy.mockRestore();
      firstGate.resolve();
      finalGate.resolve();
      if (resources.gateway) {
        await disconnectGatewayClient(resources.gateway.client).catch(() => undefined);
        if (!closed) {
          await resources.gateway.server.close().catch(() => undefined);
        }
      }
      await resources.replyReleased;
      await providerFixture.closeProvider(providerServer);
      await Promise.allSettled(tasks);
      await state.cleanup();
    });
    const provider = buildMockOpenAiResponsesProvider(
      await providerFixture.listenProvider(providerServer),
      "gpt-rpc-owner-proof",
    );
    const cfg = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          model: { primary: provider.modelRef },
          models: {
            [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
          },
        },
        entries: { main: {} },
      },
      models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
      gateway: { auth: { mode: "token", token } },
      plugins: { slots: { memory: "none" } },
    } satisfies OpenClawConfig;
    const gateway = (resources.gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
    }));
    startupSpy.mockRestore();
    await gateway.server.startupSettled;
    const client = gateway.client;
    const send = (message: string, idempotencyKey: string) =>
      client.request("chat.send", {
        sessionKey,
        message,
        idempotencyKey,
        queueMode: "followup",
      });
    await send("SYNTHETIC_FIRST_REPLY", "rpc-first");
    await vi.waitFor(() => expect(firstReceived).toBe(true), { timeout: 60_000 });
    await send("SYNTHETIC_QUEUED_REPLY", "rpc-queued");
    // The queued input stays pending until delivery, so wait for its actual
    // registration before releasing the first reply that currently blocks it.
    await withinTest(queuedRunRegistered.promise, signal);
    const queued = client.request("agent.wait", { runId: "rpc-queued", timeoutMs: 30_000 });
    await expect(withinTest(queued, signal)).resolves.toMatchObject({
      runId: "rpc-queued",
      status: "pending",
      timeoutPhase: "queue",
    });
    expect(context?.chatQueuedTurns.has("rpc-queued")).toBe(true);
    firstGate.resolve();
    await withinTest(finalReached.promise, signal);
    expect(followupReceived).toBe(true);
    const history = await client.request<{ messages: unknown[] }>("chat.history", {
      sessionKey,
      limit: 20,
    });
    expect(history.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "QUEUED_REPLY_FOR_RECOVERY" }),
        ]),
      }),
    );
    assert(context?.resolveGatewayContext, "Missing actual Gateway resolver");
    const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
    const entry = sessionAccessor.loadSessionEntry({ storePath, sessionKey });
    assert(entry, "Real RPC did not create a session");
    const target = { scope: storePath, sessionKey, sessionId: entry.sessionId };
    resources.replyReleased = getSessionWorkAdmissionRelease({
      scope: storePath,
      identities: [sessionKey],
    });
    expect(captureGatewaySessionWorkAdmissions(() => context).isActive(target)).toBe(false);
    await gateway.server.close({
      reason: "synthetic queued reply restart",
      restartExpectedMs: 123,
      drainTimeoutMs: 0,
    });
    closed = true;
    const after = sessionAccessor.loadSessionEntry({ storePath, sessionKey });
    expect(after).toMatchObject({ abortedLastRun: true, restartRecoveryForceSafeTools: true });
    expect(context.resolveGatewayContext()).toBeUndefined();
  },
);
