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
let spawnRequested = false;
const fixture = createChatFixture("prompt-cache", {
  async respond(body, sessionId, response) {
    if (!spawnRequested && body.includes("Start the synthetic cache-prefix child.")) {
      spawnRequested = true;
      writeToolCall(
        response,
        "sessions_spawn",
        {
          task: "Return the synthetic child cache-prefix result.",
          agentId: "main",
          context: "isolated",
          completionTarget: "parent",
        },
        1,
        1,
      );
      return undefined;
    }
    const isChild =
      body.includes("Return the synthetic child cache-prefix result.") &&
      sessionId !== fixture.sessionIds[0];
    if (isChild) {
      await childResponse.promise;
    }
    return isChild ? "Synthetic child verification completed." : "Fixture reply complete.";
  },
  configure(config, model) {
    const providerId = "openai";
    const modelRef = `${providerId}/${model.modelId}`;
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
      models: {
        mode: "replace",
        providers: {
          [providerId]: {
            ...model.config,
            models: [
              {
                ...model.config.models[0],
                compat: {
                  supportsPromptCacheKey: true,
                  supportsStore: false,
                  sendSessionIdHeader: true,
                },
              },
            ],
          },
        },
      },
      tools: { allow: ["sessions_spawn"], toolSearch: false },
      plugins: {
        allow: [providerId],
        load: { paths: [path.resolve("extensions/openai")] },
        slots: { memory: "none" },
      },
    };
  },
});
const { requests, sessionIds: requestSessionIds, errors: providerErrors } = fixture;
beforeAll(() => fixture.start(), 90_000);
afterAll(() => fixture.close());

it("keeps operator cache identity through WebChat, completion and restart turns", async ({
  signal,
}) => {
  const sessionKey = `agent:main:cache-prefix-${randomUUID()}`;
  const requestStart = requests.length;
  // CLI/operator ingress must share cache identity with later WebChat and internal turns.
  const initialized = await fixture.client.request<{ runId: string; status: string }>("agent", {
    sessionKey,
    message: "Remember this synthetic conversation for the completion update.",
    deliver: false,
    idempotencyKey: randomUUID(),
  });
  expect(initialized.status).toBe("accepted");
  const initializedResult = await fixture.client.request<{ status: string }>(
    "agent.wait",
    { runId: initialized.runId, timeoutMs: 60_000 },
    { timeoutMs: 65_000 },
  );
  expect(initializedResult.status).toBe("ok");
  const initializedRunId = await sendChatAndWait(
    fixture.client,
    sessionKey,
    "Continue this synthetic conversation in WebChat.",
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
    // The real spawn owns child lineage and the completion's one-use tool grant.
    const parentRunId = await sendChatAndWait(
      fixture.client,
      sessionKey,
      "Start the synthetic cache-prefix child.",
    );
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
    expect(spawnResult?.status, "sessions_spawn admits the child through its real tool").toBe(
      "accepted",
    );
    // Complete the child after the parent turn so its result takes the separate announce path.
    childResponse.resolve();
    expect(spawnResult?.runId, "sessions_spawn returns its admitted child run").toBeTruthy();
    const child = await fixture.client.request<{ status: string }>(
      "agent.wait",
      { runId: spawnResult!.runId, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    );
    expect(child.status, "the child completes before its private parent announcement").toBe("ok");
    await withinTest(completion.promise, signal);
    const completionRunId = [...terminalRuns].find((runId) => runId !== parentRunId);
    expect(completionRunId, "the private parent announcement has its own run").toBeTruthy();
    // Lifecycle end precedes durable input completion and RPC settlement.
    const settled = await fixture.client.request<{ status: string }>(
      "agent.wait",
      { runId: completionRunId!, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    );
    expect(settled.status, "the private parent announcement settles before restart").toBe("ok");
  } finally {
    childResponse.resolve();
    stopObserving();
    stopObservingPrivate();
  }
  // Reopen the same persisted conversation through a fresh Gateway and authenticated client.
  await fixture.restart();
  await sendChatAndWait(
    fixture.client,
    sessionKey,
    "Continue the same synthetic conversation after the child completion.",
  );
  expect(providerErrors.length).toBe(0);
  expect(
    requests.slice(requestStart).some((body) => {
      const payload = JSON.parse(body) as { previous_response_id?: unknown };
      return payload.previous_response_id !== undefined;
    }),
    "the capturing provider receives full history without stored-response continuation",
  ).toBe(false);
  const parentSessionId = requestSessionIds[requestStart];
  expect(parentSessionId, "the provider receives the physical session identity").toBeTruthy();
  // Physical identity selects the parent independently of the cache key and history under test.
  const turnRequests = requests
    .slice(requestStart)
    .filter((_body, index) => requestSessionIds[requestStart + index] === parentSessionId);
  expect(turnRequests, "parent requests include operator, tool loop and completion").toHaveLength(
    6,
  );
  const prefixes = turnRequests.map((body) => {
    const payload = JSON.parse(body) as { prompt_cache_key?: unknown };
    expect(payload.prompt_cache_key, "every ingress uses the session's boundary cache key").toBe(
      `${parentSessionId}:0`,
    );
    return snapshotProviderPrefix("openai-responses", payload);
  });
  expect(
    prefixes[4]!.history.join("\n").includes("Synthetic child verification completed."),
    "the internal completion reached the provider",
  ).toBe(true);
  // Preserve prefix coverage from WebChat initialization; the preceding operator
  // turn also checks cache identity without coupling this test to ingress envelopes.
  for (let index = 2; index < prefixes.length; index += 1) {
    assertStableProviderPrefix(prefixes[index - 1]!, prefixes[index]!, {
      label: `Gateway chat/completion turn ${index + 1}`,
    });
  }
}, 120_000);
