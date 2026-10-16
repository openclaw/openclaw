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

it("preserves the provider prefix across chat.send, completion and Gateway restart", async ({
  signal,
}) => {
  const sessionKey = `agent:main:cache-prefix-${randomUUID()}`;
  const requestStart = requests.length;
  // The real first send establishes the conversation metadata used by command continuations.
  const initializedRunId = await sendChatAndWait(
    fixture.client,
    sessionKey,
    "Remember this synthetic conversation for the completion update.",
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
    await sendChatAndWait(fixture.client, sessionKey, "Start the synthetic cache-prefix child.");
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
  expect(turnRequests, "parent requests include the tool loop and completion").toHaveLength(5);
  const prefixes = turnRequests.map((body) => {
    const payload = JSON.parse(body) as { prompt_cache_key?: unknown };
    expect(
      typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.length > 0,
      "the provider receives a nonempty session cache key",
    ).toBe(true);
    return snapshotProviderPrefix("openai-responses", payload);
  });
  expect(
    prefixes[3]!.history.join("\n").includes("Synthetic child verification completed."),
    "the internal completion reached the provider",
  ).toBe(true);
  for (let index = 1; index < prefixes.length; index += 1) {
    assertStableProviderPrefix(prefixes[index - 1]!, prefixes[index]!, {
      label: `Gateway chat/completion turn ${index + 1}`,
    });
  }
}, 120_000);
