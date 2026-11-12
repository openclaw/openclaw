import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test } from "vitest";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { withinTest } from "../../test/helpers/promise.js";
import { withFullRuntimeReplyConfig } from "../auto-reply/reply/get-reply-fast-path.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import { peekSystemEventEntries } from "../infra/system-events.js";
import { removeSessionTestDirectories } from "./session-test-directories.test-support.js";
import { gatewayReplyMock, testState } from "./test-helpers.runtime-state.js";
import {
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  writeSessionStore,
} from "./test-helpers.server.js";

// Socket delivery and reconnect history are owned by session-message-events.test.ts.
installGatewayTestHooks({ scope: "suite" });

test("commits an exec completion once without a connected WebChat reader", async ({ signal }) => {
  await using cleanup = new AsyncDisposableStack();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-message-"));
  cleanup.defer(() => removeSessionTestDirectories([dir]));
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  const sessionId = "exec-completion";
  const sessionKey = "agent:main:dashboard:exec-completion";
  const marker = "EXEC_NOTIFICATION";
  const providerRequests: string[] = [];
  // Keep embedded execution and transcript ownership; only the HTTP response is synthetic.
  const provider = await startOpenAiResponsesModelServer({
    modelId: "exec-completion",
    bindError: "Expected exec completion fixture provider address",
    onRequest: async (request, response) => {
      providerRequests.push(await text(request));
      writeOpenAiResponsesText(response, {
        text: marker,
        messageId: `msg_exec_${providerRequests.length}`,
        responseId: `resp_exec_${providerRequests.length}`,
      });
    },
  });
  cleanup.defer(() => provider.close());
  const harness = await createGatewaySuiteHarness();
  cleanup.defer(() => harness.close());
  await writeSessionStore({
    entries: {
      [sessionKey]: {
        sessionId,
        lifecycleRevision: "exec-completion-generation",
        updatedAt: Date.now(),
        createdVia: "operator",
        delivery: { kind: "internal" },
      },
    },
    storePath,
  });
  const cfg = createOpenAiResponsesModelConfig({
    baseUrl: provider.baseUrl,
    providerId: "exec-proof",
    modelId: "exec-completion",
    reasoning: false,
    toolProfile: "full",
  });
  cfg.agents = {
    ...cfg.agents,
    entries: { main: {} },
    defaults: { ...cfg.agents?.defaults, workspace: dir },
  };
  cfg.messages = { visibleReplies: "message_tool" };
  cfg.session = { store: storePath };
  await prepareGatewayReplyRuntimeForTest({ force: true, config: cfg });
  cleanup.defer(() => {
    gatewayReplyMock.mockReset();
  });
  gatewayReplyMock.mockImplementation((ctx, options, config) =>
    getReplyFromConfig(ctx, options, withFullRuntimeReplyConfig(config ?? cfg)),
  );
  const expectedTarget = await captureSessionEventTargetForHost("main", sessionKey);
  const receipt = enqueueSessionEventForHost(
    `Exec completed (webchat-proof, code 0) :: ${marker}`,
    {
      agentId: "main",
      sessionKey,
      source: "exec",
      expectedTarget,
      abortSignal: signal,
    },
  );
  cleanup.defer(async () => {
    receipt.cancel();
    await Promise.allSettled([receipt.settled]);
  });
  await expect(receipt.accepted).resolves.toEqual({ ok: true });
  expect(await withinTest(receipt.settled, signal)).toMatchObject({
    status: "completed",
    executionStarted: true,
  });
  expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  expect(providerRequests.filter((request) => request.includes(marker))).toHaveLength(1);
  const completions = loadTranscriptEventsSync({
    agentId: "main",
    sessionId,
    sessionKey,
    storePath,
  }).filter(
    (event) =>
      isRecord(event) &&
      isRecord(event.message) &&
      event.message.role === "assistant" &&
      JSON.stringify(event.message).includes(marker),
  );
  expect(completions).toHaveLength(1);
  expect(completions[0]).toMatchObject({
    message: {
      role: "assistant",
      content: [{ type: "text", text: marker }],
    },
  });
});
