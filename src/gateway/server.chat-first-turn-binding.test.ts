import { createServer, type ServerResponse } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { activeExecRequestOwners } from "../infra/exec-request-context.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import { createProductState, productModelConfig } from "./server.chat-product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it("binds native chat.send, preserves its stopped partial, and resumes the same session", async () => {
  const state = await createProductState("first-turn-binding");
  const runId = "first-native-turn";
  const sessionKey = "agent:main:first-turn-binding";
  const partial = "This is the first native assistant partial.";
  const providerResponse = createDeferred<ServerResponse>();
  const providerClosed = createDeferred();
  const firstDelta = createDeferred();
  const terminal = createDeferred();
  const persistedPartial = createDeferred();
  const requestBodies: string[] = [];
  const providerServer = createServer((request, response) => {
    void (async () => {
      requestBodies.push(await readRequestText(request));
      if (requestBodies.length > 1) {
        writeOpenAiResponsesText(response, {
          text: "The same conversation resumed.",
          messageId: `resumed-message-${requestBodies.length}`,
          responseId: `resumed-response-${requestBodies.length}`,
        });
        return;
      }
      response.once("close", () => providerClosed.resolve());
      providerResponse.resolve(response);
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined = undefined;
  const lifecycle: Array<{ phase?: unknown; sessionId?: unknown; aborted?: unknown }> = [];
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => state.cleanup());
  cleanup.defer(async () => {
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "first-turn binding test cleanup" });
    }
  });
  cleanup.defer(() => closeProvider(providerServer));
  const provider = buildMockOpenAiResponsesProvider(
    await listenProvider(providerServer),
    "first-turn",
  );
  const modelConfig = productModelConfig(state.workspaceDir, provider);
  const cfg = {
    cron: { enabled: false },
    agents: { defaults: modelConfig.defaults },
    models: modelConfig.models,
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
  const historyForSession = () =>
    gateway!.client.request<{
      sessionId: string;
      sessionInfo: { activeLeafEntryId: string | null };
    }>("chat.history", { sessionKey });
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
  const sessionId = expectDefined(
    loadExactSessionEntryReadOnly({ sessionKey })?.entry.sessionId,
    "native session",
  );
  expect(sessionId).not.toBe(runId);
  const requestOwners = activeExecRequestOwners(
    { runId, sessionKey, sessionId, agentId: "main" },
    () => true,
  );
  expect(requestOwners).toMatchObject([
    {
      identity: {
        runId,
        sessionId,
        ownerConnId: expect.any(String),
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
  expect(lifecycle).toContainEqual(expect.objectContaining({ phase: "start", sessionId }));
  const history = await historyForSession();
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
    expect(requestOwners[0]?.signal.aborted).toBe(false);
    expect(response.destroyed).toBe(false);
    expect(requestBodies).toHaveLength(1);
    expect(await loadTranscriptEvents(transcriptScope)).toEqual(beforeRejectedStops);
  }
  await expect(
    gateway.client.request("chat.send", {
      ...stopParams,
      idempotencyKey: "stop-first-native-turn",
    }),
  ).resolves.toMatchObject({ ok: true, aborted: true, runIds: [runId] });
  expect(requestOwners[0]?.signal.aborted).toBe(true);
  await terminal.promise;
  await providerClosed.promise;
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
  const currentHistory = await historyForSession();
  expect(currentHistory.sessionId).toBe(sessionId);
  const nextRunId = "resume-after-stop";
  expect(
    await gateway.client.request("chat.send", {
      sessionKey,
      sessionId,
      expectedLeafEntryId: currentHistory.sessionInfo.activeLeafEntryId,
      message: "Continue this conversation.",
      idempotencyKey: nextRunId,
    }),
  ).toMatchObject({ runId: nextRunId, status: "started" });
  expect(await gateway.client.request("agent.wait", { runId: nextRunId })).toMatchObject({
    status: "ok",
  });
  expect(requestBodies).toHaveLength(2);
  expect(await loadTranscriptEvents(transcriptScope)).toEqual(expect.arrayContaining(events));
  expect(loadExactSessionEntryReadOnly({ sessionKey })?.entry).toMatchObject({ sessionId });
});
