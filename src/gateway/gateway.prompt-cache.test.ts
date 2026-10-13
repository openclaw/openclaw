import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertStableProviderPrefix,
  snapshotProviderPrefix,
} from "../../scripts/e2e/lib/anthropic-cache/prefix-stability.mts";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentAuditEvent, onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

describe("Gateway prompt-cache stability", () => {
  const requests: string[] = [];
  const requestSessionIds: Array<string | undefined> = [];
  const providerErrors: unknown[] = [];
  const childResponse = createDeferred();
  let spawnRequested = false;
  const provider = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push(body);
      const sessionHeader = request.headers.session_id;
      const sessionId = typeof sessionHeader === "string" ? sessionHeader : undefined;
      requestSessionIds.push(sessionId);
      if (!spawnRequested && body.includes("Start the synthetic cache-prefix child.")) {
        spawnRequested = true;
        const item = {
          type: "function_call",
          id: `fc_${randomUUID()}`,
          call_id: `call_${randomUUID()}`,
          name: "sessions_spawn",
          arguments: JSON.stringify({
            task: "Return the synthetic child cache-prefix result.",
            agentId: "main",
            context: "isolated",
            completionTarget: "parent",
          }),
          status: "completed",
        };
        writeOpenAiResponsesSse(response, [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", arguments: "" },
          },
          {
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: 0,
            arguments: item.arguments,
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: `resp_${randomUUID()}`,
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]);
        return;
      }
      const isChildRequest =
        body.includes("Return the synthetic child cache-prefix result.") &&
        sessionId !== requestSessionIds[0];
      if (isChildRequest) {
        await childResponse.promise;
      }
      writeOpenAiResponsesText(response, {
        text: isChildRequest
          ? "Synthetic child verification completed."
          : "Fixture reply complete.",
        messageId: `msg_${randomUUID()}`,
        responseId: `resp_${randomUUID()}`,
      });
    })().catch((error: unknown) => {
      providerErrors.push(error);
      response.writeHead(500).end("fixture provider failed");
    });
  });
  let home: Awaited<ReturnType<typeof setupGatewayTempHome>>;
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>>;
  let startGatewayFixture: () => Promise<void>;

  beforeAll(async () => {
    resetGatewayTestState();
    home = await setupGatewayTempHome({ prefix: "openclaw-prompt-cache-" });
    await new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture provider did not bind");
    }
    const model = buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${address.port}/v1`,
      "prompt-cache-fixture",
    );
    const providerId = "openai";
    const modelRef = `${providerId}/${model.modelId}`;
    const token = randomUUID();
    setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
    const cfg = {
      agents: {
        defaults: {
          workspace: home.workspaceDir,
          skipBootstrap: true,
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
      gateway: { auth: { mode: "token", token } },
      tools: { allow: ["sessions_spawn"], toolSearch: false },
      plugins: {
        allow: [providerId],
        load: { paths: [path.resolve("extensions/openai")] },
        slots: { memory: "none" },
      },
      hooks: { enabled: false },
    } satisfies OpenClawConfig;
    const configPath = await createGatewayConfigPath(home.tempHome);
    startGatewayFixture = async () => {
      const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      gateway = await startGatewayWithClient({
        cfg,
        portClaim,
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        origin: `http://127.0.0.1:${portClaim.port}`,
        configPath,
        token,
        clientDisplayName: "prompt-cache-test",
      });
      await gateway.server.startupSettled;
    };
    await startGatewayFixture();
  }, 90_000);

  afterAll(async () => {
    try {
      if (gateway) {
        try {
          await disconnectGatewayClient(gateway.client);
        } finally {
          await gateway.server.close({ reason: "prompt cache test complete" });
        }
      }
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => {
        provider.close(() => resolve());
      });
      resetGatewayTestState();
      if (home) {
        await removeGatewayTempHome(home.tempHome);
        home.envSnapshot.restore();
      }
    }
  });

  async function send(sessionKey: string, message: string, timeoutMs = 30_000): Promise<string> {
    const accepted = await gateway.client.request<{ runId: string; status: string }>("chat.send", {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    expect(accepted.status).toBe("started");
    const completed = await gateway.client.request<{ status: string }>(
      "agent.wait",
      { runId: accepted.runId, timeoutMs },
      { timeoutMs: timeoutMs + 5_000 },
    );
    expect(completed.status).toBe("ok");
    return accepted.runId;
  }

  it("preserves the provider prefix across chat.send, completion and Gateway restart", async ({
    signal,
  }) => {
    const sessionKey = `agent:main:cache-prefix-${randomUUID()}`;
    const requestStart = requests.length;
    // The real first send establishes the conversation metadata used by command continuations.
    const initializedRunId = await send(
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
      await send(sessionKey, "Start the synthetic cache-prefix child.");
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
      const child = await gateway.client.request<{ status: string }>(
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
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "prompt-prefix restart proof" });
    await startGatewayFixture();
    await send(sessionKey, "Continue the same synthetic conversation after the child completion.");
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
    const requestShapes = requests.slice(requestStart).map((body, index) => {
      const payload = JSON.parse(body) as {
        input: Array<{ role?: string; type?: string }>;
      };
      return {
        parent: requestSessionIds[requestStart + index] === parentSessionId,
        input: payload.input.map(({ role, type }) => ({ role, type })),
      };
    });
    expect(
      turnRequests.length,
      `parent requests include the tool loop and completion: ${JSON.stringify(requestShapes)}`,
    ).toBe(5);
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
});
