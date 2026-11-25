import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  assertStableProviderPrefix,
  snapshotProviderPrefix,
} from "../../scripts/e2e/lib/anthropic-cache/prefix-stability.mts";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { onAgentAuditEvent, onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { createChatFixture, sendChatAndWait } from "./gateway-chat-fixture.test-support.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";

const childResponse = createDeferred();
const spawnPrompt = "Start the cache-prefix child.";
const childTask = "Return the child cache-prefix result.";
const childReply = "Child verification completed.";
let spawnRequested = false;
const fixture = createChatFixture("prompt-cache", {
  async respond(body, sessionId, response) {
    if (!spawnRequested && body.includes(spawnPrompt)) {
      spawnRequested = true;
      writeToolCall(
        response,
        "sessions_spawn",
        {
          task: childTask,
          agentId: "main",
          context: "isolated",
          completionTarget: "parent",
        },
        1,
        1,
      );
      return undefined;
    }
    const isChild = body.includes(childTask) && sessionId !== fixture.sessionIds[0];
    if (isChild) {
      await childResponse.promise;
    }
    return isChild ? childReply : "Fixture reply complete.";
  },
  configure(config, model) {
    const modelRef = `openai/${model.modelId}`;
    model.config.models[0].compat = {
      supportsPromptCacheKey: true,
      supportsStore: false,
      sendSessionIdHeader: true,
    };
    return {
      ...config,
      agents: {
        defaults: {
          ...config.agents?.defaults,
          utilityModel: "",
          model: { primary: modelRef },
          models: { [modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } },
        },
      },
      models: { mode: "replace", providers: { openai: model.config } },
      tools: { allow: ["sessions_spawn"], toolSearch: false },
      plugins: {
        allow: ["openai"],
        load: { paths: [path.resolve("extensions/openai")] },
        slots: { memory: "none" },
      },
    };
  },
});
const { requests, sessionIds: requestSessionIds, errors: providerErrors } = fixture;
beforeAll(() => fixture.start(), 90_000);
afterAll(() => fixture.close());

async function waitForRun(runId: string | undefined, timeoutMs = 30_000) {
  const result = await fixture.client.request<{ status: string }>(
    "agent.wait",
    { runId, timeoutMs },
    { timeoutMs: timeoutMs + 5_000 },
  );
  expect(result.status).toBe("ok");
}

it("keeps cache identity through operator, WebChat, completion and restart turns", async ({
  signal,
}) => {
  const sessionKey = `agent:main:cache-prefix-${randomUUID()}`;
  const requestStart = requests.length;
  const initialized = await fixture.client.request<{ runId: string; status: string }>("agent", {
    sessionKey,
    message: "Remember this conversation.",
    deliver: false,
    idempotencyKey: randomUUID(),
  });
  expect(initialized.status).toBe("accepted");
  await waitForRun(initialized.runId, 60_000);
  const initializedRunId = await sendChatAndWait(
    fixture.client,
    sessionKey,
    "Continue in WebChat.",
    60_000,
  );
  const completion = createDeferred();
  const terminalRuns = new Set<string>();
  const observeCompletion = (event: AgentEventPayload) => {
    if (
      event.sessionKey === sessionKey &&
      event.runId !== initializedRunId &&
      event.stream === "lifecycle" &&
      (event.data.phase === "end" || event.data.phase === "error")
    ) {
      terminalRuns.add(event.runId);
      if (terminalRuns.size === 2) {
        completion.resolve();
      }
    }
  };
  const stopObserving = onAgentEvent(observeCompletion);
  const stopObservingPrivate = onAgentAuditEvent(observeCompletion);
  try {
    const parentRunId = await sendChatAndWait(fixture.client, sessionKey, spawnPrompt);
    const outputs = requests.slice(requestStart).flatMap((body) => {
      const payload = JSON.parse(body) as {
        input: Array<{ type?: string; output?: string }>;
      };
      return payload.input.filter((item) => item.type === "function_call_output");
    });
    const spawnResult = JSON.parse(outputs[0]?.output ?? "null") as {
      status?: string;
      runId?: string;
    } | null;
    expect(spawnResult?.status).toBe("accepted");
    // Complete the child after the parent turn so its result takes the separate announce path.
    childResponse.resolve();
    expect(spawnResult?.runId).toBeTruthy();
    await waitForRun(spawnResult!.runId);
    await withinTest(completion.promise, signal);
    const completionRunId = [...terminalRuns].find((runId) => runId !== parentRunId);
    expect(completionRunId).toBeTruthy();
    // Lifecycle end precedes durable input completion and RPC settlement.
    await waitForRun(completionRunId);
  } finally {
    childResponse.resolve();
    stopObserving();
    stopObservingPrivate();
  }
  await fixture.restart();
  await sendChatAndWait(fixture.client, sessionKey, "Continue after completion.");
  expect(providerErrors.length).toBe(0);
  expect(
    requests.slice(requestStart).some((body) => {
      const payload = JSON.parse(body) as { previous_response_id?: unknown };
      return payload.previous_response_id !== undefined;
    }),
    "the capturing provider receives full history without stored-response continuation",
  ).toBe(false);
  const parentSessionId = requestSessionIds[requestStart];
  expect(parentSessionId).toBeTruthy();
  // Physical identity selects the parent independently of the cache key and history under test.
  const turnRequests = requests
    .slice(requestStart)
    .filter((_body, index) => requestSessionIds[requestStart + index] === parentSessionId);
  expect(turnRequests).toHaveLength(6);
  const prefixes = turnRequests.map((body) => {
    const payload = JSON.parse(body) as { prompt_cache_key?: unknown };
    expect(payload.prompt_cache_key).toBe(`${parentSessionId}:0`);
    return snapshotProviderPrefix("openai-responses", payload);
  });
  expect(prefixes[4]!.history.join("\n")).toContain(childReply);
  // Preserve prefix coverage from WebChat initialization; the preceding operator
  // turn also checks cache identity without coupling this test to ingress envelopes.
  for (let index = 2; index < prefixes.length; index += 1) {
    assertStableProviderPrefix(prefixes[index - 1]!, prefixes[index]!, {
      label: `Gateway chat/completion turn ${index + 1}`,
    });
  }
}, 120_000);
