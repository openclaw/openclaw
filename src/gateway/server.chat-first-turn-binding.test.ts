import { createServer, type ServerResponse } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { activeExecRequestOwners } from "../infra/exec-request-context.js";
import { areHeartbeatsEnabled, setHeartbeatsEnabled } from "../infra/heartbeat-wake.js";
import type { RpcSourceRef } from "../sessions/session-controller.rpc-sources.js";
import {
  getRpcSourceIdentity,
  requestRpcSourceCancellation,
} from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeProvider,
  listenProvider,
  readProviderBody,
} from "./gateway-provider-fixture.test-support.js";
import * as subscriptions from "./server-runtime-subscriptions.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it("binds a first native chat.send before streaming and persists its stopped partial", async () => {
  const state = await createOpenClawTestState({
    label: "first-turn-binding",
    env: {
      ...KERNEL_TEST_ENV,
      VITEST: process.env.VITEST,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
  const runId = "first-native-turn";
  const sessionKey = "agent:main:first-turn-binding";
  const partial = "This is the first native assistant partial.";
  const providerResponse = createDeferred<ServerResponse>();
  const providerClosed = createDeferred();
  const firstDelta = createDeferred();
  const terminal = createDeferred();
  const persistedPartial = createDeferred();
  const requestBodies: string[] = [];
  // Call-through observation exposes the real Gateway-owned buffer and registration.
  const observeSubscriptions = vi.spyOn(subscriptions, "startGatewayEventSubscriptions");
  const providerServer = createServer((request, response) => {
    void (async () => {
      requestBodies.push(await readProviderBody(request));
      response.once("close", () => providerClosed.resolve());
      providerResponse.resolve(response);
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined = undefined;
  let original: RpcSourceRef | undefined = undefined;
  const lifecycle: Array<{ phase?: unknown; sessionId?: unknown; aborted?: unknown }> = [];
  const heartbeatsEnabled = areHeartbeatsEnabled();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => setHeartbeatsEnabled(heartbeatsEnabled));
  cleanup.defer(() => state.cleanup());
  cleanup.defer(() => observeSubscriptions.mockRestore());
  cleanup.defer(async () => {
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "first-turn binding test cleanup" });
    }
  });
  cleanup.defer(() => closeProvider(providerServer));
  cleanup.defer(() => {
    if (original) {
      requestRpcSourceCancellation(original);
    }
  });
  // A zero interval still permits event-driven wakes to consume the scripted response.
  setHeartbeatsEnabled(false);
  const provider = buildMockOpenAiResponsesProvider(
    await listenProvider(providerServer),
    "first-turn",
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
      providers: {
        [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
      },
    },
    plugins: { slots: { memory: "none" } },
    tools: { profile: "minimal" },
    gateway: { auth: { mode: "token", token: "first-turn-test" } },
  } satisfies OpenClawConfig;
  gateway = await startGatewayWithClient({
    cfg,
    configPath: state.configPath,
    token: "first-turn-test",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    onEvent: (event) => {
      const payload = event.payload;
      if (!isRecord(payload) || payload.runId !== runId) {
        return;
      }
      if (
        event.event === "session.message" &&
        payload.sessionKey === sessionKey &&
        isRecord(payload.message) &&
        payload.message.role === "assistant"
      ) {
        persistedPartial.resolve();
      }
      if (event.event === "chat" && payload.state === "delta") {
        firstDelta.resolve();
      }
      if (event.event === "chat" && payload.state === "aborted") {
        terminal.resolve();
      }
      if (event.event === "agent" && payload.stream === "lifecycle") {
        lifecycle.push({
          ...(isRecord(payload.data) ? payload.data : {}),
          sessionId: payload.sessionId,
        });
      }
    },
  });
  const runtime = expectDefined(
    observeSubscriptions.mock.calls.at(-1)?.[0],
    "Gateway subscriptions",
  );
  expect(loadExactSessionEntryReadOnly({ sessionKey })?.entry).toBeUndefined();
  await gateway.client.request("sessions.messages.subscribe", { key: sessionKey });
  expect(
    await gateway.client.request("chat.send", {
      sessionKey,
      message: "Start a reply and wait for Stop.",
      idempotencyKey: runId,
    }),
  ).toMatchObject({ runId, status: "started" });
  const response = await providerResponse.promise;
  original = rpcSourceTesting.get(runId);
  const sessionId = expectDefined(
    loadExactSessionEntryReadOnly({ sessionKey })?.entry.sessionId,
    "native session",
  );
  const source = expectDefined(original, "native registration");
  expect(sessionId).not.toBe(runId);
  expect.soft(getRpcSourceIdentity(source).sessionId).toBe(sessionId);
  const requestOwners = activeExecRequestOwners(
    { runId, sessionKey, sessionId, agentId: "main" },
    () => true,
  );
  expect(source.adapter.requester?.connectionId).toEqual(expect.any(String));
  expect(requestOwners).toMatchObject([
    {
      identity: {
        runId,
        sessionId,
        ownerConnId: source.adapter.requester?.connectionId,
      },
    },
  ]);
  expect(activeExecRequestOwners({ runId, sessionId: runId }, () => true)).toEqual([]);
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "first-message",
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.output_text.delta",
      item_id: "first-message",
      output_index: 0,
      content_index: 0,
      delta: partial,
    },
  ]) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  await firstDelta.promise;
  expect(runtime.chatRunState.resolveBuffer(runId).text).toBe(partial);
  expect.soft(getRpcSourceIdentity(source).sessionId).toBe(sessionId);
  expect(lifecycle).toContainEqual(expect.objectContaining({ phase: "start", sessionId }));
  const history = await gateway.client.request<{
    sessionId: string;
    sessionInfo: { activeLeafEntryId: string | null };
  }>("chat.history", { sessionKey });
  expect(history).toMatchObject({
    sessionId,
    sessionInfo: { activeLeafEntryId: expect.any(String) },
  });
  const transcriptScope = { sessionKey, sessionId, agentId: "main" };
  const stopParams = {
    sessionKey,
    message: "/stop",
    sessionId: history.sessionId,
    expectedLeafEntryId: history.sessionInfo.activeLeafEntryId,
  };
  const beforeRejectedStops = await loadTranscriptEvents(transcriptScope);
  for (const guard of [
    {
      idempotencyKey: "stop-stale-first-native-leaf",
      expectedLeafEntryId: "stale-first-native-leaf",
    },
    {
      idempotencyKey: "stop-copied-first-native-leaf",
      sessionId: "previous-first-native-session",
    },
  ]) {
    await expect(
      gateway.client.request("chat.send", { ...stopParams, ...guard }),
    ).rejects.toMatchObject({ details: { reason: "active-leaf-changed" } });
    expect(source.input.abortSignal.aborted).toBe(false);
    expect(rpcSourceTesting.get(runId)).toBe(source);
    expect(runtime.chatRunState.resolveBuffer(runId).text).toBe(partial);
    expect(response.destroyed).toBe(false);
    expect(requestBodies).toHaveLength(1);
    expect(await loadTranscriptEvents(transcriptScope)).toEqual(beforeRejectedStops);
  }
  const stop = await gateway.client
    .request("chat.send", {
      ...stopParams,
      idempotencyKey: "stop-first-native-turn",
    })
    .then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
  expect.soft(stop).toMatchObject({ result: { ok: true, aborted: true, runIds: [runId] } });
  expect(source.input.abortSignal.aborted).toBe(true);
  expect(requestOwners[0]?.signal.aborted).toBe(true);
  await terminal.promise;
  await providerClosed.promise;
  await vi.waitFor(() => expect(rpcSourceTesting.has(runId)).toBe(false));
  expect
    .soft(loadExactSessionEntryReadOnly({ sessionKey })?.entry, JSON.stringify(lifecycle))
    .toMatchObject({
      sessionId,
      status: "killed",
      abortedLastRun: true,
    });
  await vi.waitFor(() =>
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        phase: "end",
        status: "cancelled",
        aborted: true,
        stopReason: "stop",
        sessionId,
      }),
    ),
  );
  await persistedPartial.promise;
  const events = await loadTranscriptEvents(transcriptScope);
  expect(events).toContainEqual(
    expect.objectContaining({
      message: expect.objectContaining({
        content: [{ type: "text", text: partial }],
        openclawAbort: { aborted: true, origin: "stop-command", runId },
      }),
    }),
  );
  expect(requestBodies).toHaveLength(1);
});
